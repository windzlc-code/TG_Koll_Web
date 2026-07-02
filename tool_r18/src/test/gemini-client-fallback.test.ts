import { describe, expect, it } from "vitest";

import { isTextModelFallbackError } from "@/lib/gemini-client";

describe("isTextModelFallbackError", () => {
  it("treats payment and balance failures as retryable fallback errors", () => {
    expect(isTextModelFallbackError(new Error("模型 xai/grok-4.3 呼叫失敗 (402): Payment Required"))).toBe(true);
    expect(isTextModelFallbackError(new Error("insufficient balance"))).toBe(true);
    expect(isTextModelFallbackError(new Error("quota exceeded"))).toBe(true);
    expect(isTextModelFallbackError(new Error("餘額不足"))).toBe(true);
  });
});
