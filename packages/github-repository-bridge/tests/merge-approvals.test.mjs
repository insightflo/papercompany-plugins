import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  requestMergeApproval,
  handleMergeApprovalDecided,
  drainMergeOutbox,
  processStewardMergeRequest,
  parseStewardMergeRequest,
} from "../src/merge-approvals.ts";
import { handleApprovalDecided } from "../src/deploy-approvals.ts";
import { mergeRequestExternalId, mergeOutboxExternalId } from "../src/merge-checks.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

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
const config = {
  webhookSecretRef: "S",
  stewardApiSecretRef: "STEWARD",
  shadowMode: true,
  repositories: [route],
};

function prJson({ headSha = SHA, state = "open", draft = false, merged = false, mergeable = true, base = "main" } = {}) {
  return {
    number: 7,
    title: "Ship feature",
    state,
    draft,
    merged,
    head: { sha: headSha, ref: "feature" },
    base: { ref: base },
    mergeable,
    mergeable_state: mergeable ? "clean" : "blocked",
    html_url: "https://github.com/acme/runtime/pull/7",
  };
}

function checksJson(ok = true) {
  return {
    check_runs: [
      { name: "verify", status: "completed", conclusion: ok ? "success" : "failure", html_url: "u", check_suite: { head_branch: "feature" } },
    ],
  };
}

function mergeHttp({ pr = prJson(), checks = checksJson(true), mergeStatus = 200, mergeMerged, onCall } = {}) {
  return {
    async fetch(url, init) {
      if (onCall) onCall(url, init);
      const headers = { "content-type": "application/json" };
      if (url.endsWith("/installation")) return new Response(JSON.stringify({ id: 123 }), { status: 200, headers });
      if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "merge-token" }), { status: 201, headers });
      if (/\/pulls\/\d+\/merge$/.test(url)) {
        const success = mergeStatus >= 200 && mergeStatus < 300;
        const merged = mergeMerged === undefined ? success : mergeMerged;
        return new Response(
          JSON.stringify({ sha: SHA, merged, message: merged ? "Pull request successfully merged" : "merge failed" }),
          { status: mergeStatus, headers },
        );
      }
      if (/\/pulls\/\d+$/.test(url)) return new Response(JSON.stringify(pr), { status: 200, headers });
      if (/\/commits\/[^/]+\/check-runs/.test(url)) return new Response(JSON.stringify(checks), { status: 200, headers });
      return new Response(null, { status: 404 });
    },
  };
}

function mockCtx(records) {
  const upserts = [];
  const logs = [];
  const approvals = [];
  const resolved = { APP_ID: "12345", PRIVATE_KEY: privateKeyPem };
  const ctx = {
    config: { async get() { return config; } },
    entities: {
      async list({ entityType, externalId }) {
        let out = records.filter((r) => r.entityType === entityType);
        if (externalId) out = out.filter((r) => r.externalId === externalId);
        return out;
      },
      async upsert(input) {
        upserts.push(input);
        const existing = records.find((r) => r.externalId === input.externalId && r.entityType === input.entityType);
        const record = { externalId: input.externalId, entityType: input.entityType, data: input.data, status: input.status };
        if (existing) Object.assign(existing, record);
        else records.push(record);
        return record;
      },
    },
    activity: { async log(input) { logs.push(input); } },
    approvals: { async create(input) { const a = { id: `approval-${approvals.length + 1}`, ...input }; approvals.push(a); return a; } },
    logger: { info() {}, warn() {} },
    secrets: { async resolve(ref) { return resolved[ref] ?? `resolved:${ref}`; } },
    http: mergeHttp(),
  };
  return { ctx, upserts, logs, approvals };
}

function stewardReq(sha = SHA) {
  return { repository: "acme/runtime", prNumber: 7, headSha: sha, issueId: "iss-1", reviewEvidence: { verdict: "pass" } };
}

function mergeRequestEntity({ approvalId, sha = SHA, superseded = false }) {
  return {
    externalId: mergeRequestExternalId("acme/runtime", 7, sha),
    entityType: "github-merge-request",
    data: { repository: "acme/runtime", prNumber: 7, headSha: sha, issueId: "iss-1", companyId: "c1", approvalId, superseded },
  };
}

function outboxRecord({ approvalId, sha = SHA, status = "pending", attempts = 0 }) {
  return {
    externalId: mergeOutboxExternalId(approvalId, sha),
    entityType: "github-merge-dispatch",
    status,
    data: { approvalId, sha, repository: "acme/runtime", prNumber: 7, issueId: "iss-1", status, attempts, lastError: null },
  };
}

