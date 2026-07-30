/**
 * Host-facing orchestration for steward-driven PR squash merge. Mirrors the
 * deploy path: a plugin-owned internal API entrypoint (the steward webhook),
 * fail-closed revalidation of the exact PR revision, a Human Operator approval
 * distinct from deployment, and an auditable retryable merge outbox.
 *
 * Outbound squash merge is an approval-gated action. Like the deploy dispatch
 * it therefore proceeds in shadow mode; only unprompted outbound mutations are
 * blocked by shadow mode.
 */
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { GitHubBridgeConfig, GitHubRepositoryRoute, MergeApprovalsConfig, GitHubAppMergeAuth } from "./config.js";
import { requireBridgeConfig } from "./config.js";
import { routeForRepository } from "./deploy-approvals.js";
import { DEPLOY_APPROVAL_TYPE } from "./deploy-checks.js";
import { GITHUB_API_USER_AGENT, mintGitHubAppInstallationToken } from "./github-app-auth.js";
import { verifyHmacSignature } from "./signature.js";
import type { PluginEntityRecord } from "@paperclipai/plugin-sdk";
import {
  MERGE_APPROVAL_KIND,
  MERGE_REQUEST_ENTITY,
  MERGE_OUTBOX_ENTITY,
  parsePullRequest,
  parseCommitChecks,
  evaluateMergeGate,
  buildMergeApprovalPayload,
  buildSquashMergeBody,
  mergeRequestExternalId,
  mergeOutboxExternalId,
  shouldAttemptMerge,
  applyMergeAttemptOutcome,
  selectSupersededMergeRequests,
  type PullRequestState,
} from "./merge-checks.js";
import type { CommitCheck } from "./push-delivery.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function webhookHeader(input: PluginWebhookInput, name: string): string | undefined {
  const found = Object.entries(input.headers).find(([key]) => key.toLowerCase() === name);
  const value = found?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function splitRepo(repository: string): [string, string] {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository.trim());
  if (!match) throw new Error(`repository must use owner/name format: ${repository}`);
  return [encodeURIComponent(match[1]!), encodeURIComponent(match[2]!)];
}

function githubAuthHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": GITHUB_API_USER_AGENT,
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function mintMergeToken(ctx: PluginContext, githubApp: GitHubAppMergeAuth): Promise<string> {
  return mintGitHubAppInstallationToken({
    http: ctx.http,
    appId: await ctx.secrets.resolve(githubApp.appIdRef),
    privateKey: await ctx.secrets.resolve(githubApp.privateKeyRef),
    repository: githubApp.installationRepository,
  });
}

async function fetchPullRequestState(
  ctx: PluginContext,
  token: string,
  repository: string,
  prNumber: number,
): Promise<PullRequestState> {
  const [owner, repo] = splitRepo(repository);
  const res = await ctx.http.fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    method: "GET",
    headers: githubAuthHeaders(token),
  });
  if (res.status === 404) throw new Error(`pull request ${repository}#${prNumber} not found`);
  if (res.status < 200 || res.status >= 300) throw new Error(`GitHub pull request lookup failed: HTTP ${res.status}`);
  const pr = parsePullRequest(repository, await readJson(res));
  if (!pr) throw new Error(`GitHub pull request response was incomplete for ${repository}#${prNumber}`);
  return pr;
}

async function fetchShaChecks(
  ctx: PluginContext,
  token: string,
  repository: string,
  sha: string,
): Promise<CommitCheck[]> {
  const [owner, repo] = splitRepo(repository);
  const res = await ctx.http.fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
    { method: "GET", headers: githubAuthHeaders(token) },
  );
  if (res.status < 200 || res.status >= 300) throw new Error(`GitHub check-runs lookup failed: HTTP ${res.status}`);
  return parseCommitChecks(repository, sha, await readJson(res));
}

interface MergeOutcome {
  ok: boolean;
  terminal?: boolean;
  error?: string;
}

