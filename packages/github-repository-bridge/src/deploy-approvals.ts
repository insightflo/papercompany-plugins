/**
 * Host-facing orchestration for approval-driven deployment. Uses the pure
 * decision helpers in deploy-checks / resolution-handler / dispatch-outbox and
 * drives the plugin host (entities, approvals, http, secrets, activity). The
 * approval is created ONLY once all required checks for the exact SHA pass.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GitHubBridgeConfig, GitHubRepositoryRoute, DeployApprovalsConfig } from "./config.js";
import { mintGitHubAppInstallationToken } from "./github-app-auth.js";
import type { PushDelivery, CommitCheck } from "./push-delivery.js";
import {
  DEPLOY_APPROVAL_TYPE,
  evaluateCheckGate,
  buildApprovalPayload,
} from "./deploy-checks.js";
import {
  OBSERVATION_ENTITY,
  OUTBOX_ENTITY,
  outboxExternalId,
  buildRepositoryDispatchBody,
  applyAttemptOutcome,
  shouldAttemptDispatch,
} from "./dispatch-outbox.js";

export function routeForRepository(config: GitHubBridgeConfig, repository: string): GitHubRepositoryRoute | null {
  return config.repositories.find((route) => route.repository === repository) ?? null;
}

function observationExternalId(repository: string, sha: string): string {
  return `obs:${repository}:${sha}`;
}

function asChecks(value: unknown): CommitCheck[] {
  return Array.isArray(value) ? (value as CommitCheck[]) : [];
}

/**
 * Record a push to a configured deploy branch. Keeps a non-actionable
 * observation (no approval yet) and marks older pending observations for the
 * same repo+branch as superseded. No approval is created here.
 */
export async function processPush(
  ctx: PluginContext,
  route: GitHubRepositoryRoute,
  deploy: DeployApprovalsConfig,
  push: PushDelivery,
): Promise<void> {
  if (push.branch !== deploy.branch) return;
  const key = observationExternalId(push.repository, push.after);
  // Supersede older pending observations for the same repo+branch.
  const existing = await ctx.entities.list({ entityType: OBSERVATION_ENTITY, limit: 500 });
  for (const entity of existing) {
    const data = entity.data ?? {};
    if (
      data.repository === push.repository &&
      data.branch === push.branch &&
      data.sha !== push.after &&
      !data.superseded
    ) {
      await ctx.entities.upsert({
        entityType: OBSERVATION_ENTITY,
        scopeKind: "instance",
        externalId: entity.externalId ?? "",
        status: "superseded",
        data: { ...data, superseded: true, supersededBy: push.after },
      });
    }
  }
  const prior = (await ctx.entities.list({ entityType: OBSERVATION_ENTITY, externalId: key, limit: 1 }))[0];
  const priorData = prior?.data ?? {};
  await ctx.entities.upsert({
    entityType: OBSERVATION_ENTITY,
    scopeKind: "instance",
    externalId: key,
    title: `${push.repository} ${push.branch} ${push.after.slice(0, 12)}`,
    status: "observed",
    data: {
      repository: push.repository,
      branch: push.branch,
      sha: push.after,
      companyId: route.companyId,
      observedChecks: asChecks(priorData.observedChecks),
      checksReady: false,
      approvalId: null,
      superseded: false,
      pushedAt: new Date().toISOString(),
    },
  });
  await maybeCreateApproval(ctx, route, deploy, push.repository, push.after);
}

/** Record a check result for a tracked SHA and (re)evaluate the gate. */
export async function processCommitCheck(
  ctx: PluginContext,
  config: GitHubBridgeConfig,
  check: CommitCheck,
): Promise<void> {
  const route = routeForRepository(config, check.repository);
  const deploy = route?.deployApprovals;
  if (!route || !deploy) return;
  const key = observationExternalId(check.repository, check.sha);
  let [observation] = await ctx.entities.list({ entityType: OBSERVATION_ENTITY, externalId: key, limit: 1 });
  if (!observation) {
    // GitHub Apps can receive check events without a matching push event. A
    // check for the configured branch still carries the exact branch + SHA, so
    // use it to create the same observation and supersession state as a push.
    if (check.branch !== deploy.branch) return;
    await processPush(ctx, route, deploy, {
      repository: check.repository,
      branch: check.branch,
      ref: `refs/heads/${check.branch}`,
      before: "",
      after: check.sha,
      commitMessage: "",
      commitAuthor: "",
      url: check.url,
    });
    [observation] = await ctx.entities.list({ entityType: OBSERVATION_ENTITY, externalId: key, limit: 1 });
  }
  if (!observation) return;
  const data = observation.data ?? {};
  if (data.superseded) return;
  const observed = mergeCheck(asChecks(data.observedChecks), check);
  await ctx.entities.upsert({
    entityType: OBSERVATION_ENTITY,
    scopeKind: "instance",
    externalId: key,
    status: "checks-updated",
    data: { ...data, observedChecks: observed },
  });
  await maybeCreateApproval(ctx, route, deploy, check.repository, check.sha);
}

