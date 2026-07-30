/**
 * Pure decision logic for steward-driven PR squash merge. Mirrors the deploy
 * path's separation: nothing here touches the plugin host. Every safety-critical
 * check (fail-closed revalidation, supersession, idempotency keys) is a pure
 * function so the gate is fully unit-testable.
 *
 * The PR check gate reuses `evaluateCheckGate` from deploy-checks so there is a
 * single source of truth for "a required check is satisfied only when it
 * completed successfully".
 */
import type { CommitCheck } from "./push-delivery.js";
import type { MergeApprovalsConfig } from "./config.js";
import { evaluateCheckGate } from "./deploy-checks.js";

/** Discriminator stored on the approval payload to mark it as a merge request. */
export const MERGE_APPROVAL_KIND = "merge";
export const MERGE_REQUEST_ENTITY = "github-merge-request";
export const MERGE_OUTBOX_ENTITY = "github-merge-dispatch";

/** The shared manifest plugin id, mirrored for payload stamping. */
const SOURCE_PLUGIN_ID = "insightflo.github-repository-bridge";

/** Live GitHub pull-request state relevant to the merge gate. */
export interface PullRequestState {
  repository: string;
  prNumber: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  mergeable: boolean | null;
  mergeableState: string;
  url: string;
}

export interface MergeGateResult {
  allowed: boolean;
  reasons: string[];
  checks: { satisfied: boolean; missing: string[]; evidence: Array<{ name: string; status: string; conclusion: string; source: string }> };
}

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

/**
 * Parse a GitHub `GET /repos/{owner}/{repo}/pulls/{number}` response into the
 * merge-relevant state. Returns null when identity is missing.
 */
export function parsePullRequest(repository: string, value: unknown): PullRequestState | null {
  const pr = asRecord(value);
  const prNumber = asNumber(pr.number);
  const headSha = asString(asRecord(pr.head).sha);
  if (!prNumber || !headSha) return null;
  const state = asString(pr.state) === "closed" ? "closed" : "open";
  const mergeable = pr.mergeable === true ? true : pr.mergeable === false ? false : null;
  return {
    repository: repository.toLowerCase(),
    prNumber,
    title: asString(pr.title),
    state,
    draft: pr.draft === true,
    merged: pr.merged === true,
    headSha,
    headRef: asString(asRecord(pr.head).ref),
    baseRef: asString(asRecord(pr.base).ref),
    mergeable,
    mergeableState: asString(pr.mergeable_state),
    url: asString(pr.html_url),
  };
}

/**
 * Parse a GitHub `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` response
 * into the shared CommitCheck shape so the deploy check gate can evaluate it.
 */
export function parseCommitChecks(repository: string, sha: string, value: unknown): CommitCheck[] {
  const body = asRecord(value);
  const runs = Array.isArray(body.check_runs) ? body.check_runs : [];
  const out: CommitCheck[] = [];
  for (const entry of runs) {
    const run = asRecord(entry);
    const name = asString(run.name);
    if (!name) continue;
    out.push({
      repository: repository.toLowerCase(),
      branch: asString(asRecord(run.check_suite).head_branch),
      sha,
      name,
      status: asString(run.status),
      conclusion: asString(run.conclusion),
      url: asString(run.html_url),
      source: "check_run",
    });
  }
  return out;
}

export interface MergeGateInput {
  pr: PullRequestState;
  config: MergeApprovalsConfig;
  /** The exact head SHA the steward/approval pinned; the live PR must still match it. */
  requiredHeadSha: string;
  /** Observed check runs for the pinned SHA. */
  observed: CommitCheck[];
}

/**
 * Fail-closed merge gate. The PR is eligible only when EVERY condition holds:
 * open, non-draft, not already merged, base branch matches, live head matches
 * the pinned SHA, mergeable is computed true, and every required check
 * succeeded. Any unknown/missing value (e.g. mergeable null) disallows.
 */
