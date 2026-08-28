import { HANDLER_NAME_PATTERN } from "./constants.js";

/**
 * Transport-level dispatch validation only.
 *
 * Feature knowledge (category mapping, host whitelists, ...) lives in the mac
 * handlers — the plugin just checks the envelope `{handler, params}`.
 */

export type ValidatedDispatchRequest = {
  handler: string;
  params: Record<string, unknown>;
};

export type ValidationResult =
  | { ok: true; request: ValidatedDispatchRequest }
  | { ok: false; error: string };

/** Re-exported for the tool schema and UI. */
export { HANDLER_NAME_PATTERN };

export function isValidHandlerName(name: unknown): name is string {
  return typeof name === "string" && HANDLER_NAME_PATTERN.test(name);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateDispatchRequest(input: {
  handler?: unknown;
  params?: unknown;
}): ValidationResult {
  const handler = typeof input.handler === "string" ? input.handler.trim() : "";

  if (!handler) {
    return { ok: false, error: "handler(핸들러명)는 필수 문자열입니다." };
  }

  if (!isValidHandlerName(handler)) {
    return {
      ok: false,
      error: `handler 이름은 [a-z0-9-] 형식(1~64자)이어야 합니다: ${handler}`,
    };
  }

  // A handler may take no arguments; a missing params defaults to {}.
  const params: unknown = input.params === undefined ? {} : input.params;

  if (!isPlainObject(params)) {
    return { ok: false, error: "params는 JSON 객체여야 합니다." };
  }

  return { ok: true, request: { handler, params } };
}

/**
 * Builds the JSON body forwarded to the mac bridge: exactly the generic
 * dispatch contract `{"handler": ..., "params": {...}}`, passed through
 * without rewriting.
 */
export function buildBridgePayload(request: ValidatedDispatchRequest): {
  handler: string;
  params: Record<string, unknown>;
} {
  return { handler: request.handler, params: request.params };
}
