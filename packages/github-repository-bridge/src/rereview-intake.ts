/**
 * Host-facing intake of the structured GitHub → Papercompany re-review loop.
 *
 * - the FIRST PR review uses the normal existing issue-creation path (the main
 *   bridge creates the linked issue); every later head SHA gets exactly one NEW
 *   Papercompany review issue for that SHA,
 * - a check delivery NEVER decides on its own: it only records the check
 *   conclusion for the tracked head. The authoritative full required-check set
 *   for the exact head is fetched/evaluated via the GitHub App,
 * - the steward is triggered exactly once per repository+PR+exact SHA by
 *   creating/assigning the per-SHA review issue (the Runtime's existing
 *   issue-assignment execution path); synchronize / check webhook retries and
 *   concurrent deliveries deduplicate,
 * - a previous issue that ended terminal (blocked/done/closed/cancelled) is
 *   never revived,
 * - comments are mirrored once and never parsed as authority.
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
  decideTerminalSkip,
  buildMirroredComment,
  type RereviewState,
  type RereviewDelivery,
} from "./rereview.js";
import { mintGitHubAppInstallationToken } from "./github-app-auth.js";
import {
  findLinkedIssue,
  loadRereviewState,
  writeRereviewState,
  loadRereviewRevision,
  findOrCreateReviewIssue,
  updateRereviewRevision,
  fetchShaChecks,
} from "./rereview-state.js";
import {
  createReviewIssue,
  issueIdForHead,
  mirrorCommentForHead,
} from "./rereview-issue.js";

function normalizeShaForState(sha: string): string {
  return normalizeSha(sha);
}

/**
 * In-process per-repository+PR mutex. The Runtime runs exactly ONE worker
 * process per installed plugin (plugin-worker-manager.ts: "One worker process
 * per installed plugin"), while the SDK worker-rpc-host dispatches inbound
 * webhook RPCs fire-and-forget — so deliveries CAN run concurrently inside
 * the worker. This mutex serializes all deliveries for the same PR, making
 * the load→decide→create→record critical section of the re-review intake
 * atomic within the worker: concurrent deliveries of the same head create
 * exactly one review issue. After a worker restart the persisted per-SHA
 * revision record dedupes. Deliveries for different PRs never contend.
 */
const prLocks = new Map<string, Promise<unknown>>();

async function withPrLock<T>(
  repository: string,
  prNumber: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${repository.toLowerCase()}#${prNumber}`;
  const previous = prLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  // Keep the chain alive regardless of outcome so the next delivery waits.
  prLocks.set(key, run.catch(() => undefined));
  try {
    return await run;
  } finally {
    if (prLocks.get(key) === run) {
      prLocks.delete(key);
    }
  }
}

/**
 * The core re-review intake: given a parsed GitHub change for an allowlisted
 * repository with mergeApprovals, apply the structured loop.
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
  // Serialize all deliveries for this PR within the worker so concurrent
  // deliveries cannot both pass the revision check and create two issues.
  await withPrLock(repository, prNumber, () =>
    processRereviewChangeLocked(ctx, config, route, merge, change, rereviewConfig, prNumber, repository),
  );
}

async function processRereviewChangeLocked(
  ctx: PluginContext,
  config: GitHubBridgeConfig,
  route: GitHubRepositoryRoute,
  merge: MergeApprovalsConfig,
  change: GitHubChange,
  rereviewConfig: NonNullable<ReturnType<typeof rereviewConfigFromMerge>>,
  prNumber: number,
  repository: string,
): Promise<void> {
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
    // A GitHub user comment (issue_comment / pull_request_review) is mirrored
    // exactly once to the review issue for the tracked head — before any
    // trigger — and is never parsed as execution authority.
    if (change.comment && !isCheckDelivery) {
      await mirrorCommentForHead(ctx, route, repository, prNumber, state, delivery);
    }
    // No new revision. A check delivery still triggers a live re-evaluation of
    // the FULL required-check set for the tracked head through the GitHub App;
    // if all required checks now pass, trigger the review exactly once.
    if (isCheckDelivery && state && state.revision === normalizeShaForState(headSha)) {
      await applyCheckConclusion(ctx, route, merge, repository, prNumber, state, delivery);
    }
    return;
  }

  // New authoritative head: record it and evaluate the FULL required-check set
  // for the exact SHA (never one check event). A failed fetch stays fail-closed
  // (not satisfied); later check deliveries re-evaluate the live set.
  const required = rereviewConfig.requiredChecks;
  const satisfied = await resolveLiveCheckSatisfaction(ctx, merge, repository, headSha, required);

  // Snapshot the link's original head when the state is first created: the
  // generic bridge overwrites the link revision on every delivery, so this is
  // the only stable "initial head" signal for first-vs-new decision.
  const linkedHead = !state ? (await findLinkedIssue(ctx, repository, "pull", prNumber))?.revision ?? null : state.linkedHead ?? null;

  const next: RereviewState = {
    revision: headSha,
    wokenRevision: null,
    checksSatisfied: satisfied,
    requiredChecks: required,
    conclusions: [],
    lastWakeAt: null,
    lastWakeCommentId: null,
    firstRevision: !state,
    linkedHead,
  };
  await writeRereviewState(ctx, repository, prNumber, next);

  if (satisfied) {
    await triggerReviewOnce(ctx, route, repository, prNumber, next, delivery);
  }
}

/**
 * A check/workflow delivery for the tracked head never decides on its own. The
 * authoritative FULL required-check set for the exact head is always refetched
 * live through the GitHub App, then every required check is evaluated. The
 * delivered event only confirms that a re-evaluation is due; eligibility is
 * never completed by combining recorded webhook conclusions alone.
 */