test("parseStewardMergeRequest accepts the documented contract and rejects incomplete bodies", () => {
  assert.deepEqual(parseStewardMergeRequest({ repository: "Acme/Runtime", prNumber: 7, headSha: SHA, issueId: "iss-1", reviewEvidence: { v: 1 } }), {
    repository: "acme/runtime", prNumber: 7, headSha: SHA, issueId: "iss-1", reviewEvidence: { v: 1 },
  });
  assert.equal(parseStewardMergeRequest({ repository: "acme/runtime", prNumber: 7, headSha: SHA }), null);
  assert.equal(parseStewardMergeRequest({ repository: "not-a-repo", prNumber: 7, headSha: SHA, issueId: "iss-1" }), null);
});

test("parseStewardMergeRequest requires a 40-char hex head SHA and normalizes case", () => {
  assert.equal(parseStewardMergeRequest({ repository: "acme/runtime", prNumber: 7, headSha: "short", issueId: "iss-1" }), null);
  assert.equal(parseStewardMergeRequest({ repository: "acme/runtime", prNumber: 7, headSha: "g".repeat(40), issueId: "iss-1" }), null);
  assert.equal(parseStewardMergeRequest({ repository: "acme/runtime", prNumber: 7, headSha: "a".repeat(41), issueId: "iss-1" }), null);
  // uppercase is normalized to lowercase and accepted as the documented 40-char hex
  const normalized = parseStewardMergeRequest({ repository: "acme/runtime", prNumber: 7, headSha: "A".repeat(40), issueId: "iss-1" });
  assert.equal(normalized?.headSha, SHA);
});

test("a steward PASS with a passing gate creates one merge approval and records the request", async () => {
  const { ctx, upserts, approvals } = mockCtx([]);
  await requestMergeApproval(ctx, config, stewardReq());
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].type, "external_automation");
  assert.equal(approvals[0].payload.kind, "merge");
  assert.equal(approvals[0].payload.headSha, SHA);
  assert.equal(approvals[0].payload.issueId, "iss-1");
  const req = upserts.find((u) => u.entityType === "github-merge-request");
  assert.ok(req);
  assert.equal(req.data.approvalId, approvals[0].id);
  assert.equal(req.data.superseded, false);
});

test("a steward PASS for a draft PR never creates an approval", async () => {
  const { ctx, approvals } = mockCtx([]);
  ctx.http = mergeHttp({ pr: prJson({ draft: true }) });
  await assert.rejects(requestMergeApproval(ctx, config, stewardReq()), /draft/);
  assert.equal(approvals.length, 0);
});

test("a steward PASS for a closed PR never creates an approval", async () => {
  const { ctx, approvals } = mockCtx([]);
  ctx.http = mergeHttp({ pr: prJson({ state: "closed" }) });
  await assert.rejects(requestMergeApproval(ctx, config, stewardReq()), /not open/);
  assert.equal(approvals.length, 0);
});

test("a steward PASS for a changed head SHA never creates an approval", async () => {
  const { ctx, approvals } = mockCtx([]);
  ctx.http = mergeHttp({ pr: prJson({ headSha: OTHER_SHA }) });
  await assert.rejects(requestMergeApproval(ctx, config, stewardReq()), /does not match pinned/);
  assert.equal(approvals.length, 0);
});

test("a steward PASS with a failing required check never creates an approval", async () => {
  const { ctx, approvals } = mockCtx([]);
  ctx.http = mergeHttp({ checks: checksJson(false) });
  await assert.rejects(requestMergeApproval(ctx, config, stewardReq()), /required checks not satisfied/);
  assert.equal(approvals.length, 0);
});

test("a steward PASS for a repository without mergeApprovals is rejected", async () => {
  const { ctx, approvals } = mockCtx([]);
  await assert.rejects(
    requestMergeApproval(ctx, { ...config, repositories: [{ ...route, mergeApprovals: undefined }] }, stewardReq()),
    /mergeApprovals is not configured/,
  );
  assert.equal(approvals.length, 0);
});

test("a repeated steward PASS for the same PR+SHA is idempotent (no second approval)", async () => {
  const records = [{ ...mergeRequestEntity({ approvalId: "existing" }), data: { ...mergeRequestEntity({ approvalId: "existing" }).data } }];
  const { ctx, approvals, upserts } = mockCtx(records);
  await requestMergeApproval(ctx, config, stewardReq());
  assert.equal(approvals.length, 0);
  assert.equal(upserts.length, 0);
});

