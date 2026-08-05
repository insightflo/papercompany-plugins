/**
 * Pure decision logic for the structured GitHub → Papercompany re-review loop.
 *
 * Nothing here touches the plugin host. GitHub structure is the only execution
 * authority:
 *
 * - `pull_request.synchronize` with a new exact 40-char head SHA tracks a new
 *   revision. The first PR review uses the normal linked issue; every later SHA
 *   creates exactly one NEW Papercompany review issue for that SHA.
 * - A check delivery for the tracked head only records the check conclusion.
 *   The wake happens only when the authoritative full set of required checks
 *   for the exact head all pass — evaluated by fetching the live check set,
 *   never from a single check event.
 * - The steward wakes at most once per repository+PR+SHA, so synchronize /
 *   check webhook retries and concurrent deliveries deduplicate.
 * - A previous issue that ended in a terminal state (blocked/done/closed/
 *   cancelled) is never revived; each new SHA gets its own new issue.
 * - Steward verdicts stay fail-closed: they require the exact tracked head AND
 *   the exact linked issueId for that revision.
 * - REQUEST_CHANGES GitHub publication is idempotent per
 *   repository+PR+SHA+verdict; the exact linked issue is then blocked.
 */
import type { GitHubChange } from "./delivery.js";
import type { MergeApprovalsConfig } from "./config.js";

export {
  REREVIEW_ENTITY,
  REREVIEW_ISSUE_ENTITY,
  REREVIEW_PUBLICATION_ENTITY,
  SOURCE_MARKER,
  STEWARD_RC_MARKER,
  rereviewStateExternalId,
  rereviewRevisionExternalId,
  rereviewPublicationExternalId,
  buildReviewIssueDescription,
  isBridgeOrigin,
  buildMirroredComment,
} from "./rereview-keys.js";

const HEX_SHA = /^[0-9a-f]{40}$/;

export interface RereviewConfig {
  /** PR base branch eligible for the re-review loop (e.g. main). */
  baseBranch: string;
  /** PR check names that must all succeed before the loop may wake the steward. */
  requiredChecks: string[];
}

export function rereviewConfigFromMerge(merge: MergeApprovalsConfig | undefined): RereviewConfig | null {
  if (!merge) return null;
  return { baseBranch: merge.baseBranch, requiredChecks: merge.requiredChecks };
}

/**
 * The tracked re-review state for one repository+PR. `revision` is the newest
 * exact head SHA accepted as authoritative; the record is keyed by that exact
 * head (repository+PR+SHA), so retries and concurrent deliveries deduplicate.
 */
export interface RereviewState {
  revision: string;
  wokenRevision: string | null;
  checksSatisfied: boolean;
  /** The required-check names configured for this route. */
  requiredChecks: string[];
  /** Recorded check conclusions for the tracked head (name → conclusion), so the full required set can be re-evaluated. */
  conclusions: Array<{ name: string; conclusion: string }>;
  lastWakeAt: string | null;
  lastWakeCommentId: string | null;
  /**
   * True when this revision is the FIRST tracked head for the PR. The first
   * review reuses the normal linked issue; every later head gets exactly one
   * NEW review issue.
   */
  firstRevision?: boolean;
  /**
   * The PR head SHA recorded on the link entity when the re-review state was
   * first created. The generic bridge overwrites the link revision on every
   * delivery, so this snapshot is the only stable "initial head" signal used
   * to decide whether a head is the initial review (reuse the linked issue)
   * or a genuinely new head (create a NEW issue).
   */
  linkedHead?: string | null;
}

/**
 * A revision's issue lifecycle status. `pending`/`woken` are reviewable;
 * `pass`/`request_changes`/`terminal` are terminal outcomes.
 */
export type RereviewRevisionStatus = "pending" | "woken" | "pass" | "request_changes" | "terminal";

/**
 * A per-SHA record created the first time a revision is accepted as
 * authoritative. It owns the review issue for that exact head and the terminal
 * outcome of that revision (never revived).
 */
