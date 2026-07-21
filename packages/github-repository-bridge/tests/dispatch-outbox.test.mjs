import assert from "node:assert/strict";
import { test } from "node:test";
import {
  shouldAttemptDispatch,
  buildRepositoryDispatchBody,
  applyAttemptOutcome,
  outboxExternalId,
} from "../src/dispatch-outbox.ts";

function record(status, attempts = 0) {
  return {
    approvalId: "approval-1",
    sha: "deadbeef",
    repository: "acme/runtime",
    branch: "main",
    status,
    attempts,
    lastError: null,
    payload: { eventType: "deploy", repository: "acme/runtime", branch: "main", commit: "deadbeef", approvalId: "approval-1" },
  };
}

test("outboxExternalId is keyed by approvalId + exact SHA", () => {
  assert.equal(outboxExternalId("approval-1", "deadbeef"), "approval:approval-1:deadbeef");
  assert.notEqual(outboxExternalId("approval-1", "deadbeef"), outboxExternalId("approval-1", "cafebabe"));
});

test("shouldAttemptDispatch retries only pending records (sent and failed are not retried)", () => {
  assert.equal(shouldAttemptDispatch(record("pending")), true);
  assert.equal(shouldAttemptDispatch(record("sent")), false);
  assert.equal(shouldAttemptDispatch(record("failed")), false);
});

test("buildRepositoryDispatchBody wraps client_payload with sha and approvalId", () => {
  const body = buildRepositoryDispatchBody({
    eventType: "deploy",
    repository: "acme/runtime",
    branch: "main",
    commit: "deadbeef",
    approvalId: "approval-1",
  });
  assert.equal(body.event_type, "deploy");
  assert.deepEqual(body.client_payload, { approvalId: "approval-1", sha: "deadbeef", repository: "acme/runtime", branch: "main" });
});

test("applyAttemptOutcome marks sent on success and bumps attempts on failure", () => {
  const ok = applyAttemptOutcome(record("pending"), { ok: true });
  assert.equal(ok.status, "sent");
  assert.equal(ok.attempts, 1);
  assert.equal(ok.lastError, null);

  const retry = applyAttemptOutcome(record("pending"), { ok: false, error: "HTTP 500" });
  assert.equal(retry.status, "pending");
  assert.equal(retry.attempts, 1);
  assert.equal(retry.lastError, "HTTP 500");
});

test("applyAttemptOutcome transitions to failed after the retry budget", () => {
  const failed = applyAttemptOutcome(record("pending", 4), { ok: false, error: "boom" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 5);
});
