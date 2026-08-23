import { describe, expect, it } from "vitest";

import {
  buildLibraryImageEditPrompt,
  buildPersonaImagePrompt,
  buildPersonaCardImageDirection,
  buildReferenceSheetPrompt,
  generateLibraryImageEdit,
  generatePersonaImage,
  generateReferenceSheet,
  resolvePersonaImageRoute,
} from "@/lib/persona-image-production";
import { buildPersonaVisualIdentityCue } from "@/lib/persona-image-search";
import type { DramaSetup } from "@/types/drama";

function workflowSetup(overrides: Partial<DramaSetup> = {}): DramaSetup {
  return {
    genres: ["籃球日常"],
    personaPersonality: "幽默直接",
    personaGender: "男性",
    personaStyle: "生活化吐槽",
    totalEpisodes: 50,
    targetMarket: "cn",
    chineseScript: "simplified",
    personaDescription: "篮球大佬，主打球场训练、兄弟调侃和生活日常。",
    contentTheme: "篮球训练、球场生活、搞笑吐槽",
    personaImageReferenceUrl: "data:image/png;base64,ZmFrZQ==",
    ...overrides,
  };
}

function nonWorkflowSetup(overrides: Partial<DramaSetup> = {}): DramaSetup {
  return {
    genres: ["咖啡生活"],
    personaPersonality: "溫柔細膩",
    personaGender: "女性",
    personaStyle: "台灣繁體中文日常分享",
    totalEpisodes: 50,
    targetMarket: "cn",
    chineseScript: "traditional",
    personaDescription: "台灣女生，喜歡咖啡館、旅行和生活觀察。",
    personaAppearance: "twenty-something Taiwanese woman, fair skin, neat soft hands, simple cream cardigan",
    contentTheme: "咖啡、旅行、生活心情",
    ...overrides,
  };
}

