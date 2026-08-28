import { describe, expect, it } from "vitest";
import {
  allowedCategories,
  buildBridgePayload,
  categoryForWorkflow,
  validatePublishRequest,
  validatePublishUrl,
  workflowKeys,
} from "../src/validate.js";

const ONBOARDING_URL = "https://manual-onboarding.pages.dev/posts/example";
const GAZUA_URL = "https://gazua.showk.ing/morning/2026-08-28";

describe("validatePublishUrl", () => {
  it("accepts allowlisted https hosts", () => {
    expect(validatePublishUrl(ONBOARDING_URL)).toEqual({ ok: true, url: expect.any(String) });
    expect(validatePublishUrl(GAZUA_URL)).toEqual({ ok: true, url: expect.any(String) });
    expect(validatePublishUrl(` ${GAZUA_URL} `).ok).toBe(true);
  });

  it("normalizes host casing", () => {
    const result = validatePublishUrl("https://GAZUA.SHOWK.ING/morning");
    expect(result.ok).toBe(true);
  });

  it("rejects non-string, empty, and unparseable urls", () => {
    expect(validatePublishUrl(undefined).ok).toBe(false);
    expect(validatePublishUrl(42).ok).toBe(false);
    expect(validatePublishUrl("   ").ok).toBe(false);
    expect(validatePublishUrl("not-a-url").ok).toBe(false);
  });

  it("rejects http and other schemes", () => {
    expect(validatePublishUrl("http://gazua.showk.ing/morning").ok).toBe(false);
    expect(validatePublishUrl("file:///etc/passwd").ok).toBe(false);
  });

  it("rejects hosts outside the allowlist, including lookalike subdomains", () => {
    expect(validatePublishUrl("https://evil.com/path").ok).toBe(false);
    expect(validatePublishUrl("https://gazua.showk.ing.evil.com/path").ok).toBe(false);
    expect(validatePublishUrl("https://preview.manual-onboarding.pages.dev/path").ok).toBe(false);
    expect(validatePublishUrl("https://showk.ing/morning").ok).toBe(false);
  });

  it("rejects urls with embedded credentials", () => {
    expect(validatePublishUrl("https://user:pass@gazua.showk.ing/morning").ok).toBe(false);
  });
});

describe("workflow/category mapping", () => {
  it("maps all six workflows to their categories", () => {
    expect(workflowKeys()).toEqual([
      "tech-ai-news",
      "tech-ai-scout",
      "agent-team-concept-radar",
      "youtube-report",
      "gazua-morning",
      "gazua-evening",
    ]);

    expect(categoryForWorkflow("tech-ai-news")).toBe("AI뉴스");
    expect(categoryForWorkflow("tech-ai-scout")).toBe("AI소프트웨어");
    expect(categoryForWorkflow("agent-team-concept-radar")).toBe("AI개념");
    expect(categoryForWorkflow("youtube-report")).toBe("AI유투브요약");
    expect(categoryForWorkflow("gazua-morning")).toBe("한국증시");
    expect(categoryForWorkflow("gazua-evening")).toBe("미국증시");

    expect(allowedCategories()).toEqual([
      "AI뉴스",
      "AI소프트웨어",
      "AI개념",
      "AI유투브요약",
      "한국증시",
      "미국증시",
    ]);
  });

  it("returns null for unknown workflows", () => {
    expect(categoryForWorkflow("tech-unknown")).toBeNull();
    expect(categoryForWorkflow("")).toBeNull();
  });
});

describe("validatePublishRequest", () => {
  it("accepts each workflow and derives its category", () => {
    for (const workflow of workflowKeys()) {
      const result = validatePublishRequest({ url: ONBOARDING_URL, workflow });
      expect(result).toEqual({
        ok: true,
        request: {
          url: expect.any(String),
          workflow,
          category: categoryForWorkflow(workflow),
        },
      });
    }
  });

  it("accepts a direct category and records no workflow", () => {
    const result = validatePublishRequest({ url: GAZUA_URL, category: "한국증시" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.workflow).toBeNull();
      expect(result.request.category).toBe("한국증시");
    }
  });

  it("trims workflow and category inputs", () => {
    const result = validatePublishRequest({ url: ` ${ONBOARDING_URL} `, workflow: " tech-ai-news " });
    expect(result.ok).toBe(true);
  });

  it("rejects providing both workflow and category", () => {
    const result = validatePublishRequest({ url: ONBOARDING_URL, workflow: "tech-ai-news", category: "AI뉴스" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("하나만");
    }
  });

  it("rejects providing neither workflow nor category", () => {
    const result = validatePublishRequest({ url: ONBOARDING_URL });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown workflow values", () => {
    const result = validatePublishRequest({ url: ONBOARDING_URL, workflow: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("nope");
      expect(result.error).toContain("tech-ai-news");
    }
  });

  it("rejects categories outside the six allowed values", () => {
    const result = validatePublishRequest({ url: ONBOARDING_URL, category: "증시뉴스" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("한국증시");
    }
  });

  it("rejects non-string workflow/category values", () => {
    expect(validatePublishRequest({ url: ONBOARDING_URL, workflow: 123 as unknown as string }).ok).toBe(false);
    expect(validatePublishRequest({ url: ONBOARDING_URL, category: { k: "한국증시" } as unknown as string }).ok).toBe(false);
  });

  it("rejects an invalid url even when the workflow is valid", () => {
    const result = validatePublishRequest({ url: "https://evil.com/x", workflow: "tech-ai-news" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("허용되지 않은 호스트");
    }
  });
});

describe("buildBridgePayload", () => {
  it("passes workflow through without rewriting to category", () => {
    const validated = validatePublishRequest({ url: GAZUA_URL, workflow: "gazua-morning" });
    if (!validated.ok) throw new Error("expected valid request");

    expect(buildBridgePayload(validated.request)).toEqual({
      url: expect.stringContaining("https://gazua.showk.ing/"),
      workflow: "gazua-morning",
    });
  });

  it("passes a direct category through", () => {
    const validated = validatePublishRequest({ url: ONBOARDING_URL, category: "AI개념" });
    if (!validated.ok) throw new Error("expected valid request");

    const payload = buildBridgePayload(validated.request);
    expect(payload).toEqual({
      url: expect.stringContaining("https://manual-onboarding.pages.dev/"),
      category: "AI개념",
    });
    expect("workflow" in payload).toBe(false);
  });
});