test("a steward PASS supersedes an older stored request for the same PR at a different head", async () => {
  const oldSha = "0".repeat(40);
  const records = [mergeRequestEntity({ approvalId: "old", sha: oldSha })];
  const { ctx, upserts } = mockCtx(records);
  await requestMergeApproval(ctx, config, stewardReq(SHA));
  const superseded = upserts.find((u) => u.externalId === mergeRequestExternalId("acme/runtime", 7, oldSha));
  assert.ok(superseded);
  assert.equal(superseded.data.superseded, true);
  assert.equal(superseded.data.supersededBy, SHA);
});

test("an approved merge approval with a passing gate enqueues one merge outbox record", async () => {
  const records = [mergeRequestEntity({ approvalId: "ap-1" })];
  const { ctx, upserts } = mockCtx(records);
  await handleMergeApprovalDecided(ctx, config, {
    approvalId: "ap-1", decision: "approved", status: "approved", type: "external_automation", sourcePluginId: "insightflo.github-repository-bridge",
  }, records[0]);
  const outbox = upserts.find((u) => u.entityType === "github-merge-dispatch");
  assert.ok(outbox);
  assert.equal(outbox.externalId, mergeOutboxExternalId("ap-1", SHA));
  assert.equal(outbox.data.status, "pending");
});

test("an approved merge approval for a changed head never enqueues a merge", async () => {
  const records = [mergeRequestEntity({ approvalId: "ap-2" })];
  const { ctx, upserts, logs } = mockCtx(records);
  ctx.http = mergeHttp({ pr: prJson({ headSha: OTHER_SHA }) });
  await handleMergeApprovalDecided(ctx, config, {
    approvalId: "ap-2", decision: "approved", status: "approved", type: "external_automation", sourcePluginId: "insightflo.github-repository-bridge",
  }, records[0]);
  assert.equal(upserts.find((u) => u.entityType === "github-merge-dispatch"), undefined);
  assert.ok(logs.some((l) => /merge suppressed/.test(l.message)));
});

test("a rejected merge approval never enqueues a merge", async () => {
  const records = [mergeRequestEntity({ approvalId: "ap-3" })];
  const { ctx, upserts } = mockCtx(records);
  await handleMergeApprovalDecided(ctx, config, {
    approvalId: "ap-3", decision: "rejected", status: "rejected", type: "external_automation", sourcePluginId: "insightflo.github-repository-bridge",
  }, records[0]);
  assert.equal(upserts.find((u) => u.entityType === "github-merge-dispatch"), undefined);
});

test("a superseded merge approval never enqueues even when approved", async () => {
  const records = [mergeRequestEntity({ approvalId: "ap-4", superseded: true })];
  const { ctx, upserts, logs } = mockCtx(records);
  await handleMergeApprovalDecided(ctx, config, {
    approvalId: "ap-4", decision: "approved", status: "approved", type: "external_automation", sourcePluginId: "insightflo.github-repository-bridge",
  }, records[0]);
  assert.equal(upserts.find((u) => u.entityType === "github-merge-dispatch"), undefined);
  assert.ok(logs.some((l) => /suppressed merge for superseded/.test(l.message)));
});

test("a duplicate approve does not create a second merge outbox record", async () => {
  const records = [
    mergeRequestEntity({ approvalId: "ap-5" }),
    { ...outboxRecord({ approvalId: "ap-5" }), data: { ...outboxRecord({ approvalId: "ap-5" }).data, status: "sent" }, status: "sent" },
  ];
  const { ctx, upserts } = mockCtx(records);
  await handleMergeApprovalDecided(ctx, config, {
    approvalId: "ap-5", decision: "approved", status: "approved", type: "external_automation", sourcePluginId: "insightflo.github-repository-bridge",
  }, records[0]);
  assert.equal(upserts.filter((u) => u.entityType === "github-merge-dispatch").length, 0);
});

test("handleApprovalDecided routes a merge approval to the merge outbox, not the deploy outbox", async () => {
  const records = [mergeRequestEntity({ approvalId: "ap-route" })];
  const { ctx, upserts } = mockCtx(records);
  await handleApprovalDecided(ctx, config, {
    approvalId: "ap-route", decision: "approved", status: "approved", type: "external_automation", sourcePluginId: "insightflo.github-repository-bridge",
  });
  assert.ok(upserts.find((u) => u.entityType === "github-merge-dispatch"), "merge outbox should be enqueued");
  assert.equal(upserts.find((u) => u.entityType === "github-deploy-dispatch"), undefined, "deploy outbox must not be touched");
});

