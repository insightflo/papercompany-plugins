import assert from "node:assert/strict";
import { test } from "node:test";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.ts";
import plugin from "../src/worker.ts";
import { rereviewStateExternalId } from "../src/rereview.ts";
import { parseStewardReviewResult } from "../src/steward-review.ts";
import {
  SHA,
  NEW_SHA,
  route,
  config,
  webhook,
  pullPayload,
  checkPayload,
  checksJson,
  githubHttp,
  setupHarness,
  listIssues,
  reviewIssueOf,
} from "./rereview-helpers.mjs";

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
  const rc = parseStewardReviewResult({ repository: "acme/runtime", prNumber: 7, headSha: SHA, decision: "request_changes", issueId: "iss-1", evidence: "fix it" });
  assert.equal(rc?.verdict, "request_changes");
  assert.equal(parseStewardReviewResult({ repository: "acme/runtime", prNumber: 7, headSha: SHA, verdict: "maybe" }), null);
  assert.equal(parseStewardReviewResult({ repository: "acme/runtime", prNumber: 7, headSha: "abc", verdict: "pass" }), null);
  // Fail-closed: BOTH verdicts require the exact issueId (missing or blank).
  assert.equal(parseStewardReviewResult({ repository: "acme/runtime", prNumber: 7, headSha: SHA, verdict: "pass" }), null);
  assert.equal(parseStewardReviewResult({ repository: "acme/runtime", prNumber: 7, headSha: SHA, verdict: "request_changes", issueId: "" }), null);
  assert.equal(parseStewardReviewResult({ repository: "acme/runtime", prNumber: 7, headSha: SHA, verdict: "request_changes", issueId: "   " }), null);
});

test("a genuinely new head creates exactly one NEW review issue with the steward as assignee", async () => {
  const { harness, issue } = await setupHarness();
  await plugin.definition.onWebhook(webhook("pull_request", "d1", pullPayload("synchronize", NEW_SHA)));

  const issues = await listIssues(harness);
  assert.equal(issues.length, 2, "linked seed issue + exactly one new per-SHA review issue");
  const review = reviewIssueOf(issues, issue.id);
  assert.ok(review, "a new review issue must be created");
  assert.equal(review.assigneeAgentId, route.stewardAgentId);
  assert.equal(review.status, "in_review");
  assert.match(review.title, /Review head b/);
  assert.match(review.description, new RegExp(NEW_SHA));
  // Exactly one per-SHA revision record, pinned to the new issue.
  const revisions = await harness.ctx.entities.list({ entityType: "github-rereview-issue" });
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].data.sha, NEW_SHA);
  assert.equal(revisions[0].data.issueId, review.id);
});

test("duplicate/concurrent deliveries of the same head create exactly one issue", async () => {
  const { harness, issue } = await setupHarness();
  // Same head redelivered multiple times (webhook retries / concurrent delivery).
  await plugin.definition.onWebhook(webhook("pull_request", "d-1", pullPayload("synchronize", NEW_SHA)));
  await plugin.definition.onWebhook(webhook("pull_request", "d-2", pullPayload("synchronize", NEW_SHA)));
  await plugin.definition.onWebhook(webhook("pull_request", "d-3", pullPayload("synchronize", NEW_SHA)));

  const issues = await listIssues(harness);
  assert.equal(issues.length, 2, "linked seed issue + exactly one review issue despite 3 deliveries");
  const review = reviewIssueOf(issues, issue.id);
  assert.ok(review);
  const revisions = await harness.ctx.entities.list({ entityType: "github-rereview-issue" });
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].data.issueId, review.id);
});

test("multiple required checks: the issue is only created after the FULL set passes", async () => {
  const routeMulti = {
    ...route,
    mergeApprovals: {
      ...route.mergeApprovals,
      requiredChecks: ["verify", "lint"],
    },
  };
  const configMulti = { ...config, repositories: [routeMulti] };
  const { privateKey } = await import("node:crypto").then((crypto) => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }));
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const harness = createTestHarness({ manifest, config: configMulti });
  harness.seed({
    projects: [{ id: route.projectId, companyId: route.companyId, name: "Platform" }],
    agents: [{ id: route.stewardAgentId, companyId: route.companyId, status: "idle", name: "Steward" }],
  });
  harness.ctx.secrets = {
    async resolve(ref) {
      const resolved = { APP_ID: "12345", PRIVATE_KEY: privateKeyPem };
      return resolved[ref] ?? `resolved:${ref}`;
    },
  };
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
  // Live check set is mutable: the final `lint` delivery makes the full set pass.
  let liveChecks = checksJson({ verify: "success", lint: "pending" });
  harness.ctx.http = {
    async fetch(url, init) {
      const headers = { "content-type": "application/json" };
      if (url.endsWith("/installation")) return new Response(JSON.stringify({ id: 123 }), { status: 200, headers });
      if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "app-token" }), { status: 201, headers });
      // The authoritative FULL check-run set for the exact head, refetched live.
      if (/\/commits\/[^/]+\/check-runs/.test(url)) {
        return new Response(JSON.stringify(liveChecks), { status: 200, headers });
      }
      if (/\/issues\/\d+\/comments$/.test(url)) return new Response(JSON.stringify({ id: 1 }), { status: 201, headers });
      if (/\/pulls\/\d+$/.test(url)) return new Response(JSON.stringify(pullPayload("synchronize", NEW_SHA).pull_request), { status: 200, headers });
      return new Response(null, { status: 404 });
    },
  };
  await plugin.definition.setup(harness.ctx);

  // New head with only ONE of two required checks passing: no review issue yet.
  await plugin.definition.onWebhook(webhook("pull_request", "d-multi-1", pullPayload("synchronize", NEW_SHA)));
  let issues = await harness.ctx.issues.list({ companyId: route.companyId });
  assert.equal(issues.length, 1, "no new issue while only one of two required checks passes");

  // The final `lint` check completes on GitHub: the live full set now passes,
  // so the delivery re-evaluates and creates the review issue exactly once.
  liveChecks = checksJson({ verify: "success", lint: "success" });
  await plugin.definition.onWebhook(webhook("check_run", "d-multi-2", checkPayload(NEW_SHA, "success", "lint")));
  issues = await harness.ctx.issues.list({ companyId: route.companyId });
  assert.equal(issues.length, 2, "review issue created only after the full required set passes");
  const review = reviewIssueOf(issues, issue.id);
  assert.ok(review);
  assert.equal(review.assigneeAgentId, route.stewardAgentId);
});

