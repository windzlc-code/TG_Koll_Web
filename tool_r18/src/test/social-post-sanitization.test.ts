import { describe, expect, it } from "vitest";
import { sanitizeDramaScriptToSocialPost } from "@/lib/social-post-sanitizer";

describe("social post sanitization", () => {
  const raw = `# 第1集
# 1-1 日 內景 廚房
出場人物：葉辰、王翠蘭
第1集：命運序章

# 貼文 #1
# 第1集 # 1-1 日 內 林家別墅廚房/客廳 出場人物：葉辰、王翠蘭
清晨的陽光透過百葉窗，細碎地灑在淡雅的廚房裡。葉辰穿著一件洗得發白的圍裙，正神情專注地守在一個古樸的砂鍋旁。`;

  it("removes episode and scene scaffolding", () => {
    const cleaned = sanitizeDramaScriptToSocialPost(raw);
    expect(cleaned).not.toMatch(/第1集/);
    expect(cleaned).not.toMatch(/出場人物/);
    expect(cleaned).not.toMatch(/^#\s*1-1/m);
    expect(cleaned).toContain("清晨的陽光透過百葉窗");
  });
});
