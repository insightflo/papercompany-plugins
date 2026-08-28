import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import worker from "../src/worker.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { DispatchHistoryEntry } from "../src/history.js";

type HttpCall = { url: string; init?: RequestInit };

const BRIDGE_SUCCESS_BODY = {
  ok: true,
  message: "echo",
  url: "https://blog.naver.com/tester/123",
  title: "테스트 디스패치",
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

function readHistory(harness: Awaited<ReturnType<typeof setupHarness>>): DispatchHistoryEntry[] {
  return (harness.getState({ scopeKind: "instance", stateKey: "dispatch-history" }) ?? []) as DispatchHistoryEntry[];
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor 조건이 시간 내 충족되지 않았습니다.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function headerOf(call: HttpCall, name: string): string {
  const headers = call.init?.headers as Record<string, string> | undefined;
  if (!headers) return "";
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? "";
}

describe("pc-bridge worker: agent tool", () => {
  it("forwards {handler, params} verbatim to the mac bridge /dispatch and returns the result", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    const params = { url: "https://gazua.showk.ing/morning/2026-08-28", workflow: "gazua-morning" };
    const result = await harness.executeTool("pc-bridge-dispatch", {
      handler: "naver-publish",
      params,
    });

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("PC 브리지 디스패치 완료");
    expect(result.content).toContain("naver-publish");
    expect(result.content).toContain("https://blog.naver.com/tester/123");
    expect(result.data).toMatchObject({
      ok: true,
      httpStatus: 200,
      permalink: "https://blog.naver.com/tester/123",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8930/dispatch");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(headerOf(calls[0]!, "X-Papercompany-Webhook-Key")).toBe("test-webhook-key");
    expect(headerOf(calls[0]!, "content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      handler: "naver-publish",
      params,
    });

    const history = readHistory(harness);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      source: "tool",
      handler: "naver-publish",
      ok: true,
      permalink: "https://blog.naver.com/tester/123",
      title: "테스트 디스패치",
      imageCount: 3,
    });
    expect(history[0]?.paramsSnapshot).toContain("gazua-morning");
  });

  it("passes arbitrary handler params through without inspecting them", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse({ ok: true, message: "echo" }));

    const result = await harness.executeTool("pc-bridge-dispatch", {
      handler: "echo-test",
      params: { hello: "world", nested: { list: [1, 2] } },
    });

    expect(result.error).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      handler: "echo-test",
      params: { hello: "world", nested: { list: [1, 2] } },
    });
  });

  it("forwards an empty params object when omitted", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse({ ok: true }));

    await harness.executeTool("pc-bridge-dispatch", { handler: "echo-test" });

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ handler: "echo-test", params: {} });
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

    const result = await harness.executeTool("pc-bridge-dispatch", {
      handler: "echo-test",
      params: {},
    });

    expect(result.error).toBeUndefined();
    expect(headerOf(calls[0]!, "X-Papercompany-Webhook-Key")).toBe("secret-key-value");
  });

  it("rejects a malformed handler name without contacting the bridge", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    const result = await harness.executeTool("pc-bridge-dispatch", {
      handler: "../handlers/evil",
      params: {},
    });

    expect(result.error).toContain("[a-z0-9-]");
    expect(calls).toHaveLength(0);
    expect(readHistory(harness)).toHaveLength(0);
  });

  it("rejects non-object params without contacting the bridge", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    const result = await harness.executeTool("pc-bridge-dispatch", {
      handler: "echo-test",
      params: ["not", "an", "object"],
    });

    expect(result.error).toContain("JSON 객체");
    expect(calls).toHaveLength(0);
  });

  it("fails closed when no webhook key is configured", async () => {
    const harness = await setupHarness({ config: { bridgeBaseUrl: "http://127.0.0.1:8930" } });
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    const result = await harness.executeTool("pc-bridge-dispatch", {
      handler: "echo-test",
      params: {},
    });

    expect(result.error).toContain("웹훅 키가 설정되지 않았습니다");
    expect(calls).toHaveLength(0);
  });

  it("returns the bridge's own failure body when the bridge reports ok:false (e.g. handler params error)", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse({
      ok: false,
      error: "invalid-params",
      message: "URL 화이트리스트 위반: https://evil.com (핸들러 판정)",
    }));

    const result = await harness.executeTool("pc-bridge-dispatch", {
      handler: "naver-publish",
      params: { url: "https://evil.com", workflow: "gazua-morning" },
    });

    expect(result.error).toContain("URL 화이트리스트 위반");
    expect(result.data).toMatchObject({ ok: false, httpStatus: 200 });

    const history = readHistory(harness);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      ok: false,
      error: "invalid-params",
      message: "URL 화이트리스트 위반: https://evil.com (핸들러 판정)",
    });
  });

  it("surfaces handler-not-found (404) from the bridge", async () => {
    const harness = await setupHarness();
    installHttp(harness.ctx, [], () => jsonResponse(
      { ok: false, error: "handler-not-found", message: "등록되지 않았거나 실행 불가한 핸들러: nope" },
      404,
    ));

    const result = await harness.executeTool("pc-bridge-dispatch", {
      handler: "nope",
      params: {},
    });

    expect(result.error).toContain("등록되지 않았거나");
    const history = readHistory(harness);
    expect(history[0]).toMatchObject({ ok: false, httpStatus: 404 });
  });

  it("surfaces transport failures and records them in history", async () => {
    const harness = await setupHarness();
    installHttp(harness.ctx, [], () => new Response("upstream unavailable", { status: 502 }));

    const result = await harness.executeTool("pc-bridge-dispatch", {
      handler: "echo-test",
      params: {},
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

    for (const handler of ["a-one", "b-two", "c-three"]) {
      await harness.executeTool("pc-bridge-dispatch", { handler, params: {} });
    }

    const history = readHistory(harness);
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.handler)).toEqual(["c-three", "b-two"]);
  });

  it("caps oversized params snapshots in history", async () => {
    const harness = await setupHarness();
    installHttp(harness.ctx, [], () => jsonResponse(BRIDGE_SUCCESS_BODY));

    await harness.executeTool("pc-bridge-dispatch", {
      handler: "echo-test",
      params: { blob: "x".repeat(5000) },
    });

    const snapshot = readHistory(harness)[0]?.paramsSnapshot ?? "";
    expect(snapshot.length).toBeLessThanOrEqual(2001);
    expect(snapshot.endsWith("…")).toBe(true);
  });
});

