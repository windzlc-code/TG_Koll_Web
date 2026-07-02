import { describe, expect, it } from "vitest";
import { buildArchivePostFromEpisode } from "@/core/archives/persona-archive-domain";
import { parseGeneratedPosts } from "@/core/persona/generated-post-parser";

describe("parseGeneratedPosts", () => {
  it("strips leaked English reasoning blocks before saving posts", () => {
    const raw = `**Defining the Persona**

I'm currently focused on defining the persona. I'm building out Kim Junya, the Taiwanese-Korean flight attendant. The core concept is the contrast between professional appearance and a slightly clumsy daily routine.

**Crafting Engagement Content**

I'm now crafting a teaser post. It has to hook people using images and enticing text. The key parameters are: one post, approximately 60 Taiwanese Mandarin words, using local slang.

**Refining the First Draft**

I've just refined the first teaser post draft focusing on a relatable scenario. The word count is good at around 90 characters.

最近看到新聞說機票又要漲了，大家都在瘋搶外站票欸！我也剛飛完外站，洗完澡換了套超涼快的私服⋯⋯有人說這件短裙有點低，你們覺得穿這樣出門會太誇張嗎？點心滿500就發全身照給你們看勒`;

    const [post] = parseGeneratedPosts(raw, 1);

    expect(post).toContain("最近看到新聞說機票又要漲了");
    expect(post).not.toMatch(/Defining|Crafting|Refining|Persona|Engagement|word count|I'm/i);
  });

  it("sanitizes reasoning blocks when converting generated episodes into archive posts", () => {
    const post = buildArchivePostFromEpisode({
      number: 1,
      title: "第1篇",
      content: `**Defining the Persona**

I'm currently focused on defining the persona and checking requirements.

最近在台北等捷運，突然覺得外站票真的不能再拖到最後一刻才買`,
      wordCount: 999,
    }, 0);

    expect(post.content).toBe("最近在台北等捷運，突然覺得外站票真的不能再拖到最後一刻才買");
    expect(post.content).not.toMatch(/Defining|requirements|I'm/i);
  });
});
