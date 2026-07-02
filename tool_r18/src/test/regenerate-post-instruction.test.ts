import { describe, expect, it } from "vitest";
import { buildRegeneratePostInstruction, calculateRegeneratedPostSimilarity, isRegeneratedPostTooSimilar } from "@/core/persona/regenerate-post-instruction";

describe("regenerate post instruction", () => {
  it("uses the original post for topic only instead of preserving the old style", () => {
    const instruction = buildRegeneratePostInstruction("今天塔捷通運動，看著大家都在滑 Threads。");

    expect(instruction).toContain("原推文只用于识别主题和信息点");
    expect(instruction).toContain("不得把原推文当作风格模板");
    expect(instruction).toContain("如果推文风格已经恢复初始状态，必须回到通用人设推文规则");
    expect(instruction).toContain("不要复用原文句式、段落节奏、口头禅、表情密度或结尾互动方式");
    expect(instruction).not.toContain("同一语言风格");
  });

  it("detects regenerated content that is still effectively unchanged", () => {
    const original = "今天塔捷通運動，看著大家都在滑 Threads，每個人看起來都有夠焦慮。";

    expect(isRegeneratedPostTooSimilar(
      original,
      "今天塔捷通運動，看著大家都在滑 Threads，每個人看起來都有夠焦慮。",
    )).toBe(true);
    expect(isRegeneratedPostTooSimilar(
      original,
      "早上看到大家討論通勤前的運動習慣，才發現很多人其實不是懶，是生活節奏被平台推著走。",
    )).toBe(false);
  });

  it("rejects rewrites that keep a long original fragment after changing the opening", () => {
    const original = "分享用海外收入申請台灣的信貸心得，由於是第一次申請信貸，事前做了不少功課，後來選擇永豐銀行，也剛好遇到一位專業且認真的業務。";

    expect(isRegeneratedPostTooSimilar(
      original,
      "最近被問到海外收入辦信貸這件事。事前做了不少功課，後來選擇永豐銀行，也剛好遇到一位專業且認真的業務。",
    )).toBe(true);
  });

  it("can allow reused list structure for source-structure rewrites without allowing copied text", () => {
    const original = "1. 先準備收入資料。2. 再確認銀行利率。3. 最後等審核電話。";
    const rewritten = "1. 先把薪轉和報稅文件整理好。2. 再看每家銀行審核邏輯。3. 最後記得留時間接照會。";

    expect(isRegeneratedPostTooSimilar(original, rewritten)).toBe(true);
    expect(isRegeneratedPostTooSimilar(original, rewritten, { allowSameListStructure: true })).toBe(false);
  });

  it("exposes a similarity score for rewrite diagnostics", () => {
    const original = "今天看到大家討論信貸申請流程，才發現資料準備比利率更容易卡住。";

    expect(calculateRegeneratedPostSimilarity(original, original)).toBe(1);
    expect(calculateRegeneratedPostSimilarity(
      original,
      "最近不少人卡在貸款文件準備，其實比起只看利率，先把收入證明整理好更重要。",
    )).toBeLessThan(0.72);
  });
});
