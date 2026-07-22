import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { handleApprovalDecided, drainOutbox, processCommitCheck } from "../src/deploy-approvals.ts";
import { outboxExternalId } from "../src/dispatch-outbox.ts";

const route = {
  repository: "acme/runtime",
  companyId: "c1",
  projectId: "p1",
  projectWorkspaceId: "w1",
  stewardAgentId: "a1",
  deployApprovals: {
    branch: "main",
    requiredChecks: ["verify"],
    approvalTitle: "Deploy acme/runtime main",
    dispatch: { endpointRef: "URL", tokenRef: "TOKEN", eventType: "deploy" },
  },
};
const config = { webhookSecretRef: "S", shadowMode: true, repositories: [route] };

function mockCtx(observations) {
  const upserts = [];
  const logs = [];
  const approvals = [];
  const ctx = {
    entities: {
      async list({ entityType, externalId }) {
        if (entityType === "github-deploy-approval") {
          if (externalId) return observations.filter((o) => o.externalId === externalId);
          return observations;
        }
        if (entityType === "github-deploy-dispatch") {
          if (externalId) return observations.filter((o) => o.externalId === externalId && o.entityType === "github-deploy-dispatch");
          return observations.filter((o) => o.entityType === "github-deploy-dispatch");
        }
        return [];
      },
      async upsert(input) {
        upserts.push(input);
        const existing = observations.find((o) => o.externalId === input.externalId && o.entityType === input.entityType);
        const record = { externalId: input.externalId, entityType: input.entityType, data: input.data, status: input.status };
        if (existing) Object.assign(existing, record);
        else observations.push(record);
        return record;
      },
    },
    activity: { async log(input) { logs.push(input); } },
    approvals: {
      async create(input) {
        const approval = { id: `approval-${approvals.length + 1}`, ...input };
        approvals.push(approval);
        return approval;
      },
    },
    logger: { info() {}, warn() {} },
  };
  return { ctx, upserts, logs, approvals };
}

function observation({ approvalId, sha, superseded = false }) {
  return {
    externalId: `obs:acme/runtime:${sha}`,
    entityType: "github-deploy-approval",
    status: superseded ? "superseded" : "approval-created",
    data: {
      repository: "acme/runtime",
      branch: "main",
      sha,
      companyId: "c1",
      approvalId,
      superseded,
      supersededBy: superseded ? "newersha" : null,
      observedChecks: [],
      checksReady: !superseded,
    },
  };
}

test("an approved non-superseded observation enqueues one dispatch keyed by approvalId+SHA", async () => {
  const { ctx, upserts } = mockCtx([observation({ approvalId: "ap-1", sha: "deadbeef" })]);
  await handleApprovalDecided(ctx, config, {
    approvalId: "ap-1", decision: "approved", status: "approved", type: "external_automation", sourcePluginId: "insightflo.github-repository-bridge",
  });
  const outbox = upserts.find((u) => u.entityType === "github-deploy-dispatch");
  assert.ok(outbox, "expected an outbox upsert");
  assert.equal(outbox.externalId, outboxExternalId("ap-1", "deadbeef"));
});

test("an approved observation accepts the Runtime installation ID as sourcePluginId", async () => {
  const { ctx, upserts } = mockCtx([observation({ approvalId: "ap-runtime-id", sha: "feedface" })]);
  await handleApprovalDecided(ctx, config, {
    approvalId: "ap-runtime-id",
    decision: "approved",
    status: "approved",
    type: "external_automation",
    sourcePluginId: "10982117-aa04-4fb2-950a-4b2a8b2e65b2",
  });
  const outbox = upserts.find((u) => u.entityType === "github-deploy-dispatch");
  assert.ok(outbox, "expected the plugin-owned observation to establish approval ownership");
  assert.equal(outbox.externalId, outboxExternalId("ap-runtime-id", "feedface"));
});

test("an approval with no plugin-owned observation never enqueues a dispatch", async () => {
  const { ctx, upserts } = mockCtx([]);
  await handleApprovalDecided(ctx, config, {
    approvalId: "foreign-approval",
    decision: "approved",
    status: "approved",
    type: "external_automation",
    sourcePluginId: "some-runtime-installation-id",
  });
  assert.equal(upserts.find((u) => u.entityType === "github-deploy-dispatch"), undefined);
});

test("a superseded observation never enqueues a dispatch even when later approved", async () => {
  const { ctx, upserts, logs } = mockCtx([observation({ approvalId: "ap-old", sha: "oldsha", superseded: true })]);
  await handleApprovalDecided(ctx, config, {
    approvalId: "ap-old", decision: "approved", status: "approved", type: "external_automation", sourcePluginId: "insightflo.github-repository-bridge",
  });
  const outbox = upserts.find((u) => u.entityType === "github-deploy-dispatch");
  assert.equal(outbox, undefined);
  assert.ok(logs.some((l) => /suppressed dispatch for superseded/.test(l.message)));
});

