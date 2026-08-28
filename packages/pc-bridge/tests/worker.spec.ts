import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import worker from "../src/worker.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { PublishHistoryEntry } from "../src/history.js";

type HttpCall = { url: string; init?: RequestInit };

const ONBOARDING_URL = "https://manual-onboarding.pages.dev/posts/example";
const GAZUA_URL = "https://gazua.showk.ing/morning/2026-08-28";

const BRIDGE_SUCCESS_BODY = {
  ok: true,
  message: "발행 완료",
  url: "https://blog.naver.com/tester/123",
  category: "AI뉴스",
  title: "테스트 발행",
  image_count: 3,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installHttp(
  ctx: PluginContext,
  calls: HttpCall[],
  handler: (call: HttpCall) => Response,
): void {
  ctx.http = {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      const call = { url, init };
      calls.push(call);
      return handler(call);
    },
  };
}

function headerOf(call: HttpCall, name: string): string {
  const headers = call.init?.headers as Record<string, string> | undefined;
  if (!headers) return "";
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? "";
}

async function setupHarness(options?: {
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
}) {
  const harness = createTestHarness({
    manifest,
    config: options?.config ?? {
      bridgeBaseUrl: "http://127.0.0.1:8930",
      webhookKey: "test-webhook-key",
    },
  });

  if (options?.secrets) {
    const secrets = options.secrets;
    harness.ctx.secrets = {
      async resolve(secretRef: string): Promise<string> {
        if (!(secretRef in secrets)) {
          throw new Error(`unknown secret ref: ${secretRef}`);
        }
        return secrets[secretRef];
      },
    };
  }

  await worker.definition.setup(harness.ctx);
  return harness;
}

function readHistory(harness: Awaited<ReturnType<typeof setupHarness>>): PublishHistoryEntry[] {
  return (harness.getState({ scopeKind: "instance", stateKey: "publish-history" }) ?? []) as PublishHistoryEntry[];
}

