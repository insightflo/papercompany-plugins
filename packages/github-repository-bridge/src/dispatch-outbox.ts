/**
 * Retryable dispatch outbox contract. Records are plugin-owned entities keyed
 * by approval id. A record transitions pending -> sent (or failed). Repeated
 * resolution events and repeated drains never produce a second dispatch for the
 * same approval id + SHA because a `sent` record short-circuits the drain.
 */
import type { DispatchPayload } from "./deploy-checks.js";

export const OUTBOX_ENTITY = "github-deploy-dispatch";
export const OBSERVATION_ENTITY = "github-deploy-approval";

export interface OutboxRecord {
  approvalId: string;
  sha: string;
  repository: string;
  branch: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
  payload: DispatchPayload;
}

/** Idempotency key for the outbox entity: approvalId + exact SHA. */
export function outboxExternalId(approvalId: string, sha: string): string {
  return `approval:${approvalId}:${sha}`;
}

/**
 * Decide whether a drain should attempt the dispatch. Only `pending` records
 * are retried; a `sent` record is never re-dispatched, and a `failed` record
 * (exhausted retry budget) is not retried again.
 */
export function shouldAttemptDispatch(record: OutboxRecord): boolean {
  return record.status === "pending";
}

/** repository_dispatch request body sent to Operations. */
export function buildRepositoryDispatchBody(payload: DispatchPayload): Record<string, unknown> {
  return {
    event_type: payload.eventType,
    client_payload: {
      approvalId: payload.approvalId,
      sha: payload.commit,
      repository: payload.repository,
      branch: payload.branch,
    },
  };
}

/** Apply a drain attempt outcome to a record immutably. */
export function applyAttemptOutcome(
  record: OutboxRecord,
  outcome: { ok: boolean; error?: string },
): OutboxRecord {
  return {
    ...record,
    status: outcome.ok ? "sent" : record.attempts + 1 >= 5 ? "failed" : "pending",
    attempts: record.attempts + 1,
    lastError: outcome.ok ? null : outcome.error ?? "unknown error",
  };
}