async function performSquashMerge(
  ctx: PluginContext,
  token: string,
  repository: string,
  prNumber: number,
  headSha: string,
  approvalId: string,
  issueId: string,
): Promise<MergeOutcome> {
  const [owner, repo] = splitRepo(repository);
  const res = await ctx.http.fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: "PUT",
    headers: githubAuthHeaders(token),
    body: JSON.stringify(buildSquashMergeBody(headSha, approvalId, issueId)),
  });
  const body = asRecord(await readJson(res));
  if (res.status >= 200 && res.status < 300) {
    // A successful GitHub merge response carries merged:true. A 2xx that does
    // not confirm merged:true is a terminal failure: never assume success.
    if (body.merged === true) return { ok: true };
    const detail = asString(body.message);
    return {
      ok: false,
      terminal: true,
      error: `merge response did not confirm success (HTTP ${res.status}, merged=${String(body.merged)}${detail ? `, message=${detail}` : ""})`,
    };
  }
  const detail = asString(body.message);
  // 409 "already merged" is a successful idempotent outcome.
  if (res.status === 409 && /merged/i.test(detail)) return { ok: true };
  // 409 head moved / not mergeable, 403 forbidden, 422 unprocessable: terminal.
  if (res.status === 403 || res.status === 409 || res.status === 422) {
    return { ok: false, terminal: true, error: `merge rejected (HTTP ${res.status}): ${detail || "no detail"}` };
  }
  return { ok: false, error: `merge failed: HTTP ${res.status}` };
}

// ---------------------------------------------------------------------------
// Steward API entrypoint (plugin-owned, HMAC-authenticated webhook)
// ---------------------------------------------------------------------------

export interface StewardMergeRequest {
  repository: string;
  prNumber: number;
  headSha: string;
  issueId: string;
  reviewEvidence: unknown;
}

export function parseStewardMergeRequest(value: unknown): StewardMergeRequest | null {
  const raw = asRecord(value);
  const repository = asString(raw.repository ?? raw.repo).toLowerCase();
  const prNumber = asNumber(raw.prNumber ?? raw.pullRequestNumber ?? raw.pr);
  const headSha = asString(raw.headSha ?? raw.sha ?? raw.head).toLowerCase();
  const issueId = asString(raw.issueId ?? raw.linkedIssueId);
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository) || !prNumber || !/^[0-9a-f]{40}$/.test(headSha) || !issueId) return null;
  return { repository, prNumber, headSha, issueId, reviewEvidence: raw.reviewEvidence ?? raw.evidence ?? null };
}

/**
 * Handle a steward PASS delivery on the `steward-merge-request` endpoint.
 * Authenticates the request with the configured shared secret (constant-time
 * HMAC), then revalidates the exact PR revision and creates a Human Operator
 * merge approval. No unauthenticated public mutation is exposed.
 */
export async function processStewardMergeRequest(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  if (input.endpointKey !== "steward-merge-request") {
    throw new Error(`Unsupported webhook endpoint: ${input.endpointKey}`);
  }
  const config = requireBridgeConfig(await ctx.config.get());
  if (!config.stewardApiSecretRef) throw new Error("steward merge API is not configured (stewardApiSecretRef missing)");
  const secret = await ctx.secrets.resolve(config.stewardApiSecretRef);
  if (!verifyHmacSignature(input.rawBody, webhookHeader(input, "x-pc-signature-256"), secret)) {
    throw new Error("Invalid steward merge-request signature");
  }
  const request = parseStewardMergeRequest(input.parsedBody ?? JSON.parse(input.rawBody));
  if (!request) throw new Error("steward merge-request body is incomplete");
  await requestMergeApproval(ctx, config, request);
}

/**
 * Revalidate the exact PR revision (fail-closed) and create one Human Operator
 * merge approval. Idempotent: a repeated steward request for the same PR+SHA is
 * a no-op; an older request for the same PR is superseded by the live head.
 */
