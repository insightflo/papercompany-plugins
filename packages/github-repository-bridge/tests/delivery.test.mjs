import assert from "node:assert/strict";
import test from "node:test";
import { parseGitHubDelivery } from "../src/delivery.ts";

const repository = {
  full_name: "insightflo/papercompany-runtime",
  html_url: "https://github.com/insightflo/papercompany-runtime",
};

test("normalizes a GitHub issue event into one durable issue key", () => {
  const change = parseGitHubDelivery("issues", {
    action: "opened",
    repository,
    issue: {
      number: 12,
      title: "Fix intake",
      body: "Issue details",
      state: "open",
      html_url: "https://github.com/insightflo/papercompany-runtime/issues/12",
      updated_at: "2026-07-20T01:00:00Z",
    },
  });

  assert.deepEqual(change, {
    repository: repository.full_name,
    objectKind: "issue",
    objectNumber: 12,
    externalKey: "issue:12",
    action: "opened",
    title: "Fix intake",
    body: "Issue details",
    state: "open",
    url: "https://github.com/insightflo/papercompany-runtime/issues/12",
    revision: "2026-07-20T01:00:00Z",
    comment: null,
  });
});

test("maps an issue comment back to the existing issue key", () => {
  const change = parseGitHubDelivery("issue_comment", {
    action: "created",
    repository,
    issue: {
      number: 12,
      title: "Fix intake",
      body: "Issue details",
      state: "open",
      html_url: "https://github.com/insightflo/papercompany-runtime/issues/12",
      updated_at: "2026-07-20T01:00:00Z",
    },
    comment: {
      id: 99,
      body: "New evidence",
      html_url: "https://github.com/insightflo/papercompany-runtime/issues/12#issuecomment-99",
      updated_at: "2026-07-20T01:01:00Z",
      user: { login: "octocat" },
    },
  });

  assert.equal(change?.externalKey, "issue:12");
  assert.deepEqual(change?.comment, {
    id: "99",
    author: "octocat",
    body: "New evidence",
    url: "https://github.com/insightflo/papercompany-runtime/issues/12#issuecomment-99",
    updatedAt: "2026-07-20T01:01:00Z",
  });
});

test("normalizes pull request revisions and check runs to the pull request key", () => {
  const pull = parseGitHubDelivery("pull_request", {
    action: "synchronize",
    repository,
    pull_request: {
      number: 5,
      title: "Add bridge",
      body: null,
      state: "open",
      draft: false,
      html_url: "https://github.com/insightflo/papercompany-runtime/pull/5",
      updated_at: "2026-07-20T02:00:00Z",
      head: { sha: "abc123" },
    },
  });
  const check = parseGitHubDelivery("check_run", {
    action: "completed",
    repository,
    check_run: {
      id: 77,
      name: "verify",
      status: "completed",
      conclusion: "success",
      head_sha: "abc123",
      html_url: "https://github.com/example/check/77",
      pull_requests: [{ number: 5 }],
    },
  });

  assert.equal(pull?.externalKey, "pull:5");
  assert.equal(pull?.revision, "abc123");
  assert.equal(check?.externalKey, "pull:5");
  assert.equal(check?.title, "Check: verify");
  assert.equal(check?.state, "success");
});

test("ignores unsupported events and check runs without a pull request", () => {
  assert.equal(parseGitHubDelivery("ping", { repository }), null);
  assert.equal(parseGitHubDelivery("check_run", {
    action: "completed",
    repository,
    check_run: { id: 77, pull_requests: [] },
  }), null);
});
