import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideRevisionAdvance,
  decideWake,
  requiredChecksSatisfied,
  isVerdictFresh,
  buildWakeContext,
  buildWakePrompt,
  buildMirroredComment,
  rereviewStateExternalId,
  rereviewConfigFromMerge,
  isExactSha,
} from "../src/rereview.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function delivery(overrides = {}) {
  return {
    repository: "acme/runtime",
    prNumber: 7,
    headSha: SHA,
    baseRef: "main",
    isCheckDelivery: false,
    checks: [],
    comment: null,
    change: {},
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    revision: SHA,
    wokenRevision: null,
    checksSatisfied: true,
    requiredChecks: ["verify"],
    lastWakeAt: null,
    lastWakeCommentId: null,
    ...overrides,
  };
}

test("rereviewConfigFromMerge returns the check gate from a mergeApprovals config", () => {
  assert.deepEqual(rereviewConfigFromMerge({ baseBranch: "main", requiredChecks: ["verify", "lint"], approvalTitle: "x", githubApp: {} }), {
    baseBranch: "main",
    requiredChecks: ["verify", "lint"],
  });
  assert.equal(rereviewConfigFromMerge(undefined), null);
});

test("decideRevisionAdvance only advances on an exact new head SHA", () => {
  assert.equal(decideRevisionAdvance(null, delivery()).advance, true);
  assert.equal(decideRevisionAdvance(null, delivery({ headSha: SHA })).advance, true);
  // Same head as tracked: no advance (coalesced).
  assert.equal(decideRevisionAdvance(state(), delivery()).advance, false);
  // Not an exact 40-char hex SHA: no advance.
  assert.equal(decideRevisionAdvance(null, delivery({ headSha: "abc123" })).advance, false);
  // A check delivery with no conclusions never advances.
  assert.equal(decideRevisionAdvance(null, delivery({ isCheckDelivery: true, checks: [] })).advance, false);
});

test("decideWake invokes the steward exactly once per eligible revision", () => {
  // Fresh eligible revision wakes.
  assert.equal(decideWake(state(), delivery()).wake, true);
  // Already woken for this revision: no second wake (dedupe).
  assert.equal(decideWake(state({ wokenRevision: SHA }), delivery()).wake, false);
  // Check deliveries never wake directly (no wake storm).
  assert.equal(decideWake(state(), delivery({ isCheckDelivery: true })).wake, false);
  // Not the tracked revision: no wake.
  assert.equal(decideWake(state({ revision: OTHER_SHA }), delivery()).wake, false);
  // Checks not satisfied: no wake.
  assert.equal(decideWake(state({ checksSatisfied: false }), delivery()).wake, false);
});

test("requiredChecksSatisfied requires every required check to conclude success", () => {
  assert.equal(requiredChecksSatisfied(["verify"], [{ name: "verify", conclusion: "success" }]), true);
  assert.equal(requiredChecksSatisfied(["verify", "lint"], [{ name: "verify", conclusion: "success" }, { name: "lint", conclusion: "success" }]), true);
  assert.equal(requiredChecksSatisfied(["verify"], [{ name: "verify", conclusion: "failure" }]), false);
  assert.equal(requiredChecksSatisfied(["verify"], [{ name: "verify", conclusion: "neutral" }]), false);
  assert.equal(requiredChecksSatisfied(["verify"], []), false);
});

test("isVerdictFresh rejects a stale verdict (older head or never-woken head)", () => {
  assert.equal(isVerdictFresh(state({ wokenRevision: SHA }), SHA).fresh, true);
  // Verdict head differs from the tracked revision.
  assert.equal(isVerdictFresh(state({ wokenRevision: SHA }), OTHER_SHA).fresh, false);
  // Steward was never woken for the tracked revision.
  assert.equal(isVerdictFresh(state(), SHA).fresh, false);
  assert.equal(isVerdictFresh(null, SHA).fresh, false);
});

test("buildWakeContext carries exact issue/comment/task context for an issue-linked run", () => {
  const context = buildWakeContext({ repository: "acme/runtime", prNumber: 7, headSha: SHA, issueId: "iss-1", commentId: "99" });
  assert.equal(context.issueId, "iss-1");
  assert.equal(context.commentId, "99");
  assert.equal(context.taskKey, "issue:iss-1");
  assert.equal(context.headSha, SHA);
  const noComment = buildWakeContext({ repository: "acme/runtime", prNumber: 7, headSha: SHA, issueId: "iss-1" });
  assert.equal(noComment.commentId, undefined);
});

test("buildWakePrompt mentions the exact head and the mirrored comment when present", () => {
  const prompt = buildWakePrompt({ repository: "acme/runtime", prNumber: 7, headSha: SHA, commentId: "99" });
  assert.match(prompt, new RegExp(SHA));
  assert.match(prompt, /comment id 99/);
  assert.match(prompt, /VERDICT|PASS|REQUEST_CHANGES/);
});

test("buildMirroredComment mirrors only non-bridge GitHub comments (prevents comment loops)", () => {
  const mirrored = buildMirroredComment({
    repository: "acme/runtime", objectKind: "pull", objectNumber: 7, externalKey: "pull:7",
    action: "created", title: "t", body: "", state: "open", url: "u", revision: SHA,
    comment: { id: "1", author: "octocat", body: "Please fix", url: "u#c1", updatedAt: "t" },
  });
  assert.ok(mirrored?.includes("octocat"));
  // A bridge-origin comment (containing the source marker) is never re-mirrored.
  const bridgeComment = buildMirroredComment({
    repository: "acme/runtime", objectKind: "pull", objectNumber: 7, externalKey: "pull:7",
    action: "created", title: "t", body: "", state: "open", url: "u", revision: SHA,
    comment: { id: "2", author: "steward", body: "<!-- papercompany-github-bridge:source=github --> evidence", url: "u#c2", updatedAt: "t" },
  });
  assert.equal(bridgeComment, null);
  assert.equal(buildMirroredComment({} ), null);
});

test("rereviewStateExternalId is keyed by repository and PR", () => {
  assert.equal(rereviewStateExternalId("acme/runtime", 7), "rereview:acme/runtime:7");
  assert.equal(rereviewStateExternalId("Acme/Runtime", 7), "rereview:acme/runtime:7");
});

test("isExactSha validates a 40-char hex SHA and normalizes case", () => {
  assert.equal(isExactSha(SHA), true);
  assert.equal(isExactSha("A".repeat(40)), true);
  assert.equal(isExactSha("abc"), false);
  assert.equal(isExactSha("g".repeat(40)), false);
});