async function applyCheckConclusion(
  ctx: PluginContext,
  route: GitHubRepositoryRoute,
  merge: MergeApprovalsConfig,
  repository: string,
  prNumber: number,
  state: RereviewState,
  delivery: RereviewDelivery,
): Promise<void> {
  const required = state.requiredChecks.length > 0 ? state.requiredChecks : merge.requiredChecks;
  const satisfied = await resolveLiveCheckSatisfaction(ctx, merge, repository, state.revision, required);

  const next: RereviewState = { ...state, checksSatisfied: satisfied };
  await writeRereviewState(ctx, repository, prNumber, next);

  if (satisfied) {
    await triggerReviewOnce(ctx, route, repository, prNumber, next, delivery);
  }
}

/**
 * Trigger the per-SHA review exactly once per repository+PR+exact SHA. The
 * trigger is the creation/assignment of the NEW review issue for that exact
 * head (the Runtime's existing issue-assignment path) — never `agents.invoke`,
 * never Runtime invoke-context. Deduplicates synchronize/check retries and
 * concurrent deliveries, and never revives a terminal revision.
 */
async function triggerReviewOnce(
  ctx: PluginContext,
  route: GitHubRepositoryRoute,
  repository: string,
  prNumber: number,
  state: RereviewState,
  delivery: RereviewDelivery,
): Promise<void> {
  const sha = state.revision;
  const wake = decideWake(state, delivery);
  if (!wake.wake) return;

  const { revision } = await loadRereviewRevision(ctx, repository, prNumber, sha);
  const terminal = decideTerminalSkip(revision);
  if (terminal.skip) return;

  const issueId = await issueIdForHead(ctx, route, repository, prNumber, sha, state);
  if (!issueId) return;

  // Mirror the GitHub comment BEFORE the trigger; never parse it as authority.
  const mirrored = buildMirroredComment(delivery.change);
  if (mirrored) {
    await ctx.issues.createComment(issueId, mirrored, route.companyId);
  }

  // Move the per-SHA issue to a reviewable state so the Runtime's issue
  // assignment/status path picks it up. Creating the issue already assigned
  // the steward; this makes the trigger idempotent across retries.
  await ctx.issues.update(issueId, { status: "in_review" }, route.companyId);

  // The initial review has now been dispatched: later heads are genuinely new.
  const woken: RereviewState = {
    ...state,
    wokenRevision: sha,
    firstRevision: false,
    lastWakeAt: new Date().toISOString(),
    lastWakeCommentId: delivery.change.comment?.id ?? null,
  };
  await writeRereviewState(ctx, repository, prNumber, woken);
  if (revision) {
    await updateRereviewRevision(ctx, repository, prNumber, { ...revision, status: "woken" });
  } else {
    await findOrCreateReviewIssue(ctx, repository, prNumber, sha, {
      sha,
      issueId,
      status: "woken",
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
