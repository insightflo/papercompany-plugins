import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.ts";
import plugin from "../src/worker.ts";
import { rereviewStateExternalId } from "../src/rereview.ts";
import { processStewardReviewResult, parseStewardReviewResult } from "../src/merge-approvals.ts";

const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });

const route = {
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

const config = { webhookSecretRef: "S", stewardApiSecretRef: "STEWARD", shadowMode: true, repositories: [route] };

function webhook(eventName, deliveryId, payload, secret = "resolved:S") {
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

function pullPayload(action, headSha = SHA) {
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

function checkPayload(headSha = SHA, conclusion = "success") {
  return {
    action: "completed",
    repository: { full_name: route.repository },
    check_run: {
      id: 77,
      name: "verify",
      status: "completed",
      conclusion,
      head_sha: headSha,
      html_url: `https://github.com/${route.repository}/check/77`,
      pull_requests: [{ number: 7 }],
    },
  };
}

function checksJson(conclusions = { verify: "success" }) {
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

function githubHttp({ pr = pullPayload("synchronize", SHA).pull_request, checks = checksJson(), onCall } = {}) {
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

function signedReviewInput(body) {
  const rawBody = JSON.stringify(body);
  return {
    endpointKey: "steward-review-result",
    requestId: "r1",
    rawBody,
    parsedBody: JSON.parse(rawBody),
    headers: { "x-pc-signature-256": `sha256=${createHmac("sha256", "resolved:STEWARD").update(rawBody).digest("hex")}` },
  };
}

async function setupHarness({ http = githubHttp() } = {}) {
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
    data: { issueId: issue.id, repository: route.repository, objectKind: "pull", objectNumber: 7 },
  });
  harness.ctx.http = http;
  await plugin.definition.setup(harness.ctx);
  return { harness, issue };
}

async function establishWokenRevision(harness) {
  await plugin.definition.onWebhook(webhook("pull_request", "d-wake", pullPayload("synchronize", NEW_SHA)));
  assert.equal(harness.wakes.length, 1);
}

test("manifest declares the structured review-result webhook", () => {
  assert.equal(pluginManifestV1Schema.safeParse(manifest).success, true);
  const keys = manifest.webhooks.map((w) => w.endpointKey);
  assert.ok(keys.includes("steward-review-result"), "steward-review-result webhook must be declared");
  assert.ok(keys.includes("steward-merge-request"), "steward-merge-request webhook remains declared");
});

test("parseStewardReviewResult accepts PASS and REQUEST_CHANGES and rejects incomplete/stale-shaped bodies", () => {
  const pass = parseStewardReviewResult({ repository: "Acme/Runtime", prNumber: 7, headSha: SHA, verdict: "pass", issueId: "iss-1", evidence: { v: 1 } });
  assert.equal(pass?.repository, "acme/runtime");
  assert.equal(pass?.verdict, "pass");
  assert.equal(pass?.issueId, "iss-1");
  const rc = parseStewardReviewResult({ repository: "acme/runtime", prNumber: 7, headSha: SHA, decision: "request_changes", evidence: "fix it" });
  assert.equal(rc?.verdict, "request_changes");
  assert.equal(parseStewardReviewResult({ repository: "acme/runtime", prNumber: 7, headSha: SHA, verdict: "maybe" }), null);
  assert.equal(parseStewardReviewResult({ repository: "acme/runtime", prNumber: 7, headSha: "abc", verdict: "pass" }), null);
});

test("same-issue reuse: a new PR head never creates a second linked issue", async () => {
  const { harness, issue } = await setupHarness();
  await plugin.definition.onWebhook(webhook("pull_request", "d1", pullPayload("synchronize", NEW_SHA)));

  const issues = await harness.ctx.issues.list({ companyId: route.companyId });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, issue.id);
  assert.equal(issues[0].status, "todo"); // moved back to reviewable
  const links = await harness.ctx.entities.list({ entityType: "github-object-link" });
  assert.equal(links.length, 1);
});

test("comment-before-wake: the GitHub comment is mirrored to the issue before the steward wake", async () => {
  const { harness } = await setupHarness();
  harness.ctx.http = githubHttp();

  // A GitHub PR comment arrives as issue_comment and is mirrored BEFORE the wake.
  const commentPayload = {
    action: "created",
    repository: { full_name: route.repository },
    issue: {
      number: 7,
      title: "Ship feature",
      body: null,
      state: "open",
      html_url: `https://github.com/${route.repository}/pull/7`,
      updated_at: "2026-08-01T00:00:00Z",
      pull_request: { url: `https://github.com/${route.repository}/pull/7` },
    },
    comment: {
      id: 99,
      body: "Please fix the gate",
      html_url: `https://github.com/${route.repository}/pull/7#issuecomment-99`,
      updated_at: "2026-08-01T00:01:00Z",
      user: { login: "octocat" },
    },
  };
  await plugin.definition.onWebhook(webhook("issue_comment", "d-comment", commentPayload));
  await plugin.definition.onWebhook(webhook("pull_request", "d2", pullPayload("synchronize", NEW_SHA)));

  const [issue] = await harness.ctx.issues.list({ companyId: route.companyId });
  const comments = await harness.ctx.issues.listComments(issue.id, route.companyId);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /Please fix the gate/);
  // The wake carried the exact issue/task context for an issue-linked run.
  assert.equal(harness.wakes.length, 1);
  assert.equal(harness.wakes[0].context.issueId, issue.id);
  assert.equal(harness.wakes[0].context.headSha, NEW_SHA);
  assert.equal(harness.wakes[0].context.taskKey, `issue:${issue.id}`);
});

test("no check-event wake storm: repeated check deliveries never wake the steward", async () => {
  const { harness } = await setupHarness();
  await plugin.definition.onWebhook(webhook("pull_request", "d3", pullPayload("synchronize", NEW_SHA)));
  assert.equal(harness.wakes.length, 1);

  // A storm of check/workflow deliveries for the same head: no additional wake.
  for (let i = 0; i < 10; i += 1) {
    await plugin.definition.onWebhook(webhook("check_run", `d-check-${i}`, checkPayload(NEW_SHA, "success")));
  }
  assert.equal(harness.wakes.length, 1, "check deliveries must not wake the steward");
});

test("latest-SHA dedupe: only the newest exact head wakes the steward once", async () => {
  const { harness } = await setupHarness();
  await plugin.definition.onWebhook(webhook("pull_request", "d4", pullPayload("synchronize", SHA)));
  assert.equal(harness.wakes.length, 1);
  // Redelivery of the same head: coalesced, no wake.
  await plugin.definition.onWebhook(webhook("pull_request", "d5", pullPayload("synchronize", SHA)));
  assert.equal(harness.wakes.length, 1);
  // Newer head wakes again (exactly once).
  await plugin.definition.onWebhook(webhook("pull_request", "d6", pullPayload("synchronize", NEW_SHA)));
  assert.equal(harness.wakes.length, 2);
  const state = await harness.ctx.entities.list({ entityType: "github-rereview-state", externalId: rereviewStateExternalId(route.repository, 7) });
  assert.equal(state[0].data.revision, NEW_SHA);
  assert.equal(state[0].data.wokenRevision, NEW_SHA);
});

test("request-changes GitHub visibility: a REQUEST_CHANGES verdict posts evidence on the PR via the App", async () => {
  const { harness, issue } = await setupHarness();
  await establishWokenRevision(harness);

  const posted = [];
  harness.ctx.http = githubHttp({ onCall: (url, init) => { if (/\/issues\/\d+\/comments$/.test(url)) posted.push({ url, init }); } });
  await processStewardReviewResult(harness.ctx, signedReviewInput({
    repository: route.repository, prNumber: 7, headSha: NEW_SHA, verdict: "request_changes",
    issueId: issue.id, evidence: "Gate is flaky; please rerun.",
  }));

  assert.equal(posted.length, 1);
  const body = JSON.parse(posted[0].init.body);
  assert.match(body.body, /REQUEST_CHANGES/);
  assert.match(body.body, /flaky/);
  assert.match(body.body, new RegExp(NEW_SHA));
});

test("stale verdict rejection: a verdict for an older head is rejected and never mutates GitHub", async () => {
  const { harness } = await setupHarness();
  await establishWokenRevision(harness);

  const posted = [];
  harness.ctx.http = githubHttp({ onCall: (url) => { if (/\/issues\/\d+\/comments$/.test(url)) posted.push(url); } });
  await assert.rejects(processStewardReviewResult(harness.ctx, signedReviewInput({
    repository: route.repository, prNumber: 7, headSha: SHA, verdict: "request_changes", evidence: "stale",
  })), /rejected/);
  assert.equal(posted.length, 0, "a stale verdict must never post on GitHub");
});
