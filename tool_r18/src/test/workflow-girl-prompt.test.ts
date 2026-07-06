import { describe, expect, it } from "vitest";

import {
  buildGirlPersonaImagePrompt,
  buildPersonaSocialImagePrompt,
  buildSceneOnlyImagePrompt,
  getPersonaImageSignals,
  hasConcreteSocialEvent,
  sanitizeGirlPromptText,
  shouldUseWorkflowPersonaImage,
} from "@/lib/persona-image-search";
import type { DramaSetup } from "@/types/drama";

describe("girl persona image prompts", () => {
  const setup: DramaSetup = {
    genres: ["單身貴族"],
    personaPersonality: "知性優雅",
    personaGender: "女性",
    personaStyle: "故事化表達",
    totalEpisodes: 50,
    targetMarket: "cn",
    chineseScript: "traditional",
    personaAppearance: "25 歲女性，甜美空服員感，手機自拍自然生活照。",
    contentTheme: "通勤、穿搭、甜點、日常碎念",
    isGirlPersona: true,
  };

  const content = "剛換下制服想說穿得美美去中山站吃飯，結果在捷運月台滑手機時把剛買的手搖飲潑到衣服上，整件上衣都濕了一片，超狼狽。";

  it("strengthens wet-clothing spill scenes for social-photo generation", () => {
    const signals = getPersonaImageSignals(setup, content);
    const prompt = buildPersonaSocialImagePrompt(content, setup, signals);

    expect(prompt).toContain("accidental drink spill on ordinary opaque clothing");
    expect(prompt).toContain("visibly damp only where the drink actually spilled");
    expect(prompt).toContain("embarrassed candid smartphone photo");
    expect(prompt).toContain("train platform or station background");
  });

  it("builds girl image prompts around the concrete event instead of generic glamour only", () => {
    const signals = getPersonaImageSignals(setup, content);
    const prompt = buildGirlPersonaImagePrompt(content, setup, signals);

    expect(hasConcreteSocialEvent(content)).toBe(true);
    expect(prompt).toContain("accidental drink spill on a normal everyday opaque top");
    expect(prompt).toContain("damp marks only where the liquid actually hit");
    expect(prompt).toContain("non-explicit adult styling");
    expect(prompt).toContain("off-center phone snapshot composition");
    expect(prompt).toContain("natural imperfect composition like a real tweet photo");
    expect(prompt).toContain("keep the image grounded in the exact situation described by the post");
    expect(prompt).toContain("visible post-accident or post-event messiness when relevant");
    expect(prompt).toContain("no polished influencer framing");
    expect(prompt).not.toContain("luxury hotel room");
    expect(prompt.match(/25 歲女性，甜美空服員感，手機自拍自然生活照。/g)?.length).toBe(1);
  });

  it("does not route posts to the removed workflow image generation path", () => {
    expect(shouldUseWorkflowPersonaImage("今天只拍桃園機場傍晚跑道、雲海和窗外夕陽，畫面裡沒有人。", setup)).toBe(false);
    expect(shouldUseWorkflowPersonaImage("剛下班在捷運月台自拍，制服領口被飲料弄濕，超尷尬。", setup)).toBe(false);
  });

  it("routes cafe mood posts to first-person POV scene images", () => {
    const cafeContent = "在咖啡店等人等到放空，只拍窗邊桌上的拿鐵和自己握著杯子的手。";
    const signals = getPersonaImageSignals(setup, cafeContent);
    const prompt = buildSceneOnlyImagePrompt(cafeContent, setup, signals);

    expect(shouldUseWorkflowPersonaImage(cafeContent, setup)).toBe(false);
    expect(prompt).toContain("first-person POV lifestyle photo");
    expect(prompt).toContain("only partial hands are allowed");
    expect(prompt).toContain("one hand holding a coffee cup");
    expect(prompt).toContain("no face visible");
  });

  it("keeps the sanitization assertive without forcing poolside or hotel imagery", () => {
    expect(sanitizeGirlPromptText("露腿 絲襪 酒店房間")).toContain("summer styling");
    expect(sanitizeGirlPromptText("露腿 絲襪 酒店房間")).toContain("bedroom vanity lifestyle");
    expect(sanitizeGirlPromptText("露腿 絲襪 酒店房間")).not.toContain("poolside");
    expect(sanitizeGirlPromptText("露腿 絲襪 酒店房間")).not.toContain("morning bedroom hotel vanity lifestyle");
  });
});