export interface RereviewRevision {
  sha: string;
  issueId: string;
  status: RereviewRevisionStatus;
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
 * check_run/workflow_run pinned to that head) may advance the state. A check
 * delivery that carries no check conclusions never decides anything on its own.
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
 * decide whether the review should be triggered for this delivery. The review
 * is triggered at most once per repository+PR+exact SHA — never per check
 * event, never for a redelivered synchronize, never after a terminal verdict.
 * A check delivery may trigger only when the authoritative full required-check
 * set for the exact head already passed (the delivery itself never completes
 * eligibility by its single conclusion; the live set does).
 */
export function decideWake(
  state: RereviewState | null,
  delivery: RereviewDelivery,
): { wake: boolean; reason: string } {
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
 * Merge a single delivered check conclusion into an existing conclusion set
 * and evaluate the required set. A single event can only confirm a conclusion
 * for its own check; other required checks stay at their stored conclusion.
 */
export function mergeCheckConclusion(
  existing: Array<{ name: string; conclusion: string }>,
  delivered: Array<{ name: string; conclusion: string }>,
): boolean {
  const byName = new Map(existing.map((check) => [check.name, check.conclusion] as const));
  for (const check of delivered) byName.set(check.name, check.conclusion);
  return requiredChecksSatisfied([...byName.keys()], [...byName].map(([name, conclusion]) => ({ name, conclusion })));
}

/**
 * Terminal safety: a revision whose issue ended in a terminal state is never
 * revived. A blocked/done/closed/cancelled issue stays terminal; only the
 * initial review (pre-verdict) is still reviewable.
 */
export function isTerminalIssueStatus(status: string | null | undefined): boolean {
  return status === "pass" || status === "request_changes" || status === "terminal";
}

/**
 * A real Papercompany issue in a terminal state (blocked/done/cancelled/closed)
 * is never revived or reused as the review target for a new head. This guards
 * the legacy case: a linked issue blocked by an earlier REQUEST_CHANGES may
 * predate the per-SHA state records, so missing re-review state alone is never
 * enough to reuse the linked issue.
 */
export function isTerminalLinkedIssueStatus(status: string | null | undefined): boolean {
  return status === "blocked" || status === "done" || status === "cancelled" || status === "closed";
}

export function isRevisionTerminal(revision: RereviewRevision | null | undefined): boolean {
  return Boolean(revision && isTerminalIssueStatus(revision.status));
}

export function decideTerminalSkip(
  revision: RereviewRevision | null | undefined,
): { skip: boolean; reason: string } {
  if (!revision) return { skip: false, reason: "no revision record" };
  if (isRevisionTerminal(revision)) {
    return { skip: true, reason: `revision already ended terminal: ${revision.status}` };
  }
  return { skip: false, reason: "revision is not terminal" };
}

/**
 * Stale-verdict rejection: a steward result is actionable only when its head
 * SHA is the tracked revision, the steward was actually invoked for it, and
 * the verdict references the EXACT linked issueId recorded for that revision.
 */
export function isVerdictFresh(
  state: RereviewState | null,
  revision: RereviewRevision | null | undefined,
  verdictHeadSha: string,
  issueId: string | undefined,
): { fresh: boolean; reason: string } {
  const sha = normalizeSha(verdictHeadSha);
  if (!state) return { fresh: false, reason: "no tracked revision" };
  if (state.revision !== sha) {
    return { fresh: false, reason: `verdict head ${sha} is not the tracked revision ${state.revision}` };
  }
  if (state.wokenRevision !== sha) {
    return { fresh: false, reason: `steward was not invoked for ${sha}` };
  }
  if (!revision || revision.sha !== sha) {
    return { fresh: false, reason: `no review issue is recorded for ${sha}` };
  }
  if (issueId !== revision.issueId) {
    return { fresh: false, reason: `verdict issueId does not match the linked issue for ${sha}` };
  }
  return { fresh: true, reason: "verdict matches the tracked woken revision and its exact linked issue" };
}

/** A revision becomes terminal once its linked issue reaches a terminal status. */
export function terminalStatusAfterVerdict(verdict: "pass" | "request_changes"): RereviewRevision["status"] {
  return verdict === "request_changes" ? "request_changes" : "pass";
}

