import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCheckSatisfied,
  evaluateCheckGate,
  buildApprovalPayload,
  selectSupersededShas,
  buildDispatchPayload,
  DEPLOY_APPROVAL_TYPE,
} from "../src/deploy-checks.ts";

const SHA = "deadbeefcafebabe1234567890abcdefdeadbeef";

function check(name, conclusion, source = "check_run", status = "completed") {
  return { repository: "acme/runtime", sha: SHA, name, status, conclusion, url: "u", source };
}

test("isCheckSatisfied requires completed + success", () => {
  assert.equal(isCheckSatisfied(check("a", "success")), true);
  assert.equal(isCheckSatisfied(check("a", "failure")), false);
  assert.equal(isCheckSatisfied(check("a", "", "check_run", "in_progress")), false);
});

test("evaluateCheckGate is satisfied only when every required check succeeded", () => {
  const ok = evaluateCheckGate(["verify", "build"], [check("verify", "success"), check("build", "success")]);
  assert.equal(ok.satisfied, true);
  assert.deepEqual(ok.missing, []);
});

test("evaluateCheckGate reports missing and failed checks and stays unsatisfied", () => {
  const result = evaluateCheckGate(["verify", "build", "test"], [check("verify", "success"), check("build", "failure")]);
  assert.equal(result.satisfied, false);
  assert.ok(result.missing.includes("build"));
  assert.ok(result.missing.includes("test"));
});

test("buildApprovalPayload records the exact commit and required checks, no A1/host values", () => {
  const gate = evaluateCheckGate(["verify"], [check("verify", "success")]);
  const payload = buildApprovalPayload({
    push: { repository: "acme/runtime", branch: "main", ref: "refs/heads/main", before: "old", after: SHA, commitMessage: "ship it", commitAuthor: "Alice", url: "https://example/c" },
    config: { branch: "main", requiredChecks: ["verify"], approvalTitle: "Deploy acme/runtime main", dispatch: { endpointRef: "s", tokenRef: "t", eventType: "deploy" } },
    checks: gate,
  });
  assert.equal(payload.commit, SHA);
  assert.equal(payload.branch, "main");
  assert.equal(payload.repository, "acme/runtime");
  assert.equal(payload.intendedAction, "Deploy acme/runtime main");
  assert.deepEqual(payload.requiredChecks, ["verify"]);
  assert.equal(payload.sourcePluginId, "insightflo.github-repository-bridge");
  assert.equal(DEPLOY_APPROVAL_TYPE, "external_automation");
});

test("selectSupersededShas marks older pending SHAs for the same branch", () => {
  assert.deepEqual(selectSupersededShas("newsha", ["oldsha", "newsha", "other"]), ["oldsha", "other"]);
  assert.deepEqual(selectSupersededShas("only", ["only"]), []);
});

test("buildDispatchPayload carries the approval id and exact SHA", () => {
  const dispatch = buildDispatchPayload({
    config: { branch: "main", requiredChecks: ["verify"], approvalTitle: "x", dispatch: { endpointRef: "s", tokenRef: "t", eventType: "deploy" } },
    push: { repository: "acme/runtime", branch: "main", ref: "", before: "", after: SHA, commitMessage: "", commitAuthor: "", url: "" },
    approvalId: "approval-123",
  });
  assert.equal(dispatch.eventType, "deploy");
  assert.equal(dispatch.commit, SHA);
  assert.equal(dispatch.approvalId, "approval-123");
});
