import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePullRequest,
  parseCommitChecks,
  evaluateMergeGate,
  buildMergeApprovalPayload,
  selectSupersededMergeRequests,
  mergeRequestExternalId,
  mergeOutboxExternalId,
  shouldAttemptMerge,
  applyMergeAttemptOutcome,
  buildSquashMergeBody,
  MERGE_REQUEST_ENTITY,
  MERGE_OUTBOX_ENTITY,
} from "../src/merge-checks.ts";

const SHA = "a".repeat(40);
const mergeConfig = {
  baseBranch: "main",
  requiredChecks: ["verify"],
  approvalTitle: "Merge PR into main",
  githubApp: { appIdRef: "A", privateKeyRef: "K", installationRepository: "acme/runtime" },
};

function pr(overrides = {}) {
  return {
    repository: "acme/runtime",
    prNumber: 7,
    title: "Ship feature",
    state: "open",
    draft: false,
    merged: false,
    headSha: SHA,
    headRef: "feature",
    baseRef: "main",
    mergeable: true,
    mergeableState: "clean",
    url: "https://github.com/acme/runtime/pull/7",
    ...overrides,
  };
}

function check(name, conclusion = "success") {
  return { repository: "acme/runtime", sha: SHA, name, status: "completed", conclusion, url: "u", source: "check_run" };
}

function gate(prOverrides = {}, observed = [check("verify")]) {
  return evaluateMergeGate({ pr: pr(prOverrides), config: mergeConfig, requiredHeadSha: SHA, observed });
}

test("parsePullRequest maps GitHub pull-request identity and mergeability", () => {
  const parsed = parsePullRequest("Acme/Runtime", {
    number: 7,
    title: "Ship",
    state: "open",
    draft: false,
    merged: false,
    head: { sha: SHA, ref: "feature" },
    base: { ref: "main" },
    mergeable: true,
    mergeable_state: "clean",
    html_url: "u",
  });
  assert.equal(parsed.repository, "acme/runtime"); // normalized to lowercase
  assert.equal(parsed.prNumber, 7);
  assert.equal(parsed.headSha, SHA);
  assert.equal(parsed.headRef, "feature");
  assert.equal(parsed.baseRef, "main");
  assert.equal(parsed.mergeable, true);
  assert.equal(parsed.mergeableState, "clean");
  assert.equal(parsed.state, "open");
});

test("parsePullRequest rejects responses missing PR identity", () => {
  assert.equal(parsePullRequest("acme/runtime", { state: "open" }), null);
  assert.equal(parsePullRequest("acme/runtime", { number: 7, head: {} }), null);
});

test("parseCommitChecks maps a check-runs listing to the shared CommitCheck shape", () => {
  const out = parseCommitChecks("acme/runtime", SHA, {
    check_runs: [
      { name: "verify", status: "completed", conclusion: "success", html_url: "u", check_suite: { head_branch: "feature" } },
      { name: "", status: "completed", conclusion: "success", html_url: "u" }, // dropped: no name
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "check_run");
  assert.equal(out[0].conclusion, "success");
});

test("evaluateMergeGate allows a fully passing PR at the pinned head", () => {
  assert.equal(gate().allowed, true);
  assert.deepEqual(gate().reasons, []);
});

test("evaluateMergeGate is fail-closed for a closed PR", () => {
  const result = gate({ state: "closed" });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => /not open/.test(r)));
});

test("evaluateMergeGate is fail-closed for a draft PR", () => {
  const result = gate({ draft: true });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => /draft/.test(r)));
});

test("evaluateMergeGate is fail-closed for an already-merged PR", () => {
  const result = gate({ merged: true });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => /already merged/.test(r)));
});

test("evaluateMergeGate is fail-closed for the wrong base branch", () => {
  const result = gate({ baseRef: "develop" });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => /base branch is develop/.test(r)));
});

test("evaluateMergeGate is fail-closed when the live head differs from the pinned SHA", () => {
  const result = gate({ headSha: "b".repeat(40) });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => /does not match pinned/.test(r)));
});

test("evaluateMergeGate is fail-closed when mergeable is unknown (null)", () => {
  const result = gate({ mergeable: null, mergeableState: "unknown" });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => /unknown/.test(r)));
});

test("evaluateMergeGate is fail-closed when mergeable is false", () => {
  const result = gate({ mergeable: false, mergeableState: "dirty" });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => /conflicts/.test(r)));
});

