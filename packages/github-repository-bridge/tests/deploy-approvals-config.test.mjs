import assert from "node:assert/strict";
import { test } from "node:test";
import { readBridgeConfig } from "../src/config.ts";

function baseConfig(deployApprovals) {
  return {
    webhookSecretRef: "SECRET",
    shadowMode: true,
    repositories: [
      {
        repository: "acme/runtime",
        companyId: "c1",
        projectId: "p1",
        projectWorkspaceId: "w1",
        stewardAgentId: "a1",
        ...(deployApprovals ? { deployApprovals } : {}),
      },
    ],
  };
}

const validDeploy = {
  branch: "main",
  requiredChecks: ["verify"],
  approvalTitle: "Deploy acme/runtime main",
  dispatch: { endpointRef: "DISPATCH_URL", tokenRef: "DISPATCH_TOKEN", eventType: "deploy" },
};

test("accepts an optional valid deployApprovals block", () => {
  const { config, errors } = readBridgeConfig(baseConfig(validDeploy));
  assert.deepEqual(errors, []);
  assert.equal(config?.repositories[0].deployApprovals?.branch, "main");
  assert.deepEqual(config?.repositories[0].deployApprovals?.requiredChecks, ["verify"]);
});

test("still accepts a route with no deployApprovals (mirror-only)", () => {
  const { config, errors } = readBridgeConfig(baseConfig(undefined));
  assert.deepEqual(errors, []);
  assert.equal(config?.repositories[0].deployApprovals, undefined);
});

test("rejects a deployApprovals block missing required fields", () => {
  const { errors } = readBridgeConfig(baseConfig({ branch: "", requiredChecks: [], approvalTitle: "", dispatch: {} }));
  assert.ok(errors.some((e) => e.includes("deployApprovals.branch is required")));
  assert.ok(errors.some((e) => e.includes("deployApprovals.requiredChecks must list at least one check")));
  assert.ok(errors.some((e) => e.includes("deployApprovals.approvalTitle is required")));
  assert.ok(errors.some((e) => e.includes("deployApprovals.dispatch.endpointRef is required")));
  assert.ok(errors.some((e) => e.includes("deployApprovals.dispatch.tokenRef is required")));
  assert.ok(errors.some((e) => e.includes("deployApprovals.dispatch.eventType is required")));
});
