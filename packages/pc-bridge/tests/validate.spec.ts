import { describe, expect, it } from "vitest";
import {
  HANDLER_NAME_PATTERN,
  buildBridgePayload,
  isValidHandlerName,
  validateDispatchRequest,
} from "../src/validate.js";

describe("isValidHandlerName", () => {
  it("accepts lowercase alphanumeric and hyphen names", () => {
    expect(isValidHandlerName("echo-test")).toBe(true);
    expect(isValidHandlerName("naver-publish")).toBe(true);
    expect(isValidHandlerName("a")).toBe(true);
    expect(isValidHandlerName("a1-bridge-2")).toBe(true);
    expect(isValidHandlerName("b".repeat(64))).toBe(true);
  });

  it("rejects names outside the mac handlers/ whitelist contract", () => {
    for (const name of [
      "",                     // 빈 값
      "Bad_Name",             // 대문자·밑줄
      "naver_publish.py",     // 확장자·밑줄
      "../bridge_server",     // 경로 탈출
      "a/b",                  // 경로 구분자
      ".hidden",              // 점으로 시작
      "echo-test ",           // 공백
      "-leading",             // 하이픈으로 시작
      "a".repeat(65),         // 길이 초과
    ]) {
      expect(isValidHandlerName(name), name).toBe(false);
    }
  });

  it("rejects non-strings", () => {
    expect(isValidHandlerName(undefined)).toBe(false);
    expect(isValidHandlerName(123)).toBe(false);
    expect(isValidHandlerName(null)).toBe(false);
    expect(isValidHandlerName({})).toBe(false);
  });

  it("exposes the pattern used by the tool schema and UI", () => {
    expect(HANDLER_NAME_PATTERN.test("echo-test")).toBe(true);
    expect(HANDLER_NAME_PATTERN.test("nope_name")).toBe(false);
  });
});

describe("validateDispatchRequest", () => {
  it("accepts a handler with a params object", () => {
    expect(validateDispatchRequest({ handler: "naver-publish", params: { url: "https://example.com" } })).toEqual({
      ok: true,
      request: { handler: "naver-publish", params: { url: "https://example.com" } },
    });
  });

  it("trims the handler name", () => {
    const result = validateDispatchRequest({ handler: " echo-test ", params: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.handler).toBe("echo-test");
    }
  });

  it("defaults a missing params to an empty object", () => {
    const result = validateDispatchRequest({ handler: "echo-test" });
    expect(result).toEqual({ ok: true, request: { handler: "echo-test", params: {} } });
  });

  it("rejects a missing or malformed handler", () => {
    expect(validateDispatchRequest({ params: {} }).ok).toBe(false);
    expect(validateDispatchRequest({ handler: "", params: {} }).ok).toBe(false);
    expect(validateDispatchRequest({ handler: 42, params: {} }).ok).toBe(false);
    expect(validateDispatchRequest({ handler: "Not_A_Name", params: {} }).ok).toBe(false);
    expect(validateDispatchRequest({ handler: "../etc/passwd", params: {} }).ok).toBe(false);
  });

  it("rejects params that are not JSON objects", () => {
    expect(validateDispatchRequest({ handler: "echo-test", params: ["array"] }).ok).toBe(false);
    expect(validateDispatchRequest({ handler: "echo-test", params: "string" }).ok).toBe(false);
    expect(validateDispatchRequest({ handler: "echo-test", params: 7 }).ok).toBe(false);
    expect(validateDispatchRequest({ handler: "echo-test", params: null }).ok).toBe(false);
  });

  it("does not inspect params contents — feature knowledge lives in handlers", () => {
    // Whatever a handler wants to accept is the handler's business.
    const weird = { url: "not-a-url", anything: [1, { deep: true }] };
    const result = validateDispatchRequest({ handler: "echo-test", params: weird });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.params).toEqual(weird);
    }
  });
});

describe("buildBridgePayload", () => {
  it("produces exactly the generic {handler, params} contract", () => {
    const validated = validateDispatchRequest({ handler: "naver-publish", params: { url: "https://example.com", workflow: "gazua-morning" } });
    if (!validated.ok) throw new Error("expected valid request");

    expect(buildBridgePayload(validated.request)).toEqual({
      handler: "naver-publish",
      params: { url: "https://example.com", workflow: "gazua-morning" },
    });
  });
});