test("evaluateMergeGate is fail-closed when a required check is missing or failing", () => {
  assert.equal(gate({}, []).allowed, false);
  assert.equal(gate({}, [check("verify", "failure")]).allowed, false);
  assert.ok(gate({}, [check("verify", "failure")]).reasons.some((r) => /required checks not satisfied/.test(r)));
});

test("buildMergeApprovalPayload stamps the merge kind and exact head", () => {
  const payload = buildMergeApprovalPayload({
    pr: pr(),
    config: mergeConfig,
    issueId: "iss-1",
    reviewEvidence: { verdict: "pass" },
    gate: gate(),
  });
  assert.equal(payload.kind, "merge");
  assert.equal(payload.prNumber, 7);
  assert.equal(payload.headSha, SHA);
  assert.equal(payload.issueId, "iss-1");
  assert.equal(payload.sourcePluginId, "insightflo.github-repository-bridge");
  assert.deepEqual(payload.requiredChecks, ["verify"]);
});

test("mergeRequestExternalId is keyed by repository + PR + exact head", () => {
  assert.equal(mergeRequestExternalId("acme/runtime", 7, SHA), `merge:acme/runtime:7:${SHA}`);
  assert.notEqual(mergeRequestExternalId("acme/runtime", 7, SHA), mergeRequestExternalId("acme/runtime", 7, "b".repeat(40)));
});

test("selectSupersededMergeRequests marks same-PR requests pinned to a different head", () => {
  const oldSha = "0".repeat(40);
  const existing = [
    { externalId: mergeRequestExternalId("acme/runtime", 7, oldSha), data: { repository: "acme/runtime", prNumber: 7, headSha: oldSha } },
    { externalId: mergeRequestExternalId("acme/runtime", 7, SHA), data: { repository: "acme/runtime", prNumber: 7, headSha: SHA } },
    { externalId: mergeRequestExternalId("acme/runtime", 8, SHA), data: { repository: "acme/runtime", prNumber: 8, headSha: SHA } },
  ];
  assert.deepEqual(selectSupersededMergeRequests("acme/runtime", 7, SHA, existing), [
    mergeRequestExternalId("acme/runtime", 7, oldSha),
  ]);
});

test("mergeOutboxExternalId is keyed by approvalId + exact SHA", () => {
  assert.equal(mergeOutboxExternalId("ap-1", SHA), `merge-approval:ap-1:${SHA}`);
});

test("shouldAttemptMerge retries only pending records", () => {
  assert.equal(shouldAttemptMerge({ status: "pending" }), true);
  assert.equal(shouldAttemptMerge({ status: "sent" }), false);
  assert.equal(shouldAttemptMerge({ status: "failed" }), false);
});

test("applyMergeAttemptOutcome marks sent on success and records the error on failure", () => {
  const ok = applyMergeAttemptOutcome({ status: "pending", attempts: 0 }, { ok: true });
  assert.equal(ok.status, "sent");
  assert.equal(ok.attempts, 1);
  assert.equal(ok.lastError, null);

  const retry = applyMergeAttemptOutcome({ status: "pending", attempts: 0 }, { ok: false, error: "HTTP 500" });
  assert.equal(retry.status, "pending");
  assert.equal(retry.attempts, 1);
  assert.equal(retry.lastError, "HTTP 500");
});

test("applyMergeAttemptOutcome treats a terminal outcome as failed immediately", () => {
  const terminal = applyMergeAttemptOutcome({ status: "pending", attempts: 0 }, { ok: false, terminal: true, error: "head moved" });
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.attempts, 1);
});

test("applyMergeAttemptOutcome transitions to failed after the retry budget", () => {
  const failed = applyMergeAttemptOutcome({ status: "pending", attempts: 4 }, { ok: false, error: "boom" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 5);
});

test("buildSquashMergeBody pins the exact SHA and requests a squash merge", () => {
  const body = buildSquashMergeBody(SHA, "ap-1", "iss-1");
  assert.equal(body.sha, SHA);
  assert.equal(body.merge_method, "squash");
  assert.ok(typeof body.commit_title === "string");
});

test("merge entity types are namespaced distinctly from the deploy entities", () => {
  assert.equal(MERGE_REQUEST_ENTITY, "github-merge-request");
  assert.equal(MERGE_OUTBOX_ENTITY, "github-merge-dispatch");
});
