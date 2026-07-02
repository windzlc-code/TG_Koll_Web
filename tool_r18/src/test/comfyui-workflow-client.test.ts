import { describe, expect, it } from "vitest";

import {
  buildFilteredOriginalWorkflowPrompt,
  mergeWorkflowPositivePromptWithVisualAnchor,
} from "@/runtime/node/comfyui-workflow-client";

describe("comfyui workflow prompt merging", () => {
  it("keeps the original persona trigger as a visual anchor while removing fixed scene details", () => {
    const original = [
      "ohwx,偏近景的人物照片，主体位于画面右侧略偏中间，眼神清澈有神。",
      "服装为浅色厚实外套，搭配一条红色针织围巾。",
      "背景是户外街景，后方为一家装饰有圣诞元素的店铺，旁边有圣诞树。",
      "眼神光，可爱，开心，庆祝",
    ].join("\n\n");
    const dynamic = "ohwx, cafe selfie, dewy makeup, loose long hair";

    const merged = mergeWorkflowPositivePromptWithVisualAnchor(original, dynamic);

    expect(merged).toContain("ohwx,");
    expect(merged).toContain("眼神光，可爱");
    expect(merged).toContain("在不改变上述人物身份");
    expect(merged).toContain("cafe selfie");
    expect(merged).not.toContain("Use this original workflow prompt");
    expect(merged).not.toContain("偏近景");
    expect(merged).not.toContain("主体位于画面");
    expect(merged).not.toContain("红色针织围巾");
    expect(merged).not.toContain("圣诞树");
    expect(merged.match(/\bohwx\s*,/gi)).toHaveLength(1);
  });

  it("can prioritize the filtered original prompt without full dynamic persona text", () => {
    const original = [
      "ohwx,偏近景的人物照片，眼神清澈有神、有互动感。",
      "背景是户外街景，旁边有圣诞树。",
      "眼神光，可爱，开心，庆祝",
    ].join("\n\n");
    const dynamic = "A realistic daily social media photo of jinjunya, clear same-person identity, composition aspect ratio 1:1, ohwx, Korean-Taiwanese doll-like face, visible pink blush, no watermark, no logo";

    const prompt = buildFilteredOriginalWorkflowPrompt(original, dynamic);

    expect(prompt).toMatch(/^ohwx,/);
    expect(prompt).toContain("眼神光，可爱");
    expect(prompt).toContain("本次只轻微替换固定场景");
    expect(prompt).not.toContain("圣诞树");
    expect(prompt).not.toContain("偏近景");
    expect(prompt).not.toContain("A realistic daily social media photo");
    expect(prompt.length).toBeLessThan(520);
  });

  it("keeps explicit composition guidance when filtered original prompt would otherwise dominate framing", () => {
    const original = [
      "ohwx, close-up selfie headshot, face filling most of the frame, direct flash.",
      "背景是户外街景，旁边有圣诞树。",
      "same face identity, glossy eyes, dewy makeup",
    ].join("\n\n");
    const dynamic = [
      "composition guidance: default social feed image should be a medium shot, waist-up or three-quarter lifestyle composition, include torso, hands, outfit and surrounding environment, avoid extreme close-up, avoid headshot",
      "A realistic daily social media photo of jinjunya, clear same-person identity, cafe table and dessert, no watermark",
    ].join(", ");

    const prompt = buildFilteredOriginalWorkflowPrompt(original, dynamic);

    expect(prompt).toContain("构图硬约束");
    expect(prompt).toContain("medium shot");
    expect(prompt).toContain("avoid extreme close-up");
    expect(prompt).toContain("以这里的构图硬约束为准");
    expect(prompt).toContain("same face identity");
  });

  it("removes fixed hands-near-face pose anchors from original workflow prompts", () => {
    const original = "ohwx,偏近景的人物照片，主体位于画面右侧略偏中间，双手同时举到脸旁：一只手贴近脸颊，另一只手托在下巴下方，手指微微张开，形成一个“托脸+比心式展开”的可爱姿势。人物面部表情温柔而明亮，直视镜头，眼神清澈有神。";
    const dynamic = [
      "composition guidance: medium shot lifestyle photo, both hands must stay away from the face and stay below chest level, forearms resting flat on the table",
      "cafe reading lifestyle photo",
    ].join(", ");

    const prompt = mergeWorkflowPositivePromptWithVisualAnchor(original, dynamic);

    expect(prompt).toContain("ohwx,");
    expect(prompt).toContain("眼神清澈有神");
    expect(prompt).toContain("both hands must stay away from the face");
    expect(prompt).not.toContain("双手同时举到脸旁");
    expect(prompt).not.toContain("贴近脸颊");
    expect(prompt).not.toContain("托在下巴下方");
    expect(prompt).not.toContain("托脸+比心式展开");
  });

  it("removes fixed close-up framing anchors so mid-distance prompts can take effect", () => {
    const original = [
      "ohwx,偏近景的人物照片，主体位于画面右侧略偏中间，身体微微向前倾斜。",
      "人物上半身入镜，头部轻轻歪向一侧。",
      "人物面部表情温柔而明亮，直视镜头，眼神清澈有神。",
    ].join("");
    const dynamic = [
      "composition guidance: normal mid-distance lifestyle photo, camera distance 3 to 5 meters, full body or seven-eighths body visible, environment occupies more than 70 percent of the frame",
      "street cafe exterior",
    ].join(", ");

    const prompt = mergeWorkflowPositivePromptWithVisualAnchor(original, dynamic);

    expect(prompt).toContain("眼神清澈有神");
    expect(prompt).toContain("normal mid-distance lifestyle photo");
    expect(prompt).toContain("camera distance 3 to 5 meters");
    expect(prompt).not.toContain("偏近景");
    expect(prompt).not.toContain("主体位于画面");
    expect(prompt).not.toContain("身体微微向前倾斜");
    expect(prompt).not.toContain("上半身入镜");
    expect(prompt).not.toContain("头部轻轻歪向一侧");
  });

  it("keeps optional style requests when bunny ears or flash are explicitly requested", () => {
    const original = "ohwx, same face identity, long loose hair, no default bunny-ear headband, no default harsh flash selfie";
    const dynamic = [
      "composition guidance: medium shot lifestyle photo",
      "optional style requested by post: white fluffy bunny-ear headband may appear",
      "optional style requested by post: direct flash smartphone selfie look may appear",
      "A realistic daily social media photo of jinjunya",
    ].join(", ");

    const prompt = buildFilteredOriginalWorkflowPrompt(original, dynamic);

    expect(prompt).toContain("本次文案明确要求的可选风格");
    expect(prompt).toContain("white fluffy bunny-ear headband");
    expect(prompt).toContain("direct flash smartphone selfie look");
    expect(prompt).toContain("未要求时不要默认出现");
  });

  it("normalizes showAnything JSON visual anchors and preserves the workflow trigger word", () => {
    const original = "[\"ohmx, A young woman with long, dark, wavy hair cascading over her shoulders, plain softly lit wall, harsh flash, Raw photo\"]";
    const prompt = buildFilteredOriginalWorkflowPrompt(
      original.replace("ohmx,", "ohwx,"),
      "ohwx, extra dynamic appearance text that should stay secondary",
    );

    expect(prompt).toMatch(/^ohwx, A young woman/);
    expect(prompt).toContain("long, dark, wavy hair");
    expect(prompt).not.toContain("plain softly lit wall");
    expect(prompt).not.toContain("harsh flash");
  });
});
