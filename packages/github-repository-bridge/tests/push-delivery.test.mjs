import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePush, parseCommitCheck, branchFromRef } from "../src/push-delivery.ts";

test("branchFromRef strips the refs/heads/ prefix", () => {
  assert.equal(branchFromRef("refs/heads/main"), "main");
  assert.equal(branchFromRef("refs/heads/feature/x"), "feature/x");
  assert.equal(branchFromRef("not-a-ref"), "");
});

test("parsePush extracts repository, branch, commit sha and message", () => {
  const delivery = parsePush({
    ref: "refs/heads/main",
    before: "aaa",
    after: "deadbeefcafebabe",
    repository: { full_name: "Acme/Runtime" },
    head_commit: { id: "deadbeefcafebabe", message: "fix: deploy gate\n\nbody", url: "https://example/commit/deadbeef", author: { name: "Alice" } },
    pusher: { name: "alice" },
  });
  assert.equal(delivery?.repository, "acme/runtime");
  assert.equal(delivery?.branch, "main");
  assert.equal(delivery?.after, "deadbeefcafebabe");
  assert.equal(delivery?.commitMessage, "fix: deploy gate\n\nbody");
  assert.equal(delivery?.commitAuthor, "Alice");
});

test("parsePush rejects branch deletions (zero after sha) and missing identity", () => {
  assert.equal(parsePush({ ref: "refs/heads/main", after: "0000000000000000000000000000000000000000", repository: { full_name: "a/b" } }), null);
  assert.equal(parsePush({ ref: "refs/heads/main", after: "abc", repository: {} }), null);
  assert.equal(parsePush({ ref: "refs/tags/x", after: "abc", repository: { full_name: "a/b" } }), null);
});

test("parseCommitCheck reads check_run conclusions keyed by the exact commit sha", () => {
  const check = parseCommitCheck("check_run", {
    check_run: { name: "verify", status: "completed", conclusion: "success", head_sha: "deadbeef", html_url: "https://example/c" },
    repository: { full_name: "Acme/Runtime" },
  });
  assert.equal(check?.repository, "acme/runtime");
  assert.equal(check?.sha, "deadbeef");
  assert.equal(check?.name, "verify");
  assert.equal(check?.conclusion, "success");
  assert.equal(check?.source, "check_run");
});

test("parseCommitCheck reads workflow_run conclusions keyed by head_sha", () => {
  const check = parseCommitCheck("workflow_run", {
    workflow_run: { name: "ci", status: "completed", conclusion: "failure", head_sha: "deadbeef", html_url: "https://example/w" },
    repository: { full_name: "acme/runtime" },
  });
  assert.equal(check?.name, "ci");
  assert.equal(check?.conclusion, "failure");
  assert.equal(check?.source, "workflow_run");
  assert.equal(parseCommitCheck("push", {}), null);
});