export async function requestMergeApproval(
  ctx: PluginContext,
  config: GitHubBridgeConfig,
  request: StewardMergeRequest,
): Promise<void> {
  const route = routeForRepository(config, request.repository);
  const merge = route?.mergeApprovals;
  if (!route || !merge) {
    throw new Error(`mergeApprovals is not configured for repository: ${request.repository}`);
  }

  const exactKey = mergeRequestExternalId(request.repository, request.prNumber, request.headSha);
  const [existing] = await ctx.entities.list({ entityType: MERGE_REQUEST_ENTITY, externalId: exactKey, limit: 1 });
  if (existing && !existing.data?.superseded) {
    // Idempotent re-delivery of the same steward PASS.
    return;
  }

  const token = await mintMergeToken(ctx, merge.githubApp);
  const pr = await fetchPullRequestState(ctx, token, request.repository, request.prNumber);
  const observed = await fetchShaChecks(ctx, token, request.repository, request.headSha);
  const gate = evaluateMergeGate({ pr, config: merge, requiredHeadSha: request.headSha, observed });
  if (!gate.allowed) {
    throw new Error(
      `merge gate failed for ${request.repository}#${request.prNumber}@${request.headSha.slice(0, 12)}: ${gate.reasons.join("; ")}`,
    );
  }

  // Supersede any stored request for this PR pinned to a different (now stale) head.
  const allRequests = await ctx.entities.list({ entityType: MERGE_REQUEST_ENTITY, limit: 500 });
  for (const id of selectSupersededMergeRequests(request.repository, request.prNumber, request.headSha, allRequests)) {
    const [stale] = await ctx.entities.list({ entityType: MERGE_REQUEST_ENTITY, externalId: id, limit: 1 });
    if (stale && !stale.data?.superseded) {
      await ctx.entities.upsert({
        entityType: MERGE_REQUEST_ENTITY,
        scopeKind: "instance",
        externalId: id,
        status: "superseded",
        data: { ...stale.data ?? {}, superseded: true, supersededBy: request.headSha },
      });
    }
  }

  const payload = buildMergeApprovalPayload({
    pr,
    config: merge,
    issueId: request.issueId,
    reviewEvidence: request.reviewEvidence,
    gate,
  });
  const approval = await ctx.approvals.create({
    companyId: route.companyId,
    type: DEPLOY_APPROVAL_TYPE,
    payload,
    title: merge.approvalTitle,
    summary: `Steward PASS for PR #${pr.prNumber} @${pr.headSha.slice(0, 12)}. All required checks passed.`,
  });
  await ctx.entities.upsert({
    entityType: MERGE_REQUEST_ENTITY,
    scopeKind: "instance",
    externalId: exactKey,
    title: `${request.repository}#${request.prNumber} @${request.headSha.slice(0, 12)}`,
    status: "approval-created",
    data: {
      kind: MERGE_APPROVAL_KIND,
      repository: request.repository,
      prNumber: request.prNumber,
      headSha: request.headSha,
      baseRef: pr.baseRef,
      issueId: request.issueId,
      companyId: route.companyId,
      approvalId: approval.id,
      reviewEvidence: request.reviewEvidence,
      superseded: false,
      requestedAt: new Date().toISOString(),
    },
  });
  await ctx.activity.log({
    companyId: route.companyId,
    message: `Created merge approval ${approval.id} for ${request.repository}#${request.prNumber}@${request.headSha.slice(0, 12)}`,
    entityType: "approval",
    entityId: approval.id,
    metadata: {
      repository: request.repository,
      prNumber: request.prNumber,
      headSha: request.headSha,
      issueId: request.issueId,
    },
  });
}

export async function findMergeRequestByApprovalId(
  ctx: PluginContext,
  approvalId: string,
): Promise<PluginEntityRecord | null> {
  const all = await ctx.entities.list({ entityType: MERGE_REQUEST_ENTITY, limit: 500 });
  return all.find((entity) => entity.data?.approvalId === approvalId) ?? null;
}

/**
 * Handle an approved merge approval. Revalidate the exact head and gates, then
 * enqueue one idempotent merge outbox record. Reject / superseded / changed
 * head never enqueue.
 */
