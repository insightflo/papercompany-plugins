import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginWebhookInput,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import {
  ACTION_KEYS,
  DATA_KEYS,
  DISPATCH_PATH,
  HANDLER_NAME_PATTERN,
  PLUGIN_ID,
  TOOL_NAMES,
  WEBHOOK_ENDPOINT_KEYS,
  WEBHOOK_KEY_HEADER,
} from "./constants.js";
import {
  isWebhookKeyConfigured,
  resolvePcBridgeConfig,
  validatePcBridgeConfig,
  type PcBridgeConfig,
} from "./config.js";
import {
  postDispatchToBridge,
  resolveWebhookKey,
  type BridgeDispatchResult,
} from "./bridge.js";
import {
  buildDispatchHistoryEntry,
  listDispatchHistory,
  recordDispatchHistory,
  type DispatchOutcome,
  type DispatchSource,
} from "./history.js";
import {
  validateDispatchRequest,
  type ValidatedDispatchRequest,
} from "./validate.js";

type JsonRecord = Record<string, unknown>;

/**
 * Honest health statement: the mac bridge listens on the operator PC loopback
 * and is only reachable through the A1 SSH reverse tunnel, so the plugin has no
 * reliable direct probe. Outcome is observable per-dispatch via history.
 */
const HEALTH_NOTE =
  "브리지는 운영자 PC(맥)의 루프백에서 동작하고 SSH 역방향 터널 뒤에 있어 플러그인에서 직접 상태를 확인할 수 없습니다. 각 디스패치의 성공/실패는 아래 이력으로 확인하세요.";

const CHAIN_DOC = [
  "호출자(A1 툴/웹훅) → 이 플러그인(형식 검증만) → SSH -R 터널(A1 루프백 127.0.0.1:8930)",
  `→ 맥 bridge_server POST ${DISPATCH_PATH} (키 인증·중복차단·레이트리밋·감사로그)`,
  "→ handlers/<이름> 실행 파일(서브프로세스, params는 stdin JSON, 결과는 stdout 마지막 줄 JSON).",
  "웹훅은 fire-and-forget으로 접수만 확인하고, 실행 결과는 이력에 기록된다.",
].join(" ");

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerDataHandler(
  ctx: PluginContext,
  key: string,
  handler: (params: JsonRecord) => Promise<unknown>,
): void {
  const dataClient = ctx.data as PluginContext["data"] & {
    handle?: (handlerKey: string, fn: (params: JsonRecord) => Promise<unknown>) => void;
    register?: (handlerKey: string, fn: (params: JsonRecord) => Promise<unknown>) => void;
  };

  if (typeof dataClient.handle === "function") {
    dataClient.handle(key, handler);
    return;
  }

  if (typeof dataClient.register === "function") {
    dataClient.register(key, handler);
    return;
  }

  throw new Error("Plugin data client does not support handler registration");
}

function registerActionHandler(
  ctx: PluginContext,
  key: string,
  handler: (params: JsonRecord) => Promise<unknown>,
): void {
  const actionClient = ctx.actions as PluginContext["actions"] & {
    register?: (handlerKey: string, fn: (params: JsonRecord) => Promise<unknown>) => void;
  };

  if (typeof actionClient.register === "function") {
    actionClient.register(key, handler);
    return;
  }

  throw new Error("Plugin action client does not support handler registration");
}