export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
  const { pr, config, requiredHeadSha, observed } = input;
  const reasons: string[] = [];
  if (pr.state !== "open") reasons.push(`pull request is ${pr.state}, not open`);
  if (pr.draft) reasons.push("pull request is a draft");
  if (pr.merged) reasons.push("pull request is already merged");
  if (pr.baseRef !== config.baseBranch) {
    reasons.push(`base branch is ${pr.baseRef || "unknown"}, expected ${config.baseBranch}`);
  }
  if (pr.headSha !== requiredHeadSha) {
    reasons.push(`head sha ${pr.headSha} does not match pinned ${requiredHeadSha}`);
  }
  if (pr.mergeable !== true) {
    reasons.push(pr.mergeable === false ? "pull request has merge conflicts (not mergeable)" : "pull request mergeability is unknown");
  }
  const checks = evaluateCheckGate(config.requiredChecks, observed);
  if (!checks.satisfied) {
    reasons.push(`required checks not satisfied: ${checks.missing.join(", ") || "(none observed)"}`);
  }
  return { allowed: reasons.length === 0, reasons, checks };
}

/** Build the Human Operator merge-approval payload (distinct from deploy). */
export function buildMergeApprovalPayload(input: {
  pr: PullRequestState;
  config: MergeApprovalsConfig;
  issueId: string;
  reviewEvidence: unknown;
  gate: MergeGateResult;
}): Record<string, unknown> {
  const { pr, config, issueId, reviewEvidence, gate } = input;
  return {
    kind: MERGE_APPROVAL_KIND,
    repository: pr.repository,
    prNumber: pr.prNumber,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
    title: pr.title,
    url: pr.url,
    issueId,
    reviewEvidence,
    intendedAction: config.approvalTitle,
    requiredChecks: config.requiredChecks,
    checks: gate.checks.evidence,
    sourcePluginId: SOURCE_PLUGIN_ID,
  };
}

/** Idempotency key for the merge-request entity: repository + PR + exact head SHA. */
export function mergeRequestExternalId(repository: string, prNumber: number, headSha: string): string {
  return `merge:${repository}:${prNumber}:${headSha}`;
}

/**
 * Given the current (live) head SHA for a PR and the existing stored merge
 * requests for that PR, return the externalIds whose pinned SHA differs from
 * the live head — they are superseded and must never merge.
 */
export function selectSupersededMergeRequests(
  repository: string,
  prNumber: number,
  liveHeadSha: string,
  existing: Array<{ externalId: string | null; data?: Record<string, unknown> | null }>,
): string[] {
  return existing
    .filter((entity) => {
      const data = entity.data ?? {};
      return data.repository === repository && data.prNumber === prNumber && data.headSha !== liveHeadSha;
    })
    .map((entity) => entity.externalId ?? "")
    .filter((id) => id.length > 0);
}

// ---------------------------------------------------------------------------
// Merge dispatch outbox contract (parallel to the deploy dispatch outbox)
// ---------------------------------------------------------------------------

export interface MergeOutboxRecord {
  approvalId: string;
  sha: string;
  repository: string;
  prNumber: number;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
}

/** Idempotency key for the merge outbox entity: approvalId + exact SHA. */
export function mergeOutboxExternalId(approvalId: string, sha: string): string {
  return `merge-approval:${approvalId}:${sha}`;
}

/** Only `pending` records are retried; `sent` (merged) and `failed` are terminal. */
export function shouldAttemptMerge(record: MergeOutboxRecord): boolean {
  return record.status === "pending";
}

export interface MergeAttemptOutcome {
  ok: boolean;
  /** A terminal outcome (head changed / not mergeable / superseded) never retries. */
  terminal?: boolean;
  error?: string;
}

/**
 * Apply a drain attempt outcome. A terminal failure moves straight to `failed`
 * (no retry); a transient failure retries until the 5-attempt budget is
 * exhausted, after which it is `failed`. Success is `sent` (merged).
 */
export function applyMergeAttemptOutcome(record: MergeOutboxRecord, outcome: MergeAttemptOutcome): MergeOutboxRecord {
  if (outcome.ok) {
    return { ...record, status: "sent", attempts: record.attempts + 1, lastError: null };
  }
  const terminal = outcome.terminal === true || record.attempts + 1 >= 5;
  return {
    ...record,
    status: terminal ? "failed" : "pending",
    attempts: record.attempts + 1,
    lastError: outcome.error ?? "unknown error",
  };
}

/** `PUT /repos/{owner}/{repo}/pulls/{number}/merge` body. `sha` pins the exact revision. */
export function buildSquashMergeBody(headSha: string, approvalId: string, issueId: string): Record<string, unknown> {
  return {
    commit_title: `Merge pull request (squash) [approval ${approvalId}]`,
    commit_message: `Squash merge approved via Papercompany Human Operator approval ${approvalId}. Linked issue: ${issueId}.`,
    sha: headSha,
    merge_method: "squash",
  };
}