describe("pc-bridge worker: agent tool", () => {
  it("proxies a workflow publish to the mac bridge and returns the result", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    const result = await harness.executeTool("pc-bridge-publish", {
      url: GAZUA_URL,
      workflow: "gazua-morning",
    });

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("PC 브리지 발행 완료");
    expect(result.content).toContain("https://blog.naver.com/tester/123");
    expect(result.data).toMatchObject({
      ok: true,
      httpStatus: 200,
      permalink: "https://blog.naver.com/tester/123",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8930/naver-publish");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headerOf(calls[0]!, "X-Papercompany-Webhook-Key")).toBe("test-webhook-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      url: GAZUA_URL,
      workflow: "gazua-morning",
    });

    const history = readHistory(harness);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      source: "tool",
      url: GAZUA_URL,
      workflow: "gazua-morning",
      category: "AI뉴스",
      ok: true,
      permalink: "https://blog.naver.com/tester/123",
      title: "테스트 발행",
      imageCount: 3,
    });
  });

  it("proxies a direct category publish and forwards the payload as-is", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    const body = { ...BRIDGE_SUCCESS_BODY, ok: true, category: "AI개념" };
    installHttp(harness.ctx, calls, () => jsonResponse(body));

    const result = await harness.executeTool("pc-bridge-publish", {
      url: ONBOARDING_URL,
      category: "AI개념",
    });

    expect(result.error).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      url: ONBOARDING_URL,
      category: "AI개념",
    });

    const history = readHistory(harness);
    expect(history[0]).toMatchObject({ category: "AI개념", workflow: null });
  });

  it("resolves the webhook key from a secret reference when configured", async () => {
    const harness = await setupHarness({
      config: {
        bridgeBaseUrl: "http://127.0.0.1:8930",
        webhookKeyRef: "pc-bridge/webhook-key",
      },
      secrets: { "pc-bridge/webhook-key": "secret-key-value" },
    });
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    const result = await harness.executeTool("pc-bridge-publish", {
      url: GAZUA_URL,
      workflow: "gazua-evening",
    });

    expect(result.error).toBeUndefined();
    expect(headerOf(calls[0]!, "X-Papercompany-Webhook-Key")).toBe("secret-key-value");
  });

  it("rejects an invalid url without contacting the bridge", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    const result = await harness.executeTool("pc-bridge-publish", {
      url: "https://evil.com/post",
      workflow: "tech-ai-news",
    });

    expect(result.error).toContain("허용되지 않은 호스트");
    expect(calls).toHaveLength(0);
    expect(readHistory(harness)).toHaveLength(0);
  });

  it("rejects an unknown workflow without contacting the bridge", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    const result = await harness.executeTool("pc-bridge-publish", {
      url: ONBOARDING_URL,
      workflow: "does-not-exist",
    });

    expect(result.error).toContain("does-not-exist");
    expect(calls).toHaveLength(0);
  });

  it("fails closed when no webhook key is configured", async () => {
    const harness = await setupHarness({ config: { bridgeBaseUrl: "http://127.0.0.1:8930" } });
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    const result = await harness.executeTool("pc-bridge-publish", {
      url: ONBOARDING_URL,
      workflow: "tech-ai-news",
    });

    expect(result.error).toContain("웹훅 키가 설정되지 않았습니다");
    expect(calls).toHaveLength(0);
  });

  it("returns the bridge's own failure body when the bridge reports ok:false", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse({
      ok: false,
      error: "login_failed",
      message: "네이버 로그인에 실패했습니다.",
    }));

    const result = await harness.executeTool("pc-bridge-publish", {
      url: ONBOARDING_URL,
      workflow: "tech-ai-news",
    });

    expect(result.error).toContain("네이버 로그인에 실패했습니다.");
    expect(result.data).toMatchObject({ ok: false, httpStatus: 200 });

    const history = readHistory(harness);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      ok: false,
      error: "login_failed",
      message: "네이버 로그인에 실패했습니다.",
    });
  });

  it("surfaces transport failures and records them in history", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => new Response("upstream unavailable", { status: 502 }));

    const result = await harness.executeTool("pc-bridge-publish", {
      url: ONBOARDING_URL,
      workflow: "tech-ai-news",
    });

    expect(result.error).toContain("HTTP 502");
    const history = readHistory(harness);
    expect(history[0]).toMatchObject({ ok: false, httpStatus: 502 });
  });

  it("caps stored history at the configured limit", async () => {
    const harness = await setupHarness({
      config: {
        bridgeBaseUrl: "http://127.0.0.1:8930",
        webhookKey: "test-webhook-key",
        historyLimit: 2,
      },
    });
    installHttp(harness.ctx, [], () => jsonResponse(BRIDGE_SUCCESS_BODY));

    for (const workflow of ["tech-ai-news", "tech-ai-scout", "agent-team-concept-radar"]) {
      await harness.executeTool("pc-bridge-publish", { url: ONBOARDING_URL, workflow });
    }

    const history = readHistory(harness);
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.workflow)).toEqual(["agent-team-concept-radar", "tech-ai-scout"]);
  });
});

describe("pc-bridge worker: UI action and status", () => {
  it("publishes via the UI action and reports source=ui", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    const outcome = await harness.performAction<{
      entry?: PublishHistoryEntry;
      result?: { ok: boolean };
    }>("publish", { url: GAZUA_URL, workflow: "gazua-morning" });

    expect(outcome.result?.ok).toBe(true);
    expect(readHistory(harness)[0]).toMatchObject({ source: "ui" });
  });

  it("reports healthy status from the mac bridge /health endpoint", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, (call) => {
      if (call.url.endsWith("/health")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse(BRIDGE_SUCCESS_BODY);
    });

    const status = await harness.getData<{
      health: { reachable: boolean; healthy: boolean; httpStatus: number | null; detail: string };
      config: { bridgeBaseUrl: string; webhookKeyConfigured: boolean };
      workflows: Array<{ workflow: string; category: string }>;
      history: PublishHistoryEntry[];
    }>("status");

    expect(calls[0]?.url).toBe("http://127.0.0.1:8930/health");
    expect(status.health).toMatchObject({ reachable: true, healthy: true, httpStatus: 200 });
    expect(status.config).toMatchObject({
      bridgeBaseUrl: "http://127.0.0.1:8930",
      webhookKeyConfigured: true,
    });
    expect(status.workflows).toHaveLength(6);
    expect(status.workflows[0]).toEqual({ workflow: "tech-ai-news", category: "AI뉴스" });
  });

  it("reports unreachable status when the bridge is down", async () => {
    const harness = await setupHarness();
    harness.ctx.http = {
      async fetch(): Promise<Response> {
        throw new Error("connection refused (tunnel down)");
      },
    };

    const status = await harness.getData<{
      health: { reachable: boolean; healthy: boolean; detail: string };
    }>("status");

    expect(status.health.reachable).toBe(false);
    expect(status.health.healthy).toBe(false);
    expect(status.health.detail).toContain("connection refused");
  });
});

