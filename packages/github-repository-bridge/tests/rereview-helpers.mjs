/**
 * Shared test harness helpers for the structured re-review loop tests. Keeps
 * each test file under the 300-line split.
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.ts";
import plugin from "../src/worker.ts";

export const SHA = "a".repeat(40);
export const NEW_SHA = "b".repeat(40);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });

export const route = {
  repository: "acme/runtime",
  companyId: "c1",
  projectId: "p1",
  projectWorkspaceId: "w1",
  stewardAgentId: "a1",
  mergeApprovals: {
    baseBranch: "main",
    requiredChecks: ["verify"],
    approvalTitle: "Merge PR #7 into main",
    githubApp: { appIdRef: "APP_ID", privateKeyRef: "PRIVATE_KEY", installationRepository: "acme/runtime" },
  },
};

export const config = { webhookSecretRef: "S", stewardApiSecretRef: "STEWARD", shadowMode: true, repositories: [route] };

export function webhook(eventName, deliveryId, payload, secret = "resolved:S") {
  const rawBody = JSON.stringify(payload);
  return {
    endpointKey: "github",
    requestId: `request-${deliveryId}`,
    rawBody,
    parsedBody: payload,
    headers: {
      "x-github-event": eventName,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
    },
  };
}

export function pullPayload(action, headSha = SHA) {
  return {
    action,
    repository: { full_name: route.repository },
    pull_request: {
      number: 7,
      title: "Ship feature",
      body: null,
      state: "open",
      draft: false,
      html_url: `https://github.com/${route.repository}/pull/7`,
      updated_at: "2026-08-01T00:00:00Z",
      head: { sha: headSha, ref: "feature" },
      base: { ref: "main" },
    },
  };
}

export function checkPayload(headSha = SHA, conclusion = "success", name = "verify") {
  return {
    action: "completed",
    repository: { full_name: route.repository },
    check_run: {
      id: 77,
      name,
      status: "completed",
      conclusion,
      head_sha: headSha,
      html_url: `https://github.com/${route.repository}/check/77`,
      pull_requests: [{ number: 7 }],
    },
  };
}

export function checksJson(conclusions = { verify: "success" }) {
  return {
    check_runs: Object.entries(conclusions).map(([name, conclusion]) => ({
      name,
      status: "completed",
      conclusion,
      html_url: "u",
      check_suite: { head_branch: "feature" },
    })),
  };
}

export function githubHttp({ pr = pullPayload("synchronize", SHA).pull_request, checks = checksJson(), onCall } = {}) {
  return {
    async fetch(url, init) {
      if (onCall) onCall(url, init);
      const headers = { "content-type": "application/json" };
      if (url.endsWith("/installation")) return new Response(JSON.stringify({ id: 123 }), { status: 200, headers });
      if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "app-token" }), { status: 201, headers });
      if (/\/commits\/[^/]+\/check-runs/.test(url)) return new Response(JSON.stringify(checks), { status: 200, headers });
      if (/\/issues\/\d+\/comments$/.test(url)) return new Response(JSON.stringify({ id: 1 }), { status: 201, headers });
      if (/\/pulls\/\d+$/.test(url)) return new Response(JSON.stringify(pr), { status: 200, headers });
      return new Response(null, { status: 404 });
    },
  };
}

export function signedReviewInput(body) {
  const rawBody = JSON.stringify(body);
  return {
    endpointKey: "steward-review-result",
    requestId: "r1",
    rawBody,
    parsedBody: JSON.parse(rawBody),
    headers: { "x-pc-signature-256": `sha256=${createHmac("sha256", "resolved:STEWARD").update(rawBody).digest("hex")}` },
  };
}

export async function setupHarness({ http = githubHttp() } = {}) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    projects: [{ id: route.projectId, companyId: route.companyId, name: "Platform" }],
    agents: [{ id: route.stewardAgentId, companyId: route.companyId, status: "idle", name: "Steward" }],
  });
  // The GitHub App path needs a real RSA private key to mint the installation token.
  harness.ctx.secrets = {
    async resolve(ref) {
      const resolved = { APP_ID: "12345", PRIVATE_KEY: privateKeyPem };
      return resolved[ref] ?? `resolved:${ref}`;
    },
  };
  // Seed the linked issue + link entity as the main bridge would after the first PR open.
  const issue = await harness.ctx.issues.create({
    companyId: route.companyId,
    projectId: route.projectId,
    title: "[acme/runtime #7] Ship feature",
    status: "in_review",
    assigneeAgentId: route.stewardAgentId,
  });
  await harness.ctx.entities.upsert({
    entityType: "github-object-link",
    scopeKind: "project_workspace",
    scopeId: route.projectWorkspaceId,
    externalId: `${route.repository}:pull:7`,
    title: "acme/runtime pull:7",
    status: "open",
    data: { issueId: issue.id, repository: route.repository, objectKind: "pull", objectNumber: 7, revision: SHA },
  });
  harness.ctx.http = http;
  await plugin.definition.setup(harness.ctx);
  return { harness, issue };
}

export async function listIssues(harness) {
  return harness.ctx.issues.list({ companyId: route.companyId });
}

export function reviewIssueOf(issues, linkedIssueId) {
  return issues.find((candidate) => candidate.id !== linkedIssueId);
}

export async function establishReviewIssue(harness, headSha = NEW_SHA) {
  await plugin.definition.onWebhook(webhook("pull_request", "d-wake", pullPayload("synchronize", headSha)));
  const issues = await listIssues(harness);
  const linked = issues.find((candidate) => !candidate.title.includes("Review head"));
  return reviewIssueOf(issues, linked?.id);
}