function safeEqualStrings(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function headerValue(input: PluginWebhookInput, name: string): string {
  const found = Object.entries(input.headers).find(([key]) => key.toLowerCase() === name);
  const value = found?.[1];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}

function failureMessage(result: BridgeDispatchResult): string {
  const bodyMessage = result.body && typeof result.body.message === "string"
    ? result.body.message.trim()
    : "";
  const bodyError = result.body && typeof result.body.error === "string"
    ? result.body.error.trim()
    : "";

  const bridgePart = bodyMessage || bodyError;

  if (result.error) {
    // Transport verdict first, but keep the bridge's own message when present
    // (e.g. HTTP 404 handler-not-found explains what went wrong).
    return bridgePart ? `${result.error} (${bridgePart})` : result.error;
  }

  return bridgePart || "PC 브리지 디스패치가 실패했습니다.";
}

async function executeDispatch(
  ctx: PluginContext,
  params: JsonRecord,
  source: DispatchSource,
): Promise<DispatchOutcome | { error: string }> {
  const validation = validateDispatchRequest({
    handler: params.handler,
    params: params.params,
  });

  if (!validation.ok) {
    return { error: validation.error };
  }

  const config = resolvePcBridgeConfig(await ctx.config.get());

  if (!isWebhookKeyConfigured(config)) {
    return {
      error: "웹훅 키가 설정되지 않았습니다. 플러그인 설정에서 webhookKeyRef 또는 webhookKey를 지정하세요.",
    };
  }

  const webhookKey = await resolveWebhookKey(ctx, config);
  if (!webhookKey) {
    return { error: "설정된 웹훅 키가 비어 있습니다. 시크릿 참조 또는 인라인 값을 확인하세요." };
  }

  return await dispatchToBridge(ctx, config, webhookKey, validation.request, source);
}

async function dispatchToBridge(
  ctx: PluginContext,
  config: PcBridgeConfig,
  webhookKey: string,
  request: ValidatedDispatchRequest,
  source: DispatchSource,
): Promise<DispatchOutcome> {
  const startedAt = Date.now();
  const result = await postDispatchToBridge(ctx.http, {
    baseUrl: config.bridgeBaseUrl,
    webhookKey,
    request,
    timeoutMs: config.requestTimeoutMs,
  });
  const durationMs = Date.now() - startedAt;

  const entry = buildDispatchHistoryEntry({ source, request, result, durationMs });
  try {
    await recordDispatchHistory(ctx, config, entry);
  } catch (error) {
    ctx.logger.warn("Failed to record dispatch history", {
      error: summarizeError(error),
      handler: request.handler,
    });
  }

  ctx.logger.info("PC bridge dispatch executed", {
    source,
    handler: request.handler,
    ok: result.ok,
    httpStatus: result.httpStatus,
    durationMs,
  });

  return { entry, result };
}

async function buildStatusSnapshot(ctx: PluginContext): Promise<unknown> {
  const config = resolvePcBridgeConfig(await ctx.config.get());
  const history = await listDispatchHistory(ctx, config.historyLimit);

  return {
    generatedAt: new Date().toISOString(),
    config: {
      bridgeBaseUrl: config.bridgeBaseUrl,
      webhookKeyRef: config.webhookKeyRef,
      webhookKeyConfigured: isWebhookKeyConfigured(config),
      requestTimeoutMs: config.requestTimeoutMs,
      historyLimit: config.historyLimit,
    },
    // No direct bridge probe is possible (SSH tunnel loopback); see HEALTH_NOTE.
    healthNote: HEALTH_NOTE,
    chainDoc: CHAIN_DOC,
    dispatchPath: DISPATCH_PATH,
    handlerNamePattern: HANDLER_NAME_PATTERN.source,
    history,
  };
}

function toolResultFor(outcome: DispatchOutcome | { error: string }): ToolResult {
  if ("error" in outcome) {
    return { error: outcome.error };
  }

  const { entry, result } = outcome;

  if (!result.ok) {
    return {
      error: failureMessage(result),
      data: { ok: false, httpStatus: result.httpStatus, response: result.body },
    };
  }

  const lines = [
    "PC 브리지 디스패치 완료",
    `- 핸들러: ${entry.handler}`,
  ];
  if (entry.title) {
    lines.push(`- 제목: ${entry.title}`);
  }
  if (entry.permalink) {
    lines.push(`- 퍼머링크: ${entry.permalink}`);
  }
  if (typeof entry.imageCount === "number") {
    lines.push(`- 이미지 수: ${entry.imageCount}`);
  }
  if (entry.message) {
    lines.push(`- 메시지: ${entry.message}`);
  }

  return {
    content: lines.join("\n"),
    data: { ok: true, httpStatus: result.httpStatus, response: result.body, permalink: entry.permalink },
  };
}

async function handleDispatchWebhook(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  const config = resolvePcBridgeConfig(await ctx.config.get());

  if (!isWebhookKeyConfigured(config)) {
    throw new Error("웹훅 키가 설정되지 않아 요청을 검증할 수 없습니다.");
  }

  const presentedKey = headerValue(input, WEBHOOK_KEY_HEADER);
  const expectedKey = await resolveWebhookKey(ctx, config);

  if (!presentedKey || !expectedKey || !safeEqualStrings(presentedKey, expectedKey)) {
    throw new Error("X-Papercompany-Webhook-Key 헤더가 유효하지 않습니다.");
  }

  let payload: unknown = input.parsedBody;
  if (payload === undefined || payload === null) {
    try {
      payload = JSON.parse(input.rawBody);
    } catch {
      throw new Error("요청 본문을 JSON으로 파싱할 수 없습니다.");
    }
  }

  const record = (payload && typeof payload === "object" ? payload : {}) as JsonRecord;
  const validation = validateDispatchRequest({
    handler: record.handler,
    params: record.params,
  });

  if (!validation.ok) {
    throw new Error(validation.error);
  }

  // Fire-and-forget: acceptance is acknowledged now; the dispatch outcome is
  // recorded in history when it settles. Handlers may run for minutes.
  void executeDispatch(ctx, record, "webhook").catch((error) => {
    ctx.logger.error("Background webhook dispatch failed", {
      error: summarizeError(error),
      handler: validation.ok ? validation.request.handler : undefined,
    });
  });
}

let pluginContext: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    pluginContext = ctx;
    registerDataHandler(ctx, DATA_KEYS.status, async () => {
      return await buildStatusSnapshot(ctx);
    });

    registerActionHandler(ctx, ACTION_KEYS.dispatch, async (params) => {
      return await executeDispatch(ctx, params, "ui");
    });

    ctx.tools.register(
      TOOL_NAMES.dispatch,
      {
        displayName: "PC 브리지 기능 호출",
        description: [
          "운영자 PC(맥) 브리지에 등록된 핸들러를 호출합니다.",
          "handler는 맥의 handlers/ 디렉터리에 실행 파일로 등록된 이름([a-z0-9-] 형식)이어야 합니다.",
          "params는 핸들러가 요구하는 JSON 객체입니다 — params 검증은 핸들러가 담당하며,",
          "실패 시 그 내용이 error로 전달됩니다. 예: 네이버 발행은",
          '{"handler":"naver-publish","params":{"url":"https://...","workflow":"gazua-morning"}}',
        ].join(" "),
        parametersSchema: {
          type: "object",
          properties: {
            handler: {
              type: "string",
              description: "호출할 핸들러 이름 (맥 handlers/ 디렉터리에 등록된 [a-z0-9-] 형식 이름)",
              pattern: HANDLER_NAME_PATTERN.source,
            },
            params: {
              type: "object",
              description: "핸들러로 전달할 JSON 객체 (핸들러가 스스로 검증합니다)",
            },
          },
          required: ["handler", "params"],
        },
      },
      async (params: unknown): Promise<ToolResult> => {
        const record = (params && typeof params === "object" ? params : {}) as JsonRecord;
        const outcome = await executeDispatch(ctx, record, "tool");
        return toolResultFor(outcome);
      },
    );

    ctx.logger.info("PC Bridge plugin worker initialized", {
      pluginId: PLUGIN_ID,
      dispatchPath: DISPATCH_PATH,
    });
  },

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_ENDPOINT_KEYS.dispatch) {
      throw new Error(`지원하지 않는 웹훅 엔드포인트입니다: ${input.endpointKey}`);
    }

    const ctx = pluginContext;
    if (!ctx) {
      throw new Error("PC Bridge worker가 아직 초기화되지 않았습니다.");
    }

    await handleDispatchWebhook(ctx, input);
  },

  async onValidateConfig(config) {
    return validatePcBridgeConfig(config);
  },

  async onHealth() {
    return {
      status: "ok",
      message: "PC Bridge worker ready",
      details: {
        dispatchPath: DISPATCH_PATH,
        bridgeHealthProbeable: false,
        bridgeHealthNote: HEALTH_NOTE,
      },
    };
  },
});


export default plugin;
runWorker(plugin, import.meta.url);