export async function handleMergeApprovalDecided(
  ctx: PluginContext,
  config: GitHubBridgeConfig,
  event: { approvalId: string; decision: string; status: string; type: string; sourcePluginId: string | null },
  mergeRequest: PluginEntityRecord,
): Promise<void> {
  const { decideResolutionAction, SELF_PLUGIN_ID } = await import("./resolution-handler.js");
  const decision = decideResolutionAction({ ...event, sourcePluginId: SELF_PLUGIN_ID });
  const data = mergeRequest.data ?? {};
  const companyId = String(data.companyId ?? config.repositories[0]?.companyId ?? "");

  if (!decision.enqueueDispatch) {
    await ctx.activity.log({
      companyId,
      message: `merge approval.decided ${event.approvalId}: ${decision.reason}`,
      entityType: "approval",
      entityId: event.approvalId,
    });
    return;
  }
  if (data.superseded) {
    await ctx.activity.log({
      companyId,
      message: `suppressed merge for superseded approval ${event.approvalId}`,
      entityType: "approval",
      entityId: event.approvalId,
    });
    return;
  }

  const repository = String(data.repository ?? "");
  const prNumber = Number(data.prNumber ?? 0);
  const headSha = String(data.headSha ?? "");
  const issueId = String(data.issueId ?? "");
  const route = routeForRepository(config, repository);
  const merge = route?.mergeApprovals;
  if (!merge) return;

  // Revalidate fail-closed before enqueuing the merge. A definitive gate
  // failure (closed / draft / changed head / not mergeable / checks failed)
  // never enqueues. A transient GitHub error during this revalidation still
  // enqueues, because the drain revalidates authoritatively with bounded retries
  // before performing the merge.
  try {
    const token = await mintMergeToken(ctx, merge.githubApp);
    const pr = await fetchPullRequestState(ctx, token, repository, prNumber);
    const observed = await fetchShaChecks(ctx, token, repository, headSha);
    const gate = evaluateMergeGate({ pr, config: merge, requiredHeadSha: headSha, observed });
    if (!gate.allowed) {
      await ctx.activity.log({
        companyId,
        message: `merge suppressed for approval ${event.approvalId}: ${gate.reasons.join("; ")}`,
        entityType: "approval",
        entityId: event.approvalId,
      });
      return;
    }
  } catch (error) {
    await ctx.activity.log({
      companyId,
      message: `merge enqueue-time revalidation hit a transient error for approval ${event.approvalId}: ${errorMessage(error)}; enqueueing, the drain revalidates before merge`,
      entityType: "approval",
      entityId: event.approvalId,
    });
  }

  const outboxId = mergeOutboxExternalId(event.approvalId, headSha);
  const existing = await ctx.entities.list({ entityType: MERGE_OUTBOX_ENTITY, externalId: outboxId, limit: 1 });
  if (existing.length > 0) return;
  await ctx.entities.upsert({
    entityType: MERGE_OUTBOX_ENTITY,
    scopeKind: "instance",
    externalId: outboxId,
    title: `merge ${repository}#${prNumber} @${headSha.slice(0, 12)}`,
    status: "pending",
    data: {
      approvalId: event.approvalId,
      sha: headSha,
      repository,
      prNumber,
      issueId,
      status: "pending",
      attempts: 0,
      lastError: null,
    },
  });
}

/**
 * Drain pending merge outbox records: revalidate the exact head and gates, then
 * squash merge via the GitHub App with bounded retries. A changed head / closed
 * / not-mergeable / superseded PR is a terminal failure and never merges.
 */
export async function drainMergeOutbox(ctx: PluginContext, config: GitHubBridgeConfig): Promise<void> {
  const pending = await ctx.entities.list({ entityType: MERGE_OUTBOX_ENTITY, limit: 50 });
  for (const entity of pending) {
    const record = entity.data as JsonRecord | undefined;
    if (!record || !shouldAttemptMerge(record as never)) continue;
    const repository = String(record.repository ?? "");
    const route = routeForRepository(config, repository);
    const merge = route?.mergeApprovals;
    if (!merge) continue;
    const approvalId = String(record.approvalId ?? "");
    const sha = String(record.sha ?? "");
    const prNumber = Number(record.prNumber ?? 0);
    const issueId = String(record.issueId ?? "");
    const companyId = String(route.companyId ?? config.repositories[0]?.companyId ?? "");

    let outcome: MergeOutcome;
    try {
      const token = await mintMergeToken(ctx, merge.githubApp);
      const pr = await fetchPullRequestState(ctx, token, repository, prNumber);
      if (pr.merged) {
        outcome = { ok: true };
      } else {
        const observed = await fetchShaChecks(ctx, token, repository, sha);
        const gate = evaluateMergeGate({ pr, config: merge, requiredHeadSha: sha, observed });
        if (!gate.allowed) {
          outcome = { ok: false, terminal: true, error: `merge gate failed: ${gate.reasons.join("; ")}` };
        } else {
          outcome = await performSquashMerge(ctx, token, repository, prNumber, sha, approvalId, issueId);
        }
      }
    } catch (error) {
      outcome = { ok: false, error: errorMessage(error) };
    }

    const next = applyMergeAttemptOutcome(record as never, outcome);
    await ctx.entities.upsert({
      entityType: MERGE_OUTBOX_ENTITY,
      scopeKind: "instance",
      externalId: mergeOutboxExternalId(approvalId, sha),
      title: entity.title ?? `merge ${repository}`,
      status: next.status,
      data: { ...record, ...next },
    });
    await ctx.activity.log({
      companyId,
      message: `squash merge ${next.status} for approval ${approvalId} after attempt ${next.attempts}: ${next.lastError ?? "ok"}`,
      entityType: "approval",
      entityId: approvalId,
      metadata: { repository, prNumber, sha, status: next.status, attempts: next.attempts },
    });
  }
}

// Re-exported for callers/tests.
export { routeForRepository };
export type { GitHubRepositoryRoute, MergeApprovalsConfig };