test("a pending merge outbox record performs an exact-revision squash merge and marks sent", async () => {
  const records = [outboxRecord({ approvalId: "ap-m1" })];
  const { ctx, upserts } = mockCtx(records);
  const calls = [];
  ctx.http = mergeHttp({ onCall: (u, i) => calls.push({ u, i }) });
  await drainMergeOutbox(ctx, config);
  const updated = upserts.find((entry) => entry.entityType === "github-merge-dispatch");
  assert.equal(updated.data.status, "sent");
  const mergeCall = calls.find((c) => /\/merge$/.test(c.u));
  assert.ok(mergeCall, "expected a PUT /pulls/{n}/merge call");
  const body = JSON.parse(mergeCall.i.body);
  assert.equal(body.merge_method, "squash");
  assert.equal(body.sha, SHA); // exact-revision pin
});

test("a changed head during drain is a terminal failure that never merges", async () => {
  const records = [outboxRecord({ approvalId: "ap-m2" })];
  const { ctx, upserts } = mockCtx(records);
  const calls = [];
  ctx.http = mergeHttp({ pr: prJson({ headSha: OTHER_SHA }), onCall: (u) => calls.push(u) });
  await drainMergeOutbox(ctx, config);
  const updated = upserts.find((entry) => entry.entityType === "github-merge-dispatch");
  assert.equal(updated.data.status, "failed");
  assert.equal(updated.data.attempts, 1); // terminal immediately, no retry
  assert.equal(calls.some((u) => /\/merge$/.test(u)), false, "must not call the merge endpoint");
});

test("an already-merged PR drains to sent without calling the merge endpoint", async () => {
  const records = [outboxRecord({ approvalId: "ap-m3" })];
  const { ctx, upserts } = mockCtx(records);
  const calls = [];
  ctx.http = mergeHttp({ pr: prJson({ merged: true, state: "closed" }), onCall: (u) => calls.push(u) });
  await drainMergeOutbox(ctx, config);
  assert.equal(upserts.at(-1).data.status, "sent");
  assert.equal(calls.some((u) => /\/merge$/.test(u)), false);
});

test("a transient merge failure retries and stays pending within the budget", async () => {
  const records = [outboxRecord({ approvalId: "ap-m4" })];
  const { ctx, upserts } = mockCtx(records);
  ctx.http = mergeHttp({ mergeStatus: 500 });
  await drainMergeOutbox(ctx, config);
  const updated = upserts.find((entry) => entry.entityType === "github-merge-dispatch");
  assert.equal(updated.data.status, "pending");
  assert.equal(updated.data.attempts, 1);
});

test("a 2xx merge response that does not confirm merged:true is a terminal failure that never merges", async () => {
  const records = [outboxRecord({ approvalId: "ap-m6" })];
  const { ctx, upserts } = mockCtx(records);
  ctx.http = mergeHttp({ mergeStatus: 200, mergeMerged: false });
  await drainMergeOutbox(ctx, config);
  const updated = upserts.find((entry) => entry.entityType === "github-merge-dispatch");
  assert.equal(updated.data.status, "failed");
  assert.equal(updated.data.attempts, 1); // terminal: no retry
});

test("the steward endpoint authenticates via HMAC and forwards a valid PASS", async () => {
  const { ctx, approvals } = mockCtx([]);
  const rawBody = JSON.stringify(stewardReq());
  const input = {
    endpointKey: "steward-merge-request",
    rawBody,
    parsedBody: JSON.parse(rawBody),
    requestId: "r1",
    headers: { "x-pc-signature-256": `sha256=${createHmac("sha256", "resolved:STEWARD").update(rawBody).digest("hex")}` },
  };
  await processStewardMergeRequest(ctx, input);
  assert.equal(approvals.length, 1);
});

test("the steward endpoint rejects an unsigned or bad signature", async () => {
  const { ctx, approvals } = mockCtx([]);
  const rawBody = JSON.stringify(stewardReq());
  const input = {
    endpointKey: "steward-merge-request",
    rawBody,
    parsedBody: JSON.parse(rawBody),
    requestId: "r2",
    headers: { "x-pc-signature-256": "sha256=deadbeef" + "0".repeat(56) },
  };
  await assert.rejects(processStewardMergeRequest(ctx, input), /signature/i);
  assert.equal(approvals.length, 0);
});
