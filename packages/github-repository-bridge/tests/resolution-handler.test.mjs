import assert from "node:assert/strict";
import { test } from "node:test";
import { decideResolutionAction, SELF_PLUGIN_ID } from "../src/resolution-handler.ts";

function event(overrides = {}) {
  return {
    approvalId: "approval-1",
    decision: "approved",
    status: "approved",
    type: "external_automation",
    sourcePluginId: SELF_PLUGIN_ID,
    ...overrides,
  };
}

test("approve for this plugin enqueues a dispatch", () => {
  const decision = decideResolutionAction(event());
  assert.equal(decision.enqueueDispatch, true);
});

test("reject never dispatches", () => {
  const decision = decideResolutionAction(event({ decision: "rejected", status: "rejected" }));
  assert.equal(decision.enqueueDispatch, false);
});

test("a foreign plugin's approval never dispatches", () => {
  const decision = decideResolutionAction(event({ sourcePluginId: "other.plugin" }));
  assert.equal(decision.enqueueDispatch, false);
});

test("a null sourcePluginId never dispatches (must originate from this plugin)", () => {
  const decision = decideResolutionAction(event({ sourcePluginId: null }));
  assert.equal(decision.enqueueDispatch, false);
});

test("a non-deploy approval type never dispatches", () => {
  const decision = decideResolutionAction(event({ type: "hire_agent" }));
  assert.equal(decision.enqueueDispatch, false);
});

test("an inconsistent non-approved status never dispatches", () => {
  const decision = decideResolutionAction(event({ status: "pending" }));
  assert.equal(decision.enqueueDispatch, false);
});

test("superseded (non-approved) never dispatches", () => {
  const decision = decideResolutionAction(event({ decision: "superseded", status: "superseded" }));
  assert.equal(decision.enqueueDispatch, false);
});