function mergeCheck(observed: CommitCheck[], check: CommitCheck): CommitCheck[] {
  const without = observed.filter((entry) => !(entry.name === check.name && entry.source === check.source));
  return [...without, check];
}

async function maybeCreateApproval(
  ctx: PluginContext,
  route: GitHubRepositoryRoute,
  deploy: DeployApprovalsConfig,
  repository: string,
  sha: string,
): Promise<void> {
  const key = observationExternalId(repository, sha);
  const [observation] = await ctx.entities.list({ entityType: OBSERVATION_ENTITY, externalId: key, limit: 1 });
  if (!observation) return;
  const data = observation.data ?? {};
  if (data.superseded || data.approvalId) return;
  const gate = evaluateCheckGate(deploy.requiredChecks, asChecks(data.observedChecks));
  if (!gate.satisfied) return;
  const push: PushDelivery = {
    repository,
    branch: String(data.branch ?? ""),
    ref: "",
    before: "",
    after: sha,
    commitMessage: "",
    commitAuthor: "",
    url: "",
  };
  const payload = buildApprovalPayload({ push, config: deploy, checks: gate });
  const approval = await ctx.approvals.create({
    companyId: route.companyId,
    type: DEPLOY_APPROVAL_TYPE,
    payload,
    title: deploy.approvalTitle,
    summary: `All required checks passed for ${sha.slice(0, 12)}.`,
  });
  await ctx.entities.upsert({
    entityType: OBSERVATION_ENTITY,
    scopeKind: "instance",
    externalId: key,
    status: "approval-created",
    data: { ...data, observedChecks: asChecks(data.observedChecks), checksReady: true, approvalId: approval.id },
  });
  await ctx.activity.log({
    companyId: route.companyId,
    message: `Created external_automation approval ${approval.id} for ${repository}@${sha.slice(0, 12)}`,
    entityType: "approval",
    entityId: approval.id,
    metadata: { repository, branch: data.branch, sha },
  });
}

/**
 * Handle an approval.decided broadcast. On approve, enqueue one idempotent
 * dispatch outbox record for the exact recorded commit. Reject/superseded
 * never dispatch.
 */
export async function handleApprovalDecided(
  ctx: PluginContext,
  config: GitHubBridgeConfig,
  event: { approvalId: string; decision: string; status: string; type: string; sourcePluginId: string | null },
): Promise<void> {
  const { decideResolutionAction } = await import("./resolution-handler.js");
  const decision = decideResolutionAction(event);
  if (!decision.enqueueDispatch) {
    await ctx.activity.log({
      companyId: config.repositories[0]?.companyId ?? "",
      message: `approval.decided ${event.approvalId}: ${decision.reason}`,
      entityType: "approval",
      entityId: event.approvalId,
    });
    return;
  }
  const observation = (await ctx.entities.list({ entityType: OBSERVATION_ENTITY, limit: 500 }))
    .find((entity) => entity.data?.approvalId === event.approvalId);
  if (!observation) return;
  const data = observation.data ?? {};
  // A superseded observation (a newer commit superseded its branch) must never
  // dispatch, even if its old approval is later approved.
  if (data.superseded) {
    await ctx.activity.log({
      companyId: String(data.companyId ?? config.repositories[0]?.companyId ?? ""),
      message: `suppressed dispatch for superseded approval ${event.approvalId}`,
      entityType: "approval",
      entityId: event.approvalId,
    });
    return;
  }
  const repository = String(data.repository ?? "");
  const branch = String(data.branch ?? "");
  const sha = String(data.sha ?? "");
  const route = routeForRepository(config, repository);
  const deploy = route?.deployApprovals;
  if (!deploy) return;
  const { buildDispatchPayload } = await import("./deploy-checks.js");
  const payload = buildDispatchPayload({
    config: deploy,
    push: { repository, branch, ref: "", before: "", after: sha, commitMessage: "", commitAuthor: "", url: "" },
    approvalId: event.approvalId,
  });
  // Idempotent: only insert if no outbox record exists for this approval.
  const existing = await ctx.entities.list({ entityType: OUTBOX_ENTITY, externalId: outboxExternalId(event.approvalId, sha), limit: 1 });
  if (existing.length > 0) return;
  await ctx.entities.upsert({
    entityType: OUTBOX_ENTITY,
    scopeKind: "instance",
    externalId: outboxExternalId(event.approvalId, sha),
    title: `dispatch ${repository}@${sha.slice(0, 12)}`,
    status: "pending",
    data: { approvalId: event.approvalId, sha, repository, branch, status: "pending", attempts: 0, lastError: null, payload },
  });
}

