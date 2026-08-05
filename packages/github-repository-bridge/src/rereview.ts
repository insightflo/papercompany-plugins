/**
 * Pure decision logic for the structured GitHub → Papercompany re-review loop.
 *
 * Nothing here touches the plugin host. The bridge treats GitHub structure as
 * the only execution authority:
 *
 * - `pull_request.synchronize` (and an exact-head check with every required
 *   check passing) advances the PR revision. Repeated deliveries are coalesced
 *   by the latest head SHA — a stale revision never re-wakes the steward.
 * - A GitHub comment is mirrored to the linked issue BEFORE any steward wake,
 *   and never parsed as execution authority.
 * - The steward is invoked exactly once per eligible revision, with the exact
 *   issue/comment/task context so the Runtime creates an issue-linked run.
 * - A stale steward verdict (older than the tracked revision) is rejected
 *   instead of re-blocking the issue.
 */
import type { GitHubChange } from "./delivery.js";
import type { MergeApprovalsConfig } from "./config.js";

/** Plugin-owned entity tracking the latest PR head per repository+PR. */
export const REREVIEW_ENTITY = "github-rereview-state";

export const SOURCE_MARKER = "<!-- papercompany-github-bridge:source=github -->";

const REQUIRED_SHA_LENGTH = 40;
const HEX_SHA = /^[0-9a-f]{40}$/;

export interface RereviewConfig {
  /** PR base branch eligible for the re-review loop (e.g. main). */
  baseBranch: string;
  /** PR check names that must succeed before the loop may wake the steward. */
  requiredChecks: string[];
}

export function rereviewConfigFromMerge(merge: MergeApprovalsConfig | undefined): RereviewConfig | null {
  if (!merge) return null;
  return { baseBranch: merge.baseBranch, requiredChecks: merge.requiredChecks };
}

/**
 * The tracked state of the re-review loop for one repository+PR.
 * `revision` is the newest exact head SHA that was accepted as authoritative;
 * `wokenRevision` is the newest SHA the steward was actually invoked for.
 */
export interface RereviewState {
  revision: string;
  wokenRevision: string | null;
  checksSatisfied: boolean;
  /** The required-check names configured for this route, persisted so verdict freshness can be evaluated without re-reading config. */
  requiredChecks: string[];
  lastWakeAt: string | null;
  lastWakeCommentId: string | null;
}

export interface RereviewDelivery {
  repository: string;
  prNumber: number;
  /** Exact 40-char head SHA carried by the GitHub delivery. */
  headSha: string;
  baseRef: string;
  /** True when the delivery is a check_run/workflow_run conclusion, not a PR event. */
  isCheckDelivery: boolean;
  /** Check conclusions carried by the delivery (name → conclusion). */
  checks: Array<{ name: string; conclusion: string }>;
  comment: GitHubChange["comment"];
  change: GitHubChange;
}

export function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

export function isExactSha(sha: string): boolean {
  return HEX_SHA.test(sha.trim().toLowerCase());
}

/**
 * Decide whether a delivery advances the tracked revision. Only a delivery
 * carrying the exact current head SHA of the PR (pull_request.synchronize or a
 * check_run/workflow_run pinned to that head) may advance the state.
 */
export function decideRevisionAdvance(
  current: RereviewState | null,
  delivery: RereviewDelivery,
): { advance: boolean; reason: string } {
  const sha = normalizeSha(delivery.headSha);
  if (!isExactSha(sha)) {
    return { advance: false, reason: `delivery head is not an exact 40-char SHA: ${delivery.headSha}` };
  }
  if (current && current.revision === sha) {
    return { advance: false, reason: `delivery is for the already-tracked head ${sha}` };
  }
  if (delivery.isCheckDelivery && delivery.checks.length === 0) {
    return { advance: false, reason: "check delivery carries no check conclusions" };
  }
  return { advance: true, reason: `new head ${sha}` };
}

/**
 * Coalesce repeated deliveries by the latest SHA: given the tracked revision,
 * decide whether the steward should be invoked for this delivery. The steward
 * is invoked at most once per eligible revision — never per check event.
 */
