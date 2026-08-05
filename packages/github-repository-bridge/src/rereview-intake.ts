/**
 * Host-facing intake of the structured GitHub → Papercompany re-review loop.
 *
 * - reuses the existing linked issue (never creates a second issue for a new
 *   PR head),
 * - mirrors the GitHub comment BEFORE any steward wake,
 * - does not wake on every check/workflow delivery,
 * - treats `pull_request.synchronize` / exact-new-head SHA and required-check
 *   state as structured authority,
 * - coalesces repeated deliveries by the latest SHA,
 * - when the latest revision is eligible, moves the same blocked issue back to
 *   reviewable state and invokes the steward exactly once with exact
 *   issue/comment/task context via the Runtime wake contract
 *   (`payload.issueId` → issue-linked run).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GitHubBridgeConfig, GitHubRepositoryRoute, MergeApprovalsConfig } from "./config.js";
import type { GitHubChange } from "./delivery.js";
import {
  rereviewConfigFromMerge,
  normalizeSha,
  decideRevisionAdvance,
  decideWake,
  requiredChecksSatisfied,
  buildWakeContext,
  buildWakePrompt,
  buildMirroredComment,
  type RereviewState,
  type RereviewDelivery,
} from "./rereview.js";
import { mintGitHubAppInstallationToken } from "./github-app-auth.js";
import {
  findLinkedIssueId,
  loadRereviewState,
  writeRereviewState,
  fetchShaChecks,
} from "./rereview-state.js";

function normalizeShaForState(sha: string): string {
  return normalizeSha(sha);
}

/**
 * The core re-review intake: given a parsed GitHub change for an allowlisted
 * repository with mergeApprovals, apply the structured loop.
 *
 * The linked issue is reused (never duplicated). The comment is mirrored before
 * any wake. Only an exact-head revision with satisfied required checks moves the
 * blocked issue back to reviewable state and wakes the steward exactly once.
 */
export async function processRereviewChange(
  ctx: PluginContext,
  config: GitHubBridgeConfig,
  route: GitHubRepositoryRoute,
  merge: MergeApprovalsConfig,
  change: GitHubChange,
): Promise<void> {
  const rereviewConfig = rereviewConfigFromMerge(merge);
  if (!rereviewConfig) return;
  if (change.objectKind !== "pull" || change.action === "closed" || change.action === "reopened") return;

  const prNumber = change.objectNumber;
  const repository = change.repository;
  const issueId = await findLinkedIssueId(ctx, repository, "pull", prNumber);
  if (!issueId) return; // The main bridge intake owns link creation; nothing to do without a linked issue.

  const headSha = normalizeShaForState(change.revision ?? "");
  const isCheckDelivery = change.title.startsWith("Check:") || change.title.startsWith("Workflow:");
  const checks: Array<{ name: string; conclusion: string }> = [];
  if (isCheckDelivery) {
    const name = change.title.replace(/^Check:\s*/, "").replace(/^Workflow:\s*/, "");
    checks.push({ name, conclusion: change.state === "success" ? "success" : change.state });
  }
  const delivery: RereviewDelivery = {
    repository,
    prNumber,
    headSha,
    baseRef: "",
    isCheckDelivery,
    checks,
    comment: change.comment,
    change,
  };

  const { state } = await loadRereviewState(ctx, repository, prNumber);
  const advance = decideRevisionAdvance(state, delivery);
  if (!advance.advance) {
    // The check still may contribute conclusions for the tracked revision.
    if (isCheckDelivery && state && state.revision === normalizeShaForState(headSha)) {
      const satisfied = requiredChecksSatisfied(state.requiredChecks, checks);
      if (satisfied !== state.checksSatisfied) {
        await writeRereviewState(ctx, repository, prNumber, { ...state, checksSatisfied: satisfied });
      }
    }
    return;
  }

  // Mirror the GitHub comment BEFORE any wake; never parse it as authority.
  const mirrored = buildMirroredComment(change);
  if (mirrored) {
    await ctx.issues.createComment(issueId, mirrored, route.companyId);
  }

  const required = rereviewConfig.requiredChecks;
  let satisfied = requiredChecksSatisfied(required, checks);
  if (!isCheckDelivery) {
    // pull_request.synchronize: fetch the authoritative check state for the
    // exact SHA through the GitHub App. A failed fetch records the state as
    // not-yet-satisfied; later check deliveries advance it.
    satisfied = await resolveLiveCheckSatisfaction(ctx, merge, repository, headSha, required);
  }

  const next: RereviewState = {
    revision: headSha,
    wokenRevision: null,
    checksSatisfied: satisfied,
    requiredChecks: required,
    lastWakeAt: null,
    lastWakeCommentId: null,
  };

  await writeRereviewState(ctx, repository, prNumber, next);

  const wake = decideWake(next, delivery);
  if (!wake.wake) return;

  // Move the same blocked issue back to reviewable state.
  await ctx.issues.update(issueId, { status: "todo" }, route.companyId);

  const commentId = change.comment?.id ?? null;
  const wakeContext = buildWakeContext({
    repository,
    prNumber,
    headSha,
    issueId,
    commentId,
  });
  try {
    const agent = await ctx.agents.get(route.stewardAgentId, route.companyId);
    if (!agent) return;
    await ctx.agents.invoke(route.stewardAgentId, route.companyId, {
      prompt: buildWakePrompt({ repository, prNumber, headSha, commentId }),
      reason: "github_rereview_eligible",
      context: wakeContext,
    });
    await writeRereviewState(ctx, repository, prNumber, {
      ...next,
      wokenRevision: headSha,
      lastWakeAt: new Date().toISOString(),
      lastWakeCommentId: commentId ?? null,
    });
  } catch (error) {
    await ctx.activity.log({
      companyId: route.companyId,
      message: `steward wake failed for ${repository}#${prNumber}@${headSha.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`,
      entityType: "issue",
      entityId: issueId,
      metadata: { repository, prNumber, headSha },
    });
  }
}

async function resolveLiveCheckSatisfaction(
  ctx: PluginContext,
  merge: MergeApprovalsConfig,
  repository: string,
  headSha: string,
  required: string[],
): Promise<boolean> {
  try {
    const token = await mintGitHubAppInstallationToken({
      http: ctx.http,
      appId: await ctx.secrets.resolve(merge.githubApp.appIdRef),
      privateKey: await ctx.secrets.resolve(merge.githubApp.privateKeyRef),
      repository: merge.githubApp.installationRepository,
    });
    const live = await fetchShaChecks(ctx, token, repository, headSha);
    return live.length > 0 ? requiredChecksSatisfied(required, live) : false;
  } catch {
    return false;
  }
}