/** Drain pending outbox records: POST repository_dispatch; sent/failed are not retried. */
export async function drainOutbox(ctx: PluginContext, config: GitHubBridgeConfig): Promise<void> {
  const pending = await ctx.entities.list({ entityType: OUTBOX_ENTITY, limit: 50 });
  for (const entity of pending) {
    const record = entity.data as Record<string, unknown> | undefined;
    if (!record || !shouldAttemptDispatch(record as never)) continue;
    const repository = String(record.repository ?? "");
    const route = routeForRepository(config, repository);
    const deploy = route?.deployApprovals;
    if (!deploy) continue;
    const approvalId = String(record.approvalId ?? "");
    const sha = String(record.sha ?? "");
    try {
      const endpoint = await ctx.secrets.resolve(deploy.dispatch.endpointRef);
      const token = deploy.dispatch.tokenRef
        ? await ctx.secrets.resolve(deploy.dispatch.tokenRef)
        : await mintGitHubAppInstallationToken({
          http: ctx.http,
          appId: await ctx.secrets.resolve(deploy.dispatch.githubApp!.appIdRef),
          privateKey: await ctx.secrets.resolve(deploy.dispatch.githubApp!.privateKeyRef),
          repository: deploy.dispatch.githubApp!.installationRepository,
        });
      const payload = record.payload as Record<string, unknown> | undefined;
      const res = await ctx.http.fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/vnd.github+json" },
        body: JSON.stringify(buildRepositoryDispatchBody(payload as never)),
      });
      const ok = res.status >= 200 && res.status < 300;
      const next = applyAttemptOutcome(record as never, { ok, error: ok ? undefined : `HTTP ${res.status}` });
      await ctx.entities.upsert({
        entityType: OUTBOX_ENTITY,
        scopeKind: "instance",
        externalId: outboxExternalId(approvalId, sha),
        title: entity.title ?? `dispatch ${repository}`,
        status: next.status,
        data: { ...record, ...next },
      });
      if (!ok) {
        await ctx.activity.log({
          companyId: route.companyId,
          message: `Operations dispatch ${next.status} for approval ${approvalId} after attempt ${next.attempts}: ${next.lastError}`,
          entityType: "approval",
          entityId: approvalId,
          metadata: { repository, sha, status: next.status, attempts: next.attempts },
        });
      }
    } catch (error) {
      const next = applyAttemptOutcome(record as never, { ok: false, error: error instanceof Error ? error.message : String(error) });
      await ctx.entities.upsert({
        entityType: OUTBOX_ENTITY,
        scopeKind: "instance",
        externalId: outboxExternalId(approvalId, sha),
        title: entity.title ?? `dispatch ${repository}`,
        status: next.status,
        data: { ...record, ...next },
      });
      await ctx.activity.log({
        companyId: route.companyId,
        message: `Operations dispatch ${next.status} for approval ${approvalId} after attempt ${next.attempts}: ${next.lastError}`,
        entityType: "approval",
        entityId: approvalId,
        metadata: { repository, sha, status: next.status, attempts: next.attempts },
      });
    }
  }
}