describe("persona image production", () => {
  it("routes standard persona reference sheets through text-to-image", async () => {
    const calls: any[] = [];
    const result = await generateReferenceSheet(
      {
        generate: async (payload: any) => {
          calls.push(payload);
          return { ok: true, url: "https://example.com/reference-sheet.png" };
        },
      },
      nonWorkflowSetup({ personaImageReferenceUrl: "data:image/png;base64,b2xkLXJlZmVyZW5jZQ==" }),
      "日常生活观察者",
      "gemini-3.1-flash-image-preview",
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].runningHubNewPersonaMode).toBe("text-to-image");
    expect(calls[0].prompt).toContain("character reference sheet, three views");
  });

  it("keeps the original July reference-sheet prompt when there is no user supplement", () => {
    const prompt = buildReferenceSheetPrompt(
      {
        ...nonWorkflowSetup({
          personaAppearance: "",
          personaDescription: "深耕日本高端不動產12年的台籍專屬融資顧問，台灣富豪圈的置產軍師。",
          personaNationality: "",
        }),
      },
      "敏姐是一位深耕東京與大阪頂級不動產長達12年的台籍專屬融資顧問。",
    );

    expect(prompt).toBe([
      "character reference sheet, three views: front view, side view, back view, same person all three angles, consistent appearance",
      "appearance: 深耕日本高端不動產12年的台籍專屬融資顧問，台灣富豪圈的置產軍師。",
      "女性, photorealistic, natural lighting",
      "persona style hint: 敏姐是一位深耕東京與大阪頂級不動產長達12年的台籍專屬融資顧問。",
      "white or neutral background, full body or half body, no text, no watermark, high detail, consistent face and outfit across all three views",
    ].join(", "));
  });

  it("blends user visual traits onto the existing sheet prompt instead of replacing it", () => {
    const prompt = buildReferenceSheetPrompt(
      {
        ...nonWorkflowSetup({
          personaAppearance: "",
          personaDescription: "深耕日本高端不動產12年的台籍專屬融資顧問，台灣富豪圈的置產軍師。",
          personaNationality: "",
        }),
      },
      "敏姐是一位深耕東京與大阪頂級不動產長達12年的台籍專屬融資顧問。",
      "爆乳美女，身材非常的好，会十分的性感诱惑。",
    );

    expect(prompt).toContain("appearance: 深耕日本高端不動產12年的台籍專屬融資顧問，台灣富豪圈的置產軍師。");
    expect(prompt).toContain("persona style hint: 敏姐是一位深耕東京與大阪頂級不動產長達12年的台籍專屬融資顧問。");
    expect(prompt).toContain("naturally blend in these extra visual traits: 爆乳美女，身材非常的好，会十分的性感诱惑。");
    expect(prompt).toContain("character reference sheet, three views");
    expect(prompt).not.toContain("highest priority visual request:");
    expect(prompt).not.toContain("slim well-proportioned figure");
    expect(prompt).not.toContain("summer styling");
  });

  it("keeps card appearance as the sheet appearance when no visual supplement is given", () => {
    const prompt = buildReferenceSheetPrompt(
      nonWorkflowSetup({ personaNationality: "" }),
      "日常生活观察者",
    );

    expect(prompt).toContain("appearance: twenty-something Taiwanese woman, fair skin, neat soft hands, simple cream cardigan");
    expect(prompt).toContain("persona style hint: 日常生活观察者");
    expect(prompt).toContain("女性, photorealistic, natural lighting");
    expect(prompt).not.toContain("Asian 女性");
    expect(prompt).not.toContain("naturally blend in these extra visual traits:");
  });

  it("edits a selected library image from the source and user prompt only", async () => {
    const calls: any[] = [];
    const source = "data:image/png;base64,c2hlZXQ=";
    const userPrompt = "把脸换成网红脸，身材凹凸有致，前凸后翘，穿着职业包臀制服。";
    const result = await generateLibraryImageEdit(
      {
        generate: async (payload: any) => {
          calls.push(payload);
          return { ok: true, url: "https://example.com/library-edit.png" };
        },
      },
      source,
      userPrompt,
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("library-image-edit");
    expect(calls).toHaveLength(1);
    expect(calls[0].runningHubNewPersonaMode).toBe("image-to-image");
    expect(calls[0].avatarSource).toBe(source);
    expect(calls[0].prompt).toContain(userPrompt);
    expect(calls[0].prompt).toContain("Keep the original composition");
    expect(calls[0].prompt).toContain("three views");
    expect(calls[0].prompt).not.toContain("appearance:");
    expect(calls[0].prompt).not.toContain("persona style hint");
    expect(calls[0].prompt).not.toContain("photorealistic portrait or half-body lifestyle photo");
    expect(calls[0].prompt).not.toContain("Use the attached persona reference image as the source");
  });

  it("builds library image-edit prompts from the user request without persona biography", () => {
    const prompt = buildLibraryImageEditPrompt("把脸换成网红脸，身材凹凸有致，前凸后翘，穿着职业包臀制服。");

    expect(prompt).toContain("Current request: 把脸换成网红脸，身材凹凸有致，前凸后翘，穿着职业包臀制服。");
    expect(prompt).toContain("Keep the original composition");
    expect(prompt).toContain("three views");
    expect(prompt).not.toContain("appearance:");
    expect(prompt).not.toContain("persona style hint");
    expect(prompt).not.toContain("photorealistic portrait or half-body lifestyle photo");
    expect(prompt).not.toContain("Highest priority");
  });

  it("uses the generated post as the main referenced image prompt source", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/post-image.png" };
      },
    };

    const postContent = "今天在球场训练到腿软，最后一球还被队友盖帽，全队笑到不行，旁边還有人開玩笑說像美女擦邊流量。";
    const result = await generatePersonaImage(
      imageAPI,
      workflowSetup(),
      postContent,
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(result.ok).toBe(true);
    expect(calls[0].prompt).toContain("球场训练");
    expect(calls[0].prompt).toContain("盖帽");
    expect(calls[0].prompt).toContain("Use the attached persona reference image as the source");
    expect(calls[0].prompt).toContain("unless the current request explicitly asks to change the face or identity");
    expect(calls[0].prompt).toContain("篮球大佬");
    expect(calls[0].prompt).not.toContain("adult woman");
    expect(calls[0].prompt).not.toContain("adult lifestyle social-photo leaning");
  });

  it("derives beauty or lifestyle leaning from the persona card instead of a fixed template", () => {
    const direction = buildPersonaCardImageDirection(workflowSetup({
      genres: ["福利美女"],
      personaGender: "女性",
      personaDescription: "福利传播型美女，偏生活随拍、轻松搞笑和擦边气质，但不做露骨内容。",
      contentTheme: "生活自拍、搞笑日常、美女氛围",
      isGirlPersona: true,
    }));

    expect(direction).toContain("adult lifestyle social-photo leaning");
    expect(direction).toContain("福利传播型美女");
    expect(direction).toContain("搞笑日常");
    expect(direction).toContain("only when the persona card supports it");
  });

  it("carries distinctive persona identity cues into the image direction", () => {
    const direction = buildPersonaCardImageDirection(nonWorkflowSetup({
      genres: ["仙侠IP分析", "战力排名", "世界观深挖"],
      personaName: "资深老宅",
      personaDescription: "专注修仙仙侠类 IP 的资深动漫评论人，熟悉凡人修仙传、仙逆和斗破苍穹，擅长用战力榜、角色模型对比和世界观考据做深度分析。",
      personaPersonality: "理性、热血、爱辩论、老宅感强",
      personaStyle: "像资深二次元评论区老粉，专业但有讨论欲",
      contentTheme: "仙侠战力排名、角色模型对比、世界观设定、经典作品复盘",
      personaAppearance: "22-40岁男性动漫评论人，眼镜，黑色连帽外套，桌面有手办、漫画书、角色卡和数据榜单",
    }));

    expect(direction).toContain("资深老宅");
    expect(direction).toContain("仙侠IP分析");
    expect(direction).toContain("战力排名");
    expect(direction).toContain("手办");
    expect(direction).toContain("角色卡");
    expect(direction).toContain("field, role, recurring objects");
  });

  it("requires visible wardrobe and styling differentiation for persona tweet images", () => {
    const cue = buildPersonaVisualIdentityCue(nonWorkflowSetup({
      personaName: "office rail fan analyst",
      genres: ["commuter diary", "railway route analysis"],
      personaDescription: "city commuter who compares train routes, station crowds, and small office routines",
      personaPersonality: "precise, observant, dry humor",
      personaStyle: "short practical notes with commuter jokes",
      contentTheme: "station platforms, laptop notes, route maps, office coffee",
      personaAppearance: "late twenties office worker, neat glasses, navy commuter jacket, canvas tote, transit card holder",
      trendTopics: ["delayed train", "coffee run", "route map"],
    }), undefined, "same black hoodie outfit, waiting near the station after work");

    expect(cue).toContain("signature wardrobe and styling system");
    expect(cue).toContain("clothing silhouette");
    expect(cue).toContain("grooming");
    expect(cue).toContain("accessories");
    expect(cue).toContain("if another persona wore the same basic clothing item");
    expect(cue).toContain("navy commuter jacket");
    expect(cue).toContain("transit card holder");
  });

  it("uses closed-model POV for workflow persona cafe scenes without showing the persona", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/pov.png" };
      },
    };

    const result = await generatePersonaImage(
      imageAPI,
      workflowSetup(),
      "在咖啡館等朋友，第一人稱視角，桌上有拿鐵和筆記本",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(result).toMatchObject({ ok: true, mode: "closed-pov" });
    expect(calls[0].prompt).toContain("first-person POV");
    expect(calls[0].prompt).toContain("gender: 男性");
    expect(calls[0].prompt).toContain("no full person");
  });








  it("forces explicit no-person requests to the scene route even with person-like tokens", () => {
    const route = resolvePersonaImageRoute(
      "她在咖啡店，但不要出現人物，只拍桌面咖啡杯和筆記本",
      workflowSetup(),
      "auto",
    );
    expect(route.kind).toBe("closed-scene");
    expect(route.mode).toBe("closed-scene");
    expect(route.subject).toBe("scene");
  });

  it("keeps explicit no-person medium-long scenery away from tabletop POV prompts", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/no-person-landscape.png" };
      },
    };

    const result = await generatePersonaImage(
      imageAPI,
      workflowSetup({ personaDescription: "金君雅，空服員人設。", contentTheme: "飛行日常、咖啡、城市散步" }),
      "請生成一張與人物無關的風景照中遠景。不要出現人物，不要有人臉，不要手。畫面是傍晚城市咖啡街區的中遠景風景照，街道、店面窗戶、路燈、天空和路面佔主要畫面。",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(result).toMatchObject({ ok: true, mode: "closed-scene" });
    expect(calls[0].prompt).toContain("medium-long distance environment-only landscape photo");
    expect(calls[0].prompt).toContain("strict no-person medium-long landscape photo");
    expect(calls[0].prompt).toContain("no pedestrians");
    expect(calls[0].prompt).not.toContain("object-focused tabletop lifestyle photo");
    expect(calls[0].prompt).not.toContain("coffee cup, notebook or book");
    expect(calls[0].prompt).not.toContain("no phone in the frame unless explicitly requested");
    expect(calls[0].prompt).not.toContain("金君雅");
  });





  it("blocks non-workflow person images when no persona reference image exists", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/person.png" };
      },
    };

    const result = await generatePersonaImage(
      imageAPI,
      nonWorkflowSetup(),
      "本人穿搭照，坐在窗邊看書",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("blocked-missing-reference");
    expect(result.error).toContain("还没有人设图");
    expect(calls).toHaveLength(0);
  });

  it("uses the stored reference image for non-workflow person images", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/person.png" };
      },
    };

    const result = await generatePersonaImage(
      imageAPI,
      nonWorkflowSetup(),
      "本人穿搭照，坐在窗邊看書",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
      "none",
      undefined,
      "data:image/png;base64,cmVmZXJlbmNl",
    );

    expect(result).toMatchObject({ ok: true, mode: "closed-person" });
    expect(calls[0].avatarBase64).toBe("cmVmZXJlbmNl");
  });

  it("keeps an explicitly selected reference image for scene edits", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/edited-scene.png" };
      },
    };

    const result = await generatePersonaImage(
      imageAPI,
      nonWorkflowSetup(),
      "只修改背景为海边黄昏，不要出现人物，只保留海面、天空和原图构图",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
      "none",
      "data:image/png;base64,c2VsZWN0ZWQ=",
    );

    expect(result).toMatchObject({ ok: true, mode: "closed-scene" });
    expect(calls[0].avatarBase64).toBe("c2VsZWN0ZWQ=");
    expect(calls[0].runningHubNewPersonaMode).toBe("image-to-image");
    expect(calls[0].prompt).toContain("unless the current request explicitly asks to change the face or identity");
  });

  it("allows non-workflow POV scene images without a reference and constrains visible hands", async () => {
    const calls: any[] = [];
    const setup = nonWorkflowSetup();
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/pov.png" };
      },
    };

    const result = await generatePersonaImage(
      imageAPI,
      setup,
      "在咖啡館等待朋友，第一人稱視角，手拿咖啡杯",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(result).toMatchObject({ ok: true, mode: "closed-pov" });
    expect(calls[0].avatarBase64).toBeUndefined();
    expect(calls[0].runningHubNewPersonaMode).toBe("text-to-image");
    expect(calls[0].prompt).toContain("gender: 女性");
    expect(calls[0].prompt).toContain("neat soft hands");
  });

  it("exposes a route result for non-workflow missing references", () => {
    expect(resolvePersonaImageRoute("自拍穿搭照", nonWorkflowSetup()).kind).toBe("blocked-missing-reference");
    expect(resolvePersonaImageRoute("自拍穿搭照", nonWorkflowSetup(), "auto", undefined, "data:image/png;base64,abc").kind)
      .toBe("closed-person-with-reference");
    expect(buildPersonaImagePrompt("分享風景和海邊夕陽", nonWorkflowSetup()).mode).toBe("closed-scene");
  });

  it("adds strict no-human constraints for explicit no-person scene requests", () => {
    const built = buildPersonaImagePrompt(
      "不要出現人物，只拍桌面咖啡杯、書本和窗邊光影，不要臉不要手",
      nonWorkflowSetup(),
      "auto",
    );
    expect(built.mode).toBe("closed-scene");
    expect(built.prompt).toContain("absolutely no humans in frame");
    expect(built.prompt).toContain("no hands");
    expect(built.prompt).toContain("no face on any screen");
    expect(built.prompt).toContain("focus only on objects and environment");
  });
});
