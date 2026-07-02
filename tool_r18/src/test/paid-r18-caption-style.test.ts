import { describe, expect, it } from "vitest";

import { buildPersonaPaidCaptionToneGuide, isMechanicalPaidCaption } from "@/lib/paid-r18-caption-style";

describe("paid-r18-caption-style", () => {
  it("adds paid-caption guidance only for Jinjunya", () => {
    const guide = buildPersonaPaidCaptionToneGuide({
      personaName: "金君雅",
      freePostTemplate: "jinjunya-hook",
      tweetStyleLinkUrl: "https://t.me/gy_night_flight_bot",
    });

    const joined = guide.join("\n");
    expect(joined).toContain("Jinjunya paid caption tone");
    expect(joined).toContain("short, natural Traditional Chinese");
    expect(joined).toContain("visual anchor");
  });

  it("does not add paid-caption guidance for other personas", () => {
    const guide = buildPersonaPaidCaptionToneGuide({
      personaName: "瑜伽老師",
      personaStyle: "繁體中文、自然、柔和",
    });

    expect(guide).toEqual([]);
  });

  it("detects dry anatomical list captions as mechanical", () => {
    expect(isMechanicalPaidCaption("米白睡袍整個敞開，乳頭乳暈都清晰可見\nhttps://x.test")).toBe(true);
  });

  it("keeps visual-anchor colloquial captions from being flagged as mechanical", () => {
    expect(isMechanicalPaidCaption("這個角度真的有點太犯規了\nhttps://x.test")).toBe(false);
  });
});
