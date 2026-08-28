import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  DISPATCH_PATH,
  WEBHOOK_KEY_HEADER,
} from "./constants.js";
import type { PcBridgeConfig } from "./config.js";
import type { ValidatedDispatchRequest } from "./validate.js";
import { buildBridgePayload } from "./validate.js";

export type BridgeHttpClient = {
  fetch(url: string, init?: RequestInit): Promise<Response>;
};

export type BridgeDispatchResult = {
  /** Mirrors the mac bridge body's own `ok` flag; false for transport errors too. */
  ok: boolean;
  httpStatus: number | null;
  /** Mac bridge JSON response, passed through unmodified when parseable. */
  body: Record<string, unknown> | null;
  /** Synthesized transport error (network/timeout/non-JSON), never the bridge's own message. */
  error: string | null;
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}이(가) ${timeoutMs}ms 안에 완료되지 않았습니다.`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function parseJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (!text) {
      return null;
    }

    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Note: the mac bridge sits behind the SSH reverse tunnel loopback, so the
 * plugin deliberately does NOT probe /health — reachability is only observable
 * through an actual dispatch attempt.
 */
export async function postDispatchToBridge(
  http: BridgeHttpClient,
  params: {
    baseUrl: string;
    webhookKey: string;
    request: ValidatedDispatchRequest;
    timeoutMs: number;
  },
): Promise<BridgeDispatchResult> {
  const payload = buildBridgePayload(params.request);

  let response: Response;
  try {
    response = await withTimeout(
      http.fetch(`${params.baseUrl}${DISPATCH_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WEBHOOK_KEY_HEADER]: params.webhookKey,
        },
        body: JSON.stringify(payload),
      }),
      params.timeoutMs,
      "PC 브리지 디스패치 요청",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      httpStatus: null,
      body: null,
      error: `PC 브리지로 요청을 전달하지 못했습니다: ${message}`,
    };
  }

  const body = await parseJsonBody(response);

  if (!response.ok) {
    return {
      ok: false,
      httpStatus: response.status,
      body,
      error: `PC 브리지가 HTTP ${response.status}을(를) 반환했습니다.`,
    };
  }

  if (body === null) {
    return {
      ok: false,
      httpStatus: response.status,
      body: null,
      error: "PC 브리지 응답을 JSON으로 파싱할 수 없습니다.",
    };
  }

  // Pass the bridge's own verdict through untouched.
  return {
    ok: body.ok === true,
    httpStatus: response.status,
    body,
    error: null,
  };
}

export async function resolveWebhookKey(ctx: PluginContext, config: PcBridgeConfig): Promise<string> {
  if (config.webhookKeyRef) {
    return (await ctx.secrets.resolve(config.webhookKeyRef)).trim();
  }

  return config.webhookKeyInline;
}
