/**
 * Public entrypoint of the structured GitHub → Papercompany re-review loop.
 *
 * Re-exports the intake (`processRereviewChange`) and hosts the authenticated
 * steward review-result path: PASS continues through the exact-SHA merge
 * approval path; REQUEST_CHANGES posts/updates evidence on the GitHub PR
 * through the configured GitHub App. A stale verdict (older than the tracked
 * revision) is rejected and never mutates GitHub.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GitHubBridgeConfig } from "./config.js";
import { routeForRepository } from "./deploy-approvals.js";
import { isVerdictFresh } from "./rereview.js";
import { mintGitHubAppInstallationToken } from "./github-app-auth.js";
import { requestMergeApproval } from "./merge-approvals.js";
import {
  githubHeaders,
  loadRereviewState,
  splitRepo,
} from "./rereview-state.js";

export { processRereviewChange } from "./rereview-intake.js";
export {
  readRereviewState,
  writeRereviewState,
  loadRereviewState,
  findLinkedIssueId,
  fetchShaChecks,
} from "./rereview-state.js";

export interface StewardReviewResultInput {
  repository: string;
  prNumber: number;
  headSha: string;
  verdict: "pass" | "request_changes";
  issueId?: string;
  evidence?: unknown;
}

/**
 * Structured steward review-result delivery (the authenticated callback from
 * the Runtime steward). PASS continues through the exact-SHA merge approval
 * path; REQUEST_CHANGES posts/updates evidence on the GitHub PR through the
 * configured GitHub App. A stale verdict (older than the tracked revision) is
 * rejected.
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
  const freshness = isVerdictFresh(state, input.headSha);
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
    return postRequestChanges(ctx, route.mergeApprovals!, input);
  }
  if (input.verdict === "pass") {
    // PASS → continue through the exact-SHA merge approval path. Revalidates
    // the exact PR revision and creates a Human Operator merge approval.
    await requestMergeApproval(ctx, config, {
      repository: input.repository,
      prNumber: input.prNumber,
      headSha: input.headSha,
      issueId: input.issueId ?? "",
      reviewEvidence: input.evidence ?? null,
    });
    return { accepted: true, reason: "pass routes to merge approval" };
  }
  return { accepted: false, reason: "unknown verdict" };
}

async function postRequestChanges(
  ctx: PluginContext,
  merge: NonNullable<GitHubBridgeConfig["repositories"][number]["mergeApprovals"]>,
  input: StewardReviewResultInput,
): Promise<{ accepted: boolean; reason: string }> {
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
  return { accepted: true, reason: "request_changes evidence posted" };
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
