import { describe, expect, it } from "vitest";
import {
  buildApiHeaders,
  buildApiUrl,
  getApiBaseUrl,
  getApiKeyHeaderIssue,
  normalizeApiEndpointInput,
} from "@/lib/api-endpoints";

describe("api endpoint normalization", () => {
  it("lets users enter only host and port, then appends provider paths", () => {
    const raw = "http://202.90.21.53:3008";

    expect(buildApiUrl(raw, "gemini", "/models/gemini-3-flash-preview:generateContent"))
      .toBe("http://202.90.21.53:3008/v1beta/models/gemini-3-flash-preview:generateContent");
    expect(buildApiUrl(raw, "openai", "/chat/completions"))
      .toBe("http://202.90.21.53:3008/v1/chat/completions");
    expect(buildApiUrl(raw, "anthropic", "/messages"))
      .toBe("http://202.90.21.53:3008/v1/messages");
  });

  it("normalizes copied full endpoint urls back to the correct base", () => {
    expect(getApiBaseUrl("http://relay.test:8080/v1/chat/completions", "openai"))
      .toBe("http://relay.test:8080/v1");
    expect(getApiBaseUrl("http://relay.test:8080/v1/messages", "anthropic"))
      .toBe("http://relay.test:8080/v1");
    expect(getApiBaseUrl("http://relay.test:8080/v1/models", "gemini"))
      .toBe("http://relay.test:8080/v1beta");
    expect(getApiBaseUrl("http://relay.test:8080/api/v1beta/models/gemini:generateContent", "gemini"))
      .toBe("http://relay.test:8080/api/v1beta");
  });

  it("uses provider-specific auth headers", () => {
    expect(buildApiHeaders("https://generativelanguage.googleapis.com", "gemini", "k"))
      .toMatchObject({ "x-goog-api-key": "k" });
    expect(buildApiHeaders("https://api.openai.com", "openai", "k"))
      .toMatchObject({ Authorization: "Bearer k" });
    expect(buildApiHeaders("https://api.anthropic.com", "anthropic", "k"))
      .toMatchObject({ "x-api-key": "k", "anthropic-version": "2023-06-01" });
  });

  it("trims API keys before writing fetch headers", () => {
    expect(buildApiHeaders("https://api.openai.com", "openai", "  sk-test  "))
      .toMatchObject({ Authorization: "Bearer sk-test" });
  });

  it("rejects masked or non-header-safe API keys before fetch", () => {
    expect(getApiKeyHeaderIssue("••••••••")).toContain("隱藏佔位符");
    expect(() => buildApiHeaders("https://api.openai.com", "openai", "••••••••"))
      .toThrow("隱藏佔位符");
    expect(() => buildApiHeaders("https://api.openai.com", "openai", "測試-key"))
      .toThrow("特殊字元");
  });

  it("adds http scheme when the user omits it", () => {
    expect(normalizeApiEndpointInput("relay.test:3008")).toBe("http://relay.test:3008");
  });
});