describe("pc-bridge worker: webhook endpoint", () => {
  function webhookInput(body: unknown, headers: Record<string, string>) {
    return {
      endpointKey: "publish",
      headers,
      rawBody: JSON.stringify(body),
      parsedBody: body,
      requestId: "req-1",
    };
  }

  it("accepts a correctly keyed publish request and records source=webhook", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    await worker.definition.onWebhook?.(webhookInput(
      { url: GAZUA_URL, workflow: "gazua-morning" },
      { "X-Papercompany-Webhook-Key": "test-webhook-key" },
    ));

    expect(calls).toHaveLength(1);
    expect(headerOf(calls[0]!, "x-papercompany-webhook-key")).toBe("test-webhook-key");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      url: GAZUA_URL,
      workflow: "gazua-morning",
    });
    expect(readHistory(harness)[0]).toMatchObject({ source: "webhook" });
  });

  it("rejects a request with a missing or wrong key", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    await expect(worker.definition.onWebhook?.(webhookInput(
      { url: GAZUA_URL, workflow: "gazua-morning" },
      {},
    ))).rejects.toThrow(/X-Papercompany-Webhook-Key/);

    await expect(worker.definition.onWebhook?.(webhookInput(
      { url: GAZUA_URL, workflow: "gazua-morning" },
      { "X-Papercompany-Webhook-Key": "wrong-key" },
    ))).rejects.toThrow(/X-Papercompany-Webhook-Key/);

    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid payload with the validation error", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    await expect(worker.definition.onWebhook?.(webhookInput(
      { url: "https://evil.com/x", workflow: "tech-ai-news" },
      { "X-Papercompany-Webhook-Key": "test-webhook-key" },
    ))).rejects.toThrow(/허용되지 않은 호스트/);

    expect(calls).toHaveLength(0);
  });

  it("rejects an unparseable body", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    await expect(worker.definition.onWebhook?.({
      endpointKey: "publish",
      headers: { "X-Papercompany-Webhook-Key": "test-webhook-key" },
      rawBody: "not-json{",
      requestId: "req-2",
    })).rejects.toThrow(/파싱/);

    expect(calls).toHaveLength(0);
  });

  it("rejects unknown endpoint keys", async () => {
    const harness = await setupHarness();

    await expect(worker.definition.onWebhook?.({
      endpointKey: "other",
      headers: {},
      rawBody: "{}",
      requestId: "req-3",
    })).rejects.toThrow(/지원하지 않는 웹훅/);
  });
});

describe("pc-bridge worker: config validation", () => {
  it("accepts a valid config and warns when no key is set", async () => {
    const result = await worker.definition.onValidateConfig?.({
      bridgeBaseUrl: "http://127.0.0.1:8930",
    });

    expect(result?.ok).toBe(true);
    expect(result?.warnings?.join(" ")).toContain("웹훅 키");
  });

  it("rejects a malformed bridge base url", async () => {
    const result = await worker.definition.onValidateConfig?.({
      bridgeBaseUrl: "not a url",
      webhookKey: "k",
    });

    expect(result?.ok).toBe(false);
    expect(result?.errors?.join(" ")).toContain("bridgeBaseUrl");
  });
});
