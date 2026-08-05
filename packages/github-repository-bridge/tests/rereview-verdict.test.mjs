import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../src/worker.ts";
import { processStewardReviewResult } from "../src/steward-review.ts";
import {
  NEW_SHA,
  route,
  webhook,
  pullPayload,
  githubHttp,
  signedReviewInput,
  setupHarness,
  listIssues,
  reviewIssueOf,
} from "./rereview-helpers.mjs";

async function establishWokenReview(harness) {
  await plugin.definition.onWebhook(webhook("pull_request", "d-wake", pullPayload("synchronize", NEW_SHA)));
  const issues = await listIssues(harness);
  return reviewIssueOf(issues, issues.find((candidate) => !candidate.title.includes("Review head"))?.id);
}

test("request-changes GitHub visibility: a REQUEST_CHANGES verdict posts evidence on the PR via the App and blocks the exact issue", async () => {
  const { harness } = await setupHarness();
  const review = await establishWokenReview(harness);
  assert.ok(review, "the per-SHA review issue must exist for the woken revision");

  const posted = [];
  harness.ctx.http = githubHttp({ onCall: (url, init) => { if (/\/issues\/\d+\/comments$/.test(url)) posted.push({ url, init }); } });
  await processStewardReviewResult(harness.ctx, signedReviewInput({
    repository: route.repository, prNumber: 7, headSha: NEW_SHA, verdict: "request_changes",
    issueId: review.id, evidence: "Gate is flaky; please rerun.",
  }));

  assert.equal(posted.length, 1);
  const body = JSON.parse(posted[0].init.body);
  assert.match(body.body, /REQUEST_CHANGES/);
  assert.match(body.body, /flaky/);
  assert.match(body.body, new RegExp(NEW_SHA));
  const blocked = await harness.ctx.issues.get(review.id, route.companyId);
  assert.equal(blocked.status, "blocked");
});

test("REQUEST_CHANGES is idempotent: a repeated verdict posts once and keeps the issue blocked", async () => {
  const { harness } = await setupHarness();
  const review = await establishWokenReview(harness);
  assert.ok(review);

  const posted = [];
  harness.ctx.http = githubHttp({ onCall: (url) => { if (/\/issues\/\d+\/comments$/.test(url)) posted.push(url); } });
  const input = signedReviewInput({
    repository: route.repository, prNumber: 7, headSha: NEW_SHA, verdict: "request_changes",
    issueId: review.id, evidence: "Gate is flaky; please rerun.",
  });
  await processStewardReviewResult(harness.ctx, input);
  await processStewardReviewResult(harness.ctx, input);
  assert.equal(posted.length, 1, "the REQUEST_CHANGES GitHub comment is published exactly once");
  assert.equal((await harness.ctx.issues.get(review.id, route.companyId)).status, "blocked");
  const publications = await harness.ctx.entities.list({ entityType: "github-rereview-publication" });
  assert.equal(publications.length, 1);
});

test("a terminal REQUEST_CHANGES issue is never revived by a redelivered synchronize", async () => {
  const { harness } = await setupHarness();
  const review = await establishWokenReview(harness);
  assert.ok(review);
  await processStewardReviewResult(harness.ctx, signedReviewInput({
    repository: route.repository, prNumber: 7, headSha: NEW_SHA, verdict: "request_changes",
    issueId: review.id, evidence: "fix it",
  }));
  assert.equal((await harness.ctx.issues.get(review.id, route.companyId)).status, "blocked");

  // Redelivery of the same head after the terminal verdict: nothing changes.
  await plugin.definition.onWebhook(webhook("pull_request", "d-again", pullPayload("synchronize", NEW_SHA)));
  const after = await listIssues(harness);
  assert.equal(after.length, 2, "no new issue is created for a terminal revision");
  assert.equal((await harness.ctx.issues.get(review.id, route.companyId)).status, "blocked");
  const revisions = await harness.ctx.entities.list({ entityType: "github-rereview-issue" });
  assert.equal(revisions[0].data.status, "request_changes");
});

test("legacy INF-247: no rereview state + blocked linked issue + new passing head creates ONE new issue, linked stays blocked", async () => {
  // The linked issue was created before per-SHA state existed and was blocked
  // by an earlier REQUEST_CHANGES. No github-rereview-state record exists.
  const { harness, issue } = await setupHarness();
  await harness.ctx.issues.update(issue.id, { status: "blocked" }, route.companyId);

  // A genuinely new passing head arrives: must create a NEW issue (not revive).
  await plugin.definition.onWebhook(webhook("pull_request", "d-legacy", pullPayload("synchronize", NEW_SHA)));

  const issues = await listIssues(harness);
  assert.equal(issues.length, 2, "blocked linked issue + exactly one NEW review issue");
  const review = reviewIssueOf(issues, issue.id);
  assert.ok(review, "a NEW issue is created for the new head");
  assert.equal(review.assigneeAgentId, route.stewardAgentId);
  assert.match(review.title, /Review head b/);
  // The legacy linked issue stays blocked (never revived).
  assert.equal((await harness.ctx.issues.get(issue.id, route.companyId)).status, "blocked");
  const revisions = await harness.ctx.entities.list({ entityType: "github-rereview-issue" });
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].data.issueId, review.id);
});

test("stale verdict rejection: a verdict for an older head or wrong issue is rejected and never mutates GitHub", async () => {
  const { harness } = await setupHarness();
  const review = await establishWokenReview(harness);
  assert.ok(review);

  const posted = [];
  harness.ctx.http = githubHttp({ onCall: (url) => { if (/\/issues\/\d+\/comments$/.test(url)) posted.push(url); } });
  // Older head than the tracked revision (with the exact issueId so the
  // freshness gate, not the parser, rejects it).
  await assert.rejects(processStewardReviewResult(harness.ctx, signedReviewInput({
    repository: route.repository, prNumber: 7, headSha: "a".repeat(40), verdict: "request_changes",
    issueId: review.id, evidence: "stale",
  })), /rejected/);
  // Wrong issueId for the exact head.
  await assert.rejects(processStewardReviewResult(harness.ctx, signedReviewInput({
    repository: route.repository, prNumber: 7, headSha: NEW_SHA, verdict: "request_changes",
    issueId: "iss-999", evidence: "stale",
  })), /rejected/);
  assert.equal(posted.length, 0, "a stale verdict must never post on GitHub");
});

test("missing issueId is rejected at the endpoint with no GitHub side effect", async () => {
  const { harness } = await setupHarness();
  await establishWokenReview(harness);

  const posted = [];
  harness.ctx.http = githubHttp({ onCall: (url) => { if (/\/issues\/\d+\/comments$/.test(url)) posted.push(url); } });
  // Fail-closed: a REQUEST_CHANGES without the exact issueId is rejected at
  // parse time — no GitHub comment is posted, no issue is blocked.
  await assert.rejects(processStewardReviewResult(harness.ctx, signedReviewInput({
    repository: route.repository, prNumber: 7, headSha: NEW_SHA, verdict: "request_changes", evidence: "no issue id",
  })), /incomplete/);
  assert.equal(posted.length, 0, "a missing-issueId verdict must never post on GitHub");
  const issues = await listIssues(harness);
  for (const candidate of issues) {
    const current = await harness.ctx.issues.get(candidate.id, route.companyId);
    assert.notEqual(current.status, "blocked", "no issue is blocked by an incomplete verdict");
  }
});
