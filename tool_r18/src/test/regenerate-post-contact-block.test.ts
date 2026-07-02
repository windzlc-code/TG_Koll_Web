import { describe, expect, it } from "vitest";
import { isRegeneratedPostTooSimilar } from "@/core/persona/regenerate-post-instruction";

describe("regenerate post stable contact block", () => {
  it("allows rewritten normal posts to keep a stable trailing contact block", () => {
    const original = [
      "在海外打拼的工薪族，常以为没台湾扣缴凭单就不能办信贷，真的先不要放弃。其实只要提供海外完税证明和外币薪转明细，一样能跟台湾银行交涉。",
      "补个银行行员独家内部专案",
      "全台银行合作最低利率2.25%起，市面很难拿到的低息方案！",
      "我是国泰人寿放款经理人 梁渊钦｜行动：0972-727-690",
    ].join("\n");
    const rewritten = [
      "很多海外上班族其实卡在第一步，以为收入不在台湾就没有信贷空间。重点是先把完税文件、薪转纪录和资金用途整理清楚，再去跟银行谈条件。",
      "补个银行行员独家内部专案",
      "全台银行合作最低利率2.25%起，市面很难拿到的低息方案！",
      "我是国泰人寿放款经理人 梁渊钦｜行动：0972-727-690",
    ].join("\n");

    expect(isRegeneratedPostTooSimilar(original, rewritten, {
      ignoreStableTrailingContactBlock: true,
      similarityThreshold: 0.88,
    })).toBe(false);
    expect(isRegeneratedPostTooSimilar(original, original, {
      ignoreStableTrailingContactBlock: true,
      similarityThreshold: 0.88,
    })).toBe(true);
  });

  it("still rejects unchanged body text with the same trailing contact block", () => {
    const original = [
      "海外收入不是不能办信贷，重点是文件怎么整理、资金来源怎么说明。",
      "补个银行行员独家内部专案",
      "全台银行合作最低利率2.25%起，市面很难拿到的低息方案！",
      "我是国泰人寿放款经理人 梁渊钦｜行动：0972-727-690",
    ].join("\n");
    const barelyChanged = [
      "海外收入不是不能办信贷，重点是文件怎么整理、资金来源怎么说明。",
      "补个银行行员独家内部专案",
      "全台银行合作最低利率2.25%起，市面很难拿到的低息方案！",
      "我是国泰人寿放款经理人 梁渊钦｜行动：0972-727-690",
    ].join("\n");

    expect(isRegeneratedPostTooSimilar(original, barelyChanged, {
      ignoreStableTrailingContactBlock: true,
      similarityThreshold: 0.88,
    })).toBe(true);
  });
});