export function decideWake(
  state: RereviewState | null,
  delivery: RereviewDelivery,
): { wake: boolean; reason: string } {
  if (delivery.isCheckDelivery) {
    return { wake: false, reason: "check deliveries never wake the steward directly" };
  }
  const sha = normalizeSha(delivery.headSha);
  if (!state || state.revision !== sha) {
    return { wake: false, reason: `delivery head ${sha} is not the tracked revision` };
  }
  if (state.wokenRevision === sha) {
    return { wake: false, reason: `steward already invoked for revision ${sha}` };
  }
  if (!state.checksSatisfied) {
    return { wake: false, reason: "required checks are not satisfied for this revision" };
  }
  return { wake: true, reason: `new eligible revision ${sha}` };
}

export function requiredChecksSatisfied(
  required: string[],
  checks: Array<{ name: string; conclusion: string }>,
): boolean {
  const latest = new Map<string, string>();
  for (const check of checks) latest.set(check.name, check.conclusion);
  return required.every((name) => latest.get(name) === "success");
}

/**
 * Record a check conclusion into the state (per exact head SHA). Returns the
 * updated checks-satisfied flag for that revision.
 */
export function mergeCheckConclusion(
  checks: Array<{ name: string; conclusion: string }>,
  name: string,
  conclusion: string,
): boolean {
  return requiredChecksSatisfied([name], [...checks, { name, conclusion }]);
}

/**
 * Stale-verdict rejection: a steward result is only actionable when its head
 * SHA is the tracked revision AND the steward was actually invoked for it.
 */
export function isVerdictFresh(
  state: RereviewState | null,
  verdictHeadSha: string,
): { fresh: boolean; reason: string } {
  const sha = normalizeSha(verdictHeadSha);
  if (!state) return { fresh: false, reason: "no tracked revision" };
  if (state.revision !== sha) {
    return { fresh: false, reason: `verdict head ${sha} is not the tracked revision ${state.revision}` };
  }
  if (state.wokenRevision !== sha) {
    return { fresh: false, reason: `steward was not invoked for ${sha}` };
  }
  return { fresh: true, reason: "verdict matches the tracked woken revision" };
}

export function rereviewStateExternalId(repository: string, prNumber: number): string {
  return `rereview:${repository.toLowerCase()}:${prNumber}`;
}

/**
 * Render the steward wake prompt with exact issue/comment/task context. The
 * runtime consumes `payload.issueId`/`payload.commentId`/`payload.taskKey` to
 * create an issue-linked run (never an issueId-null run).
 */
export function buildWakeContext(input: {
  repository: string;
  prNumber: number;
  headSha: string;
  issueId: string;
  commentId?: string | null;
  taskKey?: string;
}): { issueId: string; commentId?: string; taskKey?: string; repository: string; prNumber: number; headSha: string } {
  const context: { issueId: string; commentId?: string; taskKey?: string; repository: string; prNumber: number; headSha: string } = {
    issueId: input.issueId,
    repository: input.repository,
    prNumber: input.prNumber,
    headSha: input.headSha,
  };
  if (input.commentId) context.commentId = input.commentId;
  context.taskKey = input.taskKey ?? `issue:${input.issueId}`;
  return context;
}

export function buildWakePrompt(input: {
  repository: string;
  prNumber: number;
  headSha: string;
  commentId?: string | null;
}): string {
  const base = `GitHub PR ${input.repository}#${input.prNumber} advanced to head ${input.headSha} with required checks passing. Review the linked Papercompany issue and post a structured verdict (PASS or REQUEST_CHANGES) via the steward review-result endpoint.`;
  return input.commentId ? `${base} A new GitHub comment was mirrored to the issue (comment id ${input.commentId}) and should be addressed.` : base;
}

/**
 * Mirror a GitHub comment into a Papercompany comment body. Bridge-origin
 * comments (containing the bridge source marker) are never re-mirrored, which
 * prevents bridge-origin comment loops.
 */
export function buildMirroredComment(change: GitHubChange): string | null {
  if (!change.comment) return null;
  if (change.comment.body.includes(SOURCE_MARKER)) return null;
  return [
    SOURCE_MARKER,
    `GitHub comment by @${change.comment.author || "unknown"}`,
    change.comment.url,
    "",
    change.comment.body,
  ].join("\n");
}