test("comment-before-trigger: the GitHub comment is mirrored exactly once, never parsed as authority", async () => {
  const { harness, issue } = await setupHarness();
  harness.ctx.http = githubHttp();

  // A GitHub PR comment arrives as issue_comment BEFORE any head is tracked;
  // the structured loop owns mirroring on mergeApprovals routes. It mirrors to
  // the linked issue (the only reviewable issue at that moment), exactly once.
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

  const issues = await listIssues(harness);
  const review = reviewIssueOf(issues, issue.id);
  assert.ok(review, "the new per-SHA review issue was created");
  // The comment was mirrored exactly once, to the linked issue.
  const linkedComments = await harness.ctx.issues.listComments(issue.id, route.companyId);
  assert.equal(linkedComments.length, 1);
  assert.match(linkedComments[0].body, /Please fix the gate/);
  // No duplicate mirror on the new review issue.
  const reviewComments = await harness.ctx.issues.listComments(review.id, route.companyId);
  assert.equal(reviewComments.length, 0, "a GitHub comment is never mirrored twice");
});

test("no check-event storm: repeated check deliveries for the same head create no extra issues", async () => {
  const { harness, issue } = await setupHarness();
  await plugin.definition.onWebhook(webhook("pull_request", "d3", pullPayload("synchronize", NEW_SHA)));
  assert.equal((await listIssues(harness)).length, 2);

  // A storm of check/workflow deliveries for the same head: no additional issue.
  for (let i = 0; i < 10; i += 1) {
    await plugin.definition.onWebhook(webhook("check_run", `d-check-${i}`, checkPayload(NEW_SHA, "success")));
  }
  const issues = await listIssues(harness);
  assert.equal(issues.length, 2, "check deliveries must not create extra review issues");
  assert.equal((await harness.ctx.entities.list({ entityType: "github-rereview-issue" })).length, 1);
  void issue;
});

test("latest-SHA dedupe: each exact head creates exactly one issue, newest head wins", async () => {
  const { harness, issue } = await setupHarness();
  await plugin.definition.onWebhook(webhook("pull_request", "d4", pullPayload("synchronize", SHA)));
  // The first head reuses the linked issue (no second issue for the first review).
  assert.equal((await listIssues(harness)).length, 1);
  // Redelivery of the same head: coalesced, no new issue.
  await plugin.definition.onWebhook(webhook("pull_request", "d5", pullPayload("synchronize", SHA)));
  assert.equal((await listIssues(harness)).length, 1);
  // Newer head creates exactly one NEW issue.
  await plugin.definition.onWebhook(webhook("pull_request", "d6", pullPayload("synchronize", NEW_SHA)));
  const issues = await listIssues(harness);
  assert.equal(issues.length, 2);
  const review = reviewIssueOf(issues, issue.id);
  assert.ok(review);
  const state = await harness.ctx.entities.list({ entityType: "github-rereview-state", externalId: rereviewStateExternalId(route.repository, 7) });
  assert.equal(state[0].data.revision, NEW_SHA);
  assert.equal(state[0].data.wokenRevision, NEW_SHA);
  const revisions = await harness.ctx.entities.list({ entityType: "github-rereview-issue" });
  assert.equal(revisions.length, 2, "one revision record per exact head SHA");
  const newShaRevisions = revisions.filter((revision) => revision.data.sha === NEW_SHA);
  assert.equal(newShaRevisions.length, 1);
  assert.equal(newShaRevisions[0].data.issueId, review.id);
});

test("initial head reuses the linked issue when it matches the link revision and is reviewable", async () => {
  const { harness, issue } = await setupHarness();
  // A synchronize for the SAME head the link was created for (the initial head).
  await plugin.definition.onWebhook(webhook("pull_request", "d-initial", pullPayload("synchronize", SHA)));

  const issues = await listIssues(harness);
  assert.equal(issues.length, 1, "initial head reuses the linked issue; no new issue");
  assert.equal(issues[0].id, issue.id);
  const revisions = await harness.ctx.entities.list({ entityType: "github-rereview-issue" });
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].data.issueId, issue.id);
});
