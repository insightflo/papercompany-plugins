import assert from "node:assert/strict";
import { test } from "node:test";
import { readBridgeConfig } from "../src/config.ts";

function baseConfig(mergeApprovals, { stewardApiSecretRef = "STEWARD" } = {}) {
  return {
    webhookSecretRef: "SECRET",
    stewardApiSecretRef,
    shadowMode: true,
    repositories: [
      {
        repository: "acme/runtime",
        companyId: "c1",
        projectId: "p1",
        projectWorkspaceId: "w1",
        stewardAgentId: "a1",
        ...(mergeApprovals ? { mergeApprovals } : {}),
      },
    ],
  };
}

const validMerge = {
  baseBranch: "main",
  requiredChecks: ["verify"],
  approvalTitle: "Merge PR into main",
  githubApp: { appIdRef: "GITHUB_APP_ID", privateKeyRef: "GITHUB_APP_PRIVATE_KEY", installationRepository: "acme/runtime" },
};

test("accepts a valid mergeApprovals block with GitHub App credentials", () => {
  const { config, errors } = readBridgeConfig(baseConfig(validMerge));
  assert.deepEqual(errors, []);
  assert.equal(config?.stewardApiSecretRef, "STEWARD");
  assert.equal(config?.repositories[0].mergeApprovals?.baseBranch, "main");
  assert.deepEqual(config?.repositories[0].mergeApprovals?.requiredChecks, ["verify"]);
  assert.equal(config?.repositories[0].mergeApprovals?.githubApp.installationRepository, "acme/runtime");
});

test("lowercases the merge installation repository", () => {
  const merge = structuredClone(validMerge);
  merge.githubApp.installationRepository = "Acme/Runtime";
  const { config, errors } = readBridgeConfig(baseConfig(merge));
  assert.deepEqual(errors, []);
  assert.equal(config?.repositories[0].mergeApprovals?.githubApp.installationRepository, "acme/runtime");
});

test("rejects a mergeApprovals block missing required fields", () => {
  const broken = { baseBranch: "", requiredChecks: [], approvalTitle: "", githubApp: {} };
  const { errors } = readBridgeConfig(baseConfig(broken));
  assert.ok(errors.some((e) => e.includes("mergeApprovals.baseBranch is required")));
  assert.ok(errors.some((e) => e.includes("mergeApprovals.requiredChecks must list at least one check")));
  assert.ok(errors.some((e) => e.includes("mergeApprovals.approvalTitle is required")));
  assert.ok(errors.some((e) => e.includes("mergeApprovals.githubApp.appIdRef is required")));
  assert.ok(errors.some((e) => e.includes("mergeApprovals.githubApp.privateKeyRef is required")));
  assert.ok(errors.some((e) => e.includes("mergeApprovals.githubApp.installationRepository must use owner/name format")));
});

test("requires stewardApiSecretRef when any route configures mergeApprovals", () => {
  const { errors } = readBridgeConfig(baseConfig(validMerge, { stewardApiSecretRef: "" }));
  assert.ok(errors.some((e) => e.includes("stewardApiSecretRef is required when any repository configures mergeApprovals")));
});

test("does not require stewardApiSecretRef for a deploy-only route (compatibility)", () => {
  const deployOnly = {
    webhookSecretRef: "SECRET",
    shadowMode: true,
    repositories: [
      {
        repository: "acme/runtime",
        companyId: "c1",
        projectId: "p1",
        projectWorkspaceId: "w1",
        stewardAgentId: "a1",
        deployApprovals: {
          branch: "main",
          requiredChecks: ["verify"],
          approvalTitle: "Deploy main",
          dispatch: { endpointRef: "URL", tokenRef: "T", eventType: "deploy" },
        },
      },
    ],
  };
  const { config, errors } = readBridgeConfig(deployOnly);
  assert.deepEqual(errors, []);
  assert.equal(config?.stewardApiSecretRef, "");
  assert.equal(config?.repositories[0].mergeApprovals, undefined);
});