test("a duplicate approve does not create a second outbox record", async () => {
  const existing = [{ externalId: outboxExternalId("ap-1", "deadbeef"), entityType: "github-deploy-dispatch", data: { status: "sent" }, status: "sent" }];
  const { ctx, upserts } = mockCtx([observation({ approvalId: "ap-1", sha: "deadbeef" }), ...existing]);
  await handleApprovalDecided(ctx, config, {
    approvalId: "ap-1", decision: "approved", status: "approved", type: "external_automation", sourcePluginId: "insightflo.github-repository-bridge",
  });
  const created = upserts.filter((u) => u.entityType === "github-deploy-dispatch");
  assert.equal(created.length, 0);
});

test("a rejected approval never enqueues a dispatch", async () => {
  const { ctx, upserts } = mockCtx([observation({ approvalId: "ap-2", sha: "cafebabe" })]);
  await handleApprovalDecided(ctx, config, {
    approvalId: "ap-2", decision: "rejected", status: "rejected", type: "external_automation", sourcePluginId: "insightflo.github-repository-bridge",
  });
  const outbox = upserts.find((u) => u.entityType === "github-deploy-dispatch");
  assert.equal(outbox, undefined);
});

test("a successful main-branch check creates an approval without a push delivery", async () => {
  const { ctx, upserts, approvals } = mockCtx([]);

  await processCommitCheck(ctx, config, {
    repository: "acme/runtime",
    branch: "main",
    sha: "deadbeefcafebabedeadbeefcafebabedeadbeef",
    name: "verify",
    status: "completed",
    conclusion: "success",
    url: "https://example/check",
    source: "check_run",
  });

  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].payload.commit, "deadbeefcafebabedeadbeefcafebabedeadbeef");
  const observation = upserts.find(
    (entry) => entry.entityType === "github-deploy-approval" && entry.data.approvalId === approvals[0].id,
  );
  assert.equal(observation?.data.branch, "main");
  assert.equal(observation?.data.approvalId, approvals[0].id);
});

test("a failed Operations dispatch remains durable and writes an approval-linked activity", async () => {
  const approvalId = "ap-failed";
  const sha = "deadbeefcafebabe1234567890abcdefdeadbeef";
  const records = [{
    externalId: outboxExternalId(approvalId, sha),
    entityType: "github-deploy-dispatch",
    status: "pending",
    data: {
      approvalId,
      sha,
      repository: "acme/runtime",
      branch: "main",
      status: "pending",
      attempts: 0,
      lastError: null,
      payload: { eventType: "deploy", approvalId, commit: sha, repository: "acme/runtime", branch: "main" },
    },
  }];
  const { ctx, upserts, logs } = mockCtx(records);
  ctx.secrets = { async resolve() { return "resolved"; } };
  ctx.http = { async fetch() { return { status: 503 }; } };

  await drainOutbox(ctx, config);

  const updated = upserts.find((entry) => entry.entityType === "github-deploy-dispatch");
  assert.equal(updated?.data.status, "pending");
  assert.equal(updated?.data.attempts, 1);
  assert.ok(logs.some((entry) => entry.entityId === approvalId && /HTTP 503/.test(entry.message)));
});

test("a GitHub App dispatch mints an installation token before sending", async () => {
  const approvalId = "ap-github-app";
  const sha = "cafebabecafebabecafebabecafebabecafebabe";
  const records = [{
    externalId: outboxExternalId(approvalId, sha),
    entityType: "github-deploy-dispatch",
    status: "pending",
    data: {
      approvalId,
      sha,
      repository: "acme/runtime",
      branch: "main",
      status: "pending",
      attempts: 0,
      lastError: null,
      payload: { eventType: "deploy", approvalId, commit: sha, repository: "acme/runtime", branch: "main" },
    },
  }];
  const appRoute = structuredClone(route);
  appRoute.deployApprovals.dispatch = {
    endpointRef: "URL",
    eventType: "deploy",
    githubApp: {
      appIdRef: "APP_ID",
      privateKeyRef: "PRIVATE_KEY",
      installationRepository: "acme/operations",
    },
  };
  const appConfig = { ...config, repositories: [appRoute] };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const { ctx, upserts } = mockCtx(records);
  ctx.secrets = {
    async resolve(ref) {
      return { URL: "https://api.github.com/repos/acme/operations/dispatches", APP_ID: "12345", PRIVATE_KEY: privateKeyPem }[ref];
    },
  };
  const calls = [];
  ctx.http = {
    async fetch(url, init) {
      calls.push({ url, init });
      if (url.endsWith("/installation")) return new Response(JSON.stringify({ id: 9876 }), { status: 200 });
      if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      return new Response(null, { status: 204 });
    },
  };

  await drainOutbox(ctx, appConfig);

  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /repos\/acme\/operations\/installation$/);
  assert.match(calls[1].url, /app\/installations\/9876\/access_tokens$/);
  assert.equal(calls[2].init.headers.authorization, "Bearer installation-token");
  assert.equal(calls[2].init.headers["user-agent"], "papercompany-github-repository-bridge");
  assert.equal(upserts.at(-1)?.data.status, "sent");
});
