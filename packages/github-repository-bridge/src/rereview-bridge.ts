/**
 * Public entrypoint of the structured GitHub → Papercompany re-review loop.
 *
 * Re-exports the intake (`processRereviewChange`) and hosts the authenticated
 * steward review-result path: PASS continues through the exact-SHA merge
 * approval path; REQUEST_CHANGES posts/updates evidence on the GitHub PR
 * through the configured GitHub App, idempotently per
 * repository+PR+SHA+verdict, then blocks the exact linked issue. Verdicts are
 * fail-closed: they require the exact tracked head AND the exact linked
 * issueId recorded for that revision; stale verdicts are rejected and never
 * mutate GitHub.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GitHubBridgeConfig } from "./config.js";
import { routeForRepository } from "./deploy-approvals.js";
import {
  isVerdictFresh,
  rereviewPublicationExternalId,
  terminalStatusAfterVerdict,
  REREVIEW_PUBLICATION_ENTITY,
} from "./rereview.js";
import { mintGitHubAppInstallationToken } from "./github-app-auth.js";
import { requestMergeApproval } from "./merge-approvals.js";
import {
  githubHeaders,
  loadRereviewState,
  loadRereviewRevision,
  updateRereviewRevision,
  splitRepo,
} from "./rereview-state.js";

export { processRereviewChange } from "./rereview-intake.js";
export {
  readRereviewState,
  writeRereviewState,
  loadRereviewState,
  loadRereviewRevision,
  recordRereviewRevision,
  updateRereviewRevision,
  findLinkedIssueId,
  findOrCreateReviewIssue,
  fetchShaChecks,
} from "./rereview-state.js";

export interface StewardReviewResultInput {
  repository: string;
  prNumber: number;
  headSha: string;
  verdict: "pass" | "request_changes";
  issueId: string;
  evidence?: unknown;
}

/**
 * Structured steward review-result delivery (the authenticated callback from
 * the Runtime steward). PASS continues through the exact-SHA merge approval
 * path; REQUEST_CHANGES posts/updates evidence on the GitHub PR through the
 * configured GitHub App and then blocks the exact linked issue. Verdicts
 * require the exact tracked head AND the exact recorded issueId.
 */
export async function acceptStewardReviewResult(
  ctx: PluginContext,
  config: GitHubBridgeConfig,
  input: StewardReviewResultInput,
): Promise<{ accepted: boolean; reason: string }> {
  const route = routeForRepository(config, input.repository);
  const merge = route?.mergeApprovals;
  if (!route || !merge) return { accepted: false, reason: "mergeApprovals is not configured" };

  const { state } = await loadRereviewState(ctx, input.repository, input.prNumber);
  const { revision } = await loadRereviewRevision(ctx, input.repository, input.prNumber, input.headSha);
  const freshness = isVerdictFresh(state, revision, input.headSha, input.issueId);
  if (!freshness.fresh) {
    await ctx.activity.log({
      companyId: route.companyId,
      message: `stale steward verdict rejected for ${input.repository}#${input.prNumber}@${input.headSha.slice(0, 12)}: ${freshness.reason}`,
      entityType: "issue",
      entityId: "",
      metadata: { repository: input.repository, prNumber: input.prNumber, headSha: input.headSha },
    });
    return { accepted: false, reason: freshness.reason };
  }

  if (input.verdict === "request_changes") {
    return postRequestChanges(ctx, route, input);
  }
  if (input.verdict === "pass") {
    // PASS → continue through the exact-SHA merge approval path. Revalidates
    // the exact PR revision and creates a Human Operator merge approval.
    await requestMergeApproval(ctx, config, {
      repository: input.repository,
      prNumber: input.prNumber,
      headSha: input.headSha,
      issueId: revision!.issueId,
      reviewEvidence: input.evidence ?? null,
    });
    await finalizeRevision(ctx, input, "pass");
    return { accepted: true, reason: "pass routes to merge approval" };
  }
  return { accepted: false, reason: "unknown verdict" };
}

/**
 * REQUEST_CHANGES: publish evidence to the GitHub PR idempotently (one
 * comment per repository+PR+SHA+verdict), then block the exact linked issue.
 */
async function postRequestChanges(
  ctx: PluginContext,
  route: NonNullable<GitHubBridgeConfig["repositories"][number]>,
  input: StewardReviewResultInput,
): Promise<{ accepted: boolean; reason: string }> {
  const merge = route.mergeApprovals!;
  const issueId = input.issueId;
  const externalId = rereviewPublicationExternalId(input.repository, input.prNumber, input.headSha, "request_changes");
  const [existing] = await ctx.entities.list({ entityType: REREVIEW_PUBLICATION_ENTITY, externalId, limit: 1 });
  if (existing) {
    // Idempotent re-delivery: the evidence is already on the PR. Block the
    // exact linked issue and record the terminal outcome once.
    await ctx.issues.update(issueId, { status: "blocked" }, route.companyId);
    const { revision } = await loadRereviewRevision(ctx, input.repository, input.prNumber, input.headSha);
    if (revision && revision.status !== "request_changes") {
      await updateRereviewRevision(ctx, input.repository, input.prNumber, { ...revision, status: "request_changes" });
    }
    return { accepted: true, reason: "request_changes evidence already published (idempotent)" };
  }

  const token = await mintGitHubAppInstallationToken({
    http: ctx.http,
    appId: await ctx.secrets.resolve(merge.githubApp.appIdRef),
    privateKey: await ctx.secrets.resolve(merge.githubApp.privateKeyRef),
    repository: merge.githubApp.installationRepository,
  });
  const [owner, repo] = splitRepo(input.repository);
  const comment = buildRequestChangesBody(input);
  const res = await ctx.http.fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${input.prNumber}/comments`,
    { method: "POST", headers: githubHeaders(token), body: JSON.stringify({ body: comment }) },
  );
  if (res.status < 200 || res.status >= 300) {
    return { accepted: false, reason: `GitHub comment failed: HTTP ${res.status}` };
  }
  await ctx.entities.upsert({
    entityType: REREVIEW_PUBLICATION_ENTITY,
    scopeKind: "instance",
    externalId,
    title: `request_changes ${input.repository}#${input.prNumber} @${input.headSha.slice(0, 12)}`,
    status: "published",
    data: { repository: input.repository, prNumber: input.prNumber, headSha: input.headSha, verdict: "request_changes" },
  });
  await ctx.issues.update(issueId, { status: "blocked" }, route.companyId);
  await finalizeRevision(ctx, input, "request_changes");
  return { accepted: true, reason: "request_changes evidence posted" };
}

async function finalizeRevision(
  ctx: PluginContext,
  input: StewardReviewResultInput,
  verdict: "pass" | "request_changes",
): Promise<void> {
  const { revision } = await loadRereviewRevision(ctx, input.repository, input.prNumber, input.headSha);
  if (revision) {
    const status = terminalStatusAfterVerdict(verdict);
    await updateRereviewRevision(ctx, input.repository, input.prNumber, { ...revision, status });
  }
}

function buildRequestChangesBody(input: StewardReviewResultInput): string {
  const evidence = typeof input.evidence === "string" && input.evidence.trim().length > 0
    ? input.evidence
    : typeof input.evidence === "object" && input.evidence !== null
      ? JSON.stringify(input.evidence, null, 2)
      : "";
  return [
    "## Papercompany steward review: REQUEST_CHANGES",
    "",
    `Head SHA: \`${input.headSha}\``,
    "",
    evidence,
    "",
    "<!-- papercompany-github-bridge:steward-request-changes -->",
  ].join("\n");
}
