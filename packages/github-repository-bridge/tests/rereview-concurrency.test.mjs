import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../src/worker.ts";
import { withPrLock, activeLockCount } from "../src/rereview-lock.ts";
import {
  NEW_SHA,
  webhook,
  pullPayload,
  setupHarness,
  listIssues,
  reviewIssueOf,
} from "./rereview-helpers.mjs";

/**
 * True-concurrency guarantee: the Runtime runs one worker process per
 * installed plugin (plugin-worker-manager.ts), while the SDK worker-rpc-host
 * dispatches webhook RPCs fire-and-forget (they can run in parallel). The
 * re-review intake therefore serializes all deliveries for the same
 * repository+PR through an in-process promise mutex. This test forces a real
 * race with an intentional delay inside `issues.create`: without the mutex the
 * second concurrent delivery would enter create while the first is still in
 * flight (createCalls=2 / maxActiveCreates=2); with it, the second delivery
 * waits on the lock, then dedupes on the persisted revision record and never
 * calls create (createCalls=1 / maxActiveCreates=1).
 */
test("true concurrency: two simultaneous deliveries of the same new head create exactly ONE issue", async () => {
  const { harness, issue } = await setupHarness();

  const originalCreate = harness.ctx.issues.create.bind(harness.ctx.issues);
  const createTitles = [];
  let createCalls = 0;
  let activeCreates = 0;
  let maxActiveCreates = 0;
  harness.ctx.issues.create = async (input) => {
    createCalls += 1;
    activeCreates += 1;
    maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
    createTitles.push(input.title);
    // Intentionally hold the create in flight to expose any concurrent entry.
    await new Promise((resolve) => setTimeout(resolve, 40));
    try {
      return await originalCreate(input);
    } finally {
      activeCreates -= 1;
    }
  };

  // Both deliveries start concurrently (the wrapper does not gate them).
  await Promise.all([
    plugin.definition.onWebhook(webhook("pull_request", "c-1", pullPayload("synchronize", NEW_SHA))),
    plugin.definition.onWebhook(webhook("pull_request", "c-2", pullPayload("synchronize", NEW_SHA))),
  ]);

  // The mutex serializes: the second delivery must NOT have created an issue.
  const reviewCreates = createTitles.filter((title) => title.includes("Review head")).length;
  assert.equal(reviewCreates, 1, "exactly one review-issue create call across two concurrent deliveries");
  assert.equal(createCalls, 1, "the second delivery deduped on the revision record and skipped create");
  assert.equal(maxActiveCreates, 1, "the mutex never allowed two concurrent issue creations");
  const issues = await listIssues(harness);
  assert.equal(issues.length, 2, "linked seed issue + exactly ONE review issue for the new head");
  const review = reviewIssueOf(issues, issue.id);
  assert.ok(review, "the single review issue exists");
  const revisions = await harness.ctx.entities.list({ entityType: "github-rereview-issue" });
  assert.equal(revisions.length, 1, "exactly one revision record for the SHA");
  assert.equal(revisions[0].data.issueId, review.id);
});

test("lock cleanup: the shared lock map empties after concurrent critical sections, including failures", async () => {
  assert.equal(activeLockCount(), 0);

  // A failing critical section must not poison the chain or leak the key.
  await assert.rejects(
    withPrLock("acme/runtime", 7, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(activeLockCount(), 0, "a failed critical section still cleans up its lock key");

  // Concurrent runs on the same key serialize; a later run on a DIFFERENT key
  // is independent; all keys are removed once everything settles.
  let runtimeActive = 0;
  let runtimeMaxActive = 0;
  const runtimeWork = async () => {
    runtimeActive += 1;
    runtimeMaxActive = Math.max(runtimeMaxActive, runtimeActive);
    await new Promise((resolve) => setTimeout(resolve, 30));
    runtimeActive -= 1;
  };
  let otherActive = 0;
  let otherMaxActive = 0;
  const otherWork = async () => {
    otherActive += 1;
    otherMaxActive = Math.max(otherMaxActive, otherActive);
    await new Promise((resolve) => setTimeout(resolve, 30));
    otherActive -= 1;
  };
  await Promise.all([
    withPrLock("acme/runtime", 7, runtimeWork),
    withPrLock("acme/runtime", 7, runtimeWork),
    withPrLock("acme/runtime", 7, runtimeWork),
    withPrLock("acme/other", 2, otherWork),
  ]);

  assert.equal(runtimeMaxActive, 1, "same-key runs never overlap inside the lock");
  assert.equal(otherMaxActive, 1, "the other key's runs also serialize");
  assert.equal(activeLockCount(), 0, "the lock map is fully cleaned up after concurrent critical sections");
});