describe("pc-bridge worker: UI action and status", () => {
  it("dispatches via the UI action and reports source=ui", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    const outcome = await harness.performAction<{
      entry?: DispatchHistoryEntry;
      result?: { ok: boolean };
    }>("dispatch", { handler: "echo-test", params: { k: 1 } });

    expect(outcome.result?.ok).toBe(true);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8930/dispatch");
    expect(readHistory(harness)[0]).toMatchObject({ source: "ui", handler: "echo-test" });
  });

  it("reports status without probing the bridge (tunnel loopback is not directly checkable)", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    const status = await harness.getData<{
      config: { bridgeBaseUrl: string; webhookKeyConfigured: boolean };
      healthNote: string;
      chainDoc: string;
      dispatchPath: string;
      history: DispatchHistoryEntry[];
    }>("status");

    // 어떤 HTTP 호출도 일어나지 않아야 한다 — /health 프로브 없음
    expect(calls).toHaveLength(0);
    expect(status.config).toMatchObject({
      bridgeBaseUrl: "http://127.0.0.1:8930",
      webhookKeyConfigured: true,
    });
    expect(status.dispatchPath).toBe("/dispatch");
    expect(status.healthNote).toContain("직접 상태를 확인할 수 없습니다");
    expect(status.chainDoc).toContain("handlers/");
    expect(status.history).toEqual([]);
  });
});

describe("pc-bridge worker: webhook endpoint (fire-and-forget)", () => {
  function webhookInput(body: unknown, headers: Record<string, string>) {
    return {
      endpointKey: "dispatch",
      headers,
      rawBody: JSON.stringify(body),
      parsedBody: body,
      requestId: "req-1",
    };
  }

  it("accepts a correctly keyed request, records source=webhook, and resolves before the bridge settles", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    let releaseBridge: (() => void) | undefined;
    installHttp(harness.ctx, calls, () => new Promise<Response>((resolve) => {
      releaseBridge = () => resolve(jsonResponse(BRIDGE_SUCCESS_BODY));
    }));

    await worker.definition.onWebhook?.(webhookInput(
      { handler: "echo-test", params: { hello: "world" } },
      { "X-Papercompany-Webhook-Key": "test-webhook-key" },
    ));

    // fire-and-forget: 웹훅 핸들러는 브리지 응답을 기다리지 않고 반환한다
    await waitFor(() => calls.length > 0);
    releaseBridge?.();

    await waitFor(() => readHistory(harness).length > 0);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8930/dispatch");
    expect(headerOf(calls[0]!, "x-papercompany-webhook-key")).toBe("test-webhook-key");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      handler: "echo-test",
      params: { hello: "world" },
    });
    expect(readHistory(harness)[0]).toMatchObject({ source: "webhook", handler: "echo-test" });
  });

  it("rejects a request with a missing or wrong key", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    await expect(worker.definition.onWebhook?.(webhookInput(
      { handler: "echo-test", params: {} },
      {},
    ))).rejects.toThrow(/X-Papercompany-Webhook-Key/);

    await expect(worker.definition.onWebhook?.(webhookInput(
      { handler: "echo-test", params: {} },
      { "X-Papercompany-Webhook-Key": "wrong-key" },
    ))).rejects.toThrow(/X-Papercompany-Webhook-Key/);

    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed handler name synchronously with the validation error", async () => {
    const harness = await setupHarness();
    const calls: HttpCall[] = [];
    installHttp(harness.ctx, calls, () => jsonResponse(BRIDGE_SUCCESS_BODY));

    await expect(worker.definition.onWebhook?.(webhookInput(
      { handler: "BAD_NAME", params: {} },
      { "X-Papercompany-Webhook-Key": "test-webhook-key" },
    ))).rejects.toThrow(/\[a-z0-9-\]/);

    expect(calls).toHaveLength(0);
  });

  it("rejects an unparseable body", async () => {
    const harness = await setupHarness();

    await expect(worker.definition.onWebhook?.({
      endpointKey: "dispatch",
      headers: { "X-Papercompany-Webhook-Key": "test-webhook-key" },
      rawBody: "not-json{",
      requestId: "req-2",
    })).rejects.toThrow(/파싱/);
  });

  it("rejects unknown endpoint keys", async () => {
    const harness = await setupHarness();

    await expect(worker.definition.onWebhook?.({
      endpointKey: "publish",
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
