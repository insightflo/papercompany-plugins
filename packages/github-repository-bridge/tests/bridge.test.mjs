import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.ts";
import plugin from "../src/worker.ts";

const route = {
  repository: "insightflo/papercompany-runtime",
  companyId: "company-1",
  projectId: "project-1",
  projectWorkspaceId: "workspace-runtime",
  stewardAgentId: "agent-runtime",
};

const config = {
  webhookSecretRef: "webhook-secret",
  shadowMode: true,
  repositories: [route],
};

function webhook(eventName, deliveryId, payload, secret = "resolved:webhook-secret") {
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

function issuePayload(action = "opened") {
  return {
    action,
    repository: { full_name: route.repository },
    issue: {
      number: 12,
      title: "Fix intake",
      body: "Issue details",
      state: action === "closed" ? "closed" : "open",
      html_url: `https://github.com/${route.repository}/issues/12`,
      updated_at: "2026-07-20T01:00:00Z",
    },
  };
}

async function setupHarness() {
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    projects: [{ id: route.projectId, companyId: route.companyId, name: "Papercompany Platform" }],
  });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

async function setupHarnessWithAgent(status) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({
    projects: [{ id: route.projectId, companyId: route.companyId, name: "Papercompany Platform" }],
    agents: [{ id: route.stewardAgentId, companyId: route.companyId, status, name: "Runtime Steward" }],
  });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

test("manifest declares one GitHub webhook and only plugin-side capabilities", () => {
  assert.equal(pluginManifestV1Schema.safeParse(manifest).success, true);
  assert.equal(manifest.id, "insightflo.github-repository-bridge");
  assert.deepEqual(manifest.webhooks, [{
    endpointKey: "github",
    displayName: "GitHub Webhook",
    description: "Receives allowlisted GitHub Issue, pull request, review, and check events.",
  }]);
  assert.equal(manifest.capabilities.includes("webhooks.receive"), true);
  assert.equal(manifest.capabilities.includes("secrets.read-ref"), true);
  assert.equal(manifest.capabilities.includes("issues.create"), true);
});

test("creates one linked Papercompany issue and deduplicates a redelivery", async () => {
  const harness = await setupHarness();
  const input = webhook("issues", "delivery-1", issuePayload());

  await plugin.definition.onWebhook(input);
  await plugin.definition.onWebhook(input);

  const issues = await harness.ctx.issues.list({ companyId: route.companyId });
  const links = await harness.ctx.entities.list({
    entityType: "github-object-link",
    externalId: `${route.repository}:issue:12`,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].projectId, route.projectId);
  assert.equal(issues[0].projectWorkspaceId, route.projectWorkspaceId);
  assert.equal(issues[0].assigneeAgentId, route.stewardAgentId);
  assert.equal(links.length, 1);
  assert.equal(links[0].scopeKind, "project_workspace");
  assert.equal(links[0].scopeId, route.projectWorkspaceId);
  assert.equal(links[0].data.issueId, issues[0].id);
});

test("rejects invalid signatures and repositories outside the allowlist", async () => {
  const harness = await setupHarness();
  const invalid = webhook("issues", "delivery-invalid", issuePayload(), "wrong-secret");
  const unapprovedPayload = issuePayload();
  unapprovedPayload.repository.full_name = "someone/unapproved";

  await assert.rejects(plugin.definition.onWebhook(invalid), /signature/i);
  await assert.rejects(
    plugin.definition.onWebhook(webhook("issues", "delivery-unapproved", unapprovedPayload)),
    /allowlist/i,
  );
  assert.equal((await harness.ctx.issues.list({ companyId: route.companyId })).length, 0);
});

test("adds a new GitHub comment to the existing issue without creating another issue", async () => {
  const harness = await setupHarness();
  await plugin.definition.onWebhook(webhook("issues", "delivery-issue", issuePayload()));
  const commentPayload = {
    ...issuePayload("edited"),
    action: "created",
    comment: {
      id: 99,
      body: "New evidence",
      html_url: `https://github.com/${route.repository}/issues/12#issuecomment-99`,
      updated_at: "2026-07-20T01:01:00Z",
      user: { login: "octocat" },
    },
  };

  await plugin.definition.onWebhook(webhook("issue_comment", "delivery-comment", commentPayload));

  const [issue] = await harness.ctx.issues.list({ companyId: route.companyId });
  const comments = await harness.ctx.issues.listComments(issue.id, route.companyId);
  assert.equal((await harness.ctx.issues.list({ companyId: route.companyId })).length, 1);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /octocat/);
  assert.match(comments[0].body, /New evidence/);
});

test("preserves a comment when the comment delivery creates the initial link", async () => {
  const harness = await setupHarness();
  const payload = {
    ...issuePayload("edited"),
    action: "created",
    comment: {
      id: 100,
      body: "First observed event",
      html_url: `https://github.com/${route.repository}/issues/12#issuecomment-100`,
      updated_at: "2026-07-20T01:02:00Z",
      user: { login: "octocat" },
    },
  };

  await plugin.definition.onWebhook(webhook("issue_comment", "delivery-comment-first", payload));

  const [issue] = await harness.ctx.issues.list({ companyId: route.companyId });
  const comments = await harness.ctx.issues.listComments(issue.id, route.companyId);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /First observed event/);
});

test("configuration validation blocks duplicate repository routes", async () => {
  const result = await plugin.definition.onValidateConfig({
    ...config,
    repositories: [route, { ...route, projectWorkspaceId: "workspace-copy" }],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /duplicate/i);
});

test("configuration validation keeps outbound GitHub mutations in shadow mode", async () => {
  const result = await plugin.definition.onValidateConfig({ ...config, shadowMode: false });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /shadow mode/i);
});

test("a paused steward does not turn an accepted update into a webhook failure", async () => {
  const harness = await setupHarnessWithAgent("paused");
  await plugin.definition.onWebhook(webhook("issues", "delivery-first", issuePayload()));

  const edited = issuePayload("edited");
  edited.issue.title = "Updated title";
  await plugin.definition.onWebhook(webhook("issues", "delivery-second", edited));

  const [issue] = await harness.ctx.issues.list({ companyId: route.companyId });
  assert.match(issue.title, /Updated title/);
  assert.equal(harness.logs.some((entry) => entry.level === "warn" && /wake/i.test(entry.message)), true);
});
