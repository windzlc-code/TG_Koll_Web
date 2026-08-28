import { describe, expect, it } from "vitest";

import {
  buildPersonaImagePrompt,
  buildPersonaCardImageDirection,
  buildReferenceSheetPrompt,
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
    expect(calls[0].avatarBase64).toBeUndefined();
    expect(calls[0].avatarSource).toBeUndefined();
    expect(calls[0].prompt).toContain("character reference sheet, three views");
  });

  it("sends the user visual request into the text-to-image model prompt", async () => {
    const calls: any[] = [];
    const userPrompt = "性感美女穿着性感，喜欢穿低胸装。";
    const result = await generateReferenceSheet(
      {
        generate: async (payload: any) => {
          calls.push(payload);
          return { ok: true, url: "https://example.com/reference-sheet.png" };
        },
      },
      nonWorkflowSetup({
        personaAppearance: "",
        personaDescription: "深耕日本高端不動產12年的台籍專屬融資顧問，台灣富豪圈的置產軍師。",
        personaNationality: "",
      }),
      "敏姐是一位深耕東京與大阪頂級不動產長達12年的台籍專屬融資顧問。",
      "gemini-3.1-flash-image-preview",
      undefined,
      userPrompt,
    );

    expect(result.ok).toBe(true);
    expect(result.customPrompt).toBe(userPrompt);
    expect(result.prompt).toContain(userPrompt);
    expect(calls).toHaveLength(1);
    expect(calls[0].runningHubNewPersonaMode).toBe("text-to-image");
    expect(calls[0].prompt).toContain(userPrompt);
    expect(calls[0].prompt).toContain(`mandatory appearance: ${userPrompt}`);
    expect(calls[0].prompt.split(userPrompt).length - 1).toBe(1);
    expect(calls[0].prompt).toContain("show every selected age, facial, hairstyle, temperament, clothing and body attribute clearly");
    expect(calls[0].prompt).not.toContain(" or ");
    expect(calls[0].prompt).not.toContain("obey this request:");
    expect(calls[0].prompt).not.toContain("appearance: 深耕日本高端不動產12年的台籍專屬融資顧問，台灣富豪圈的置產軍師。");
    expect(calls[0].prompt).not.toContain("融資顧問");
    expect(calls[0].prompt).not.toContain("do not default to office suit");
    expect(calls[0].prompt).not.toContain("expression mood:");
    expect(calls[0].prompt).not.toContain("溫柔細膩");
    expect(calls[0].prompt).not.toContain("台灣繁體中文日常分享");
    expect(calls[0].prompt).not.toContain("persona identity context");
  });

  it("does not seed persona reference sheets with an existing avatar", async () => {
    const calls: any[] = [];
    await generateReferenceSheet(
      {
        generate: async (payload: any) => {
          calls.push(payload);
          return { ok: true, url: "https://example.com/reference-sheet.png" };
        },
      },
      nonWorkflowSetup({ personaAvatarUrl: "data:image/png;base64,b2xkLWF2YXRhcg==" }),
      "日常生活观察者",
      "gemini-3.1-flash-image-preview",
    );

    expect(calls[0].runningHubNewPersonaMode).toBe("text-to-image");
    expect(calls[0].avatarBase64).toBeUndefined();
    expect(calls[0].avatarSource).toBeUndefined();
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

  it("lets the user visual request own appearance without replacing the empty-prompt template", () => {
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

    expect(prompt).toContain("mandatory appearance: 爆乳美女，身材非常的好，会十分的性感诱惑。");
    expect(prompt).not.toContain("appearance: 深耕日本高端不動產12年的台籍專屬融資顧問，台灣富豪圈的置產軍師。");
    expect(prompt.split("爆乳美女，身材非常的好，会十分的性感诱惑。").length - 1).toBe(1);
    expect(prompt).toContain("show every selected age, facial, hairstyle, temperament, clothing and body attribute clearly");
    expect(prompt).not.toContain("obey this request:");
    expect(prompt).not.toContain("expression mood:");
    expect(prompt).not.toContain("溫柔細膩");
    expect(prompt).not.toContain("台灣繁體中文日常分享");
    expect(prompt).not.toContain("persona identity context");
    expect(prompt).not.toContain("naturally blend in these extra visual traits");
    expect(prompt).not.toContain("融資顧問");
    expect(prompt).not.toContain("do not default to office suit");
  });

  it("blocks persona identity, writing style, and personality when the user prompt exists", () => {
    const prompt = buildReferenceSheetPrompt(
      {
        ...nonWorkflowSetup({
          personaAppearance: "",
          personaDescription: "深耕日本高端不動產12年的台籍專屬融資顧問，台灣富豪圈的置產軍師。",
          personaPersonality: "專業、沉穩、高雅、值得信賴的智囊",
          personaStyle: "以專業數據與實戰經驗說話，語氣從容自信，展現高端商務顧問的格局與深度。",
          personaNationality: "",
        }),
      },
      "敏姐是一位深耕東京與大阪頂級不動產長達12年的台籍專屬融資顧問。",
      "性感美女喜欢穿低胸装，配上黑丝。",
    );

    expect(prompt).toContain("mandatory appearance: 性感美女喜欢穿低胸装，配上黑丝。");
    expect(prompt.split("性感美女喜欢穿低胸装，配上黑丝。").length - 1).toBe(1);
    expect(prompt).toContain("show every selected age, facial, hairstyle, temperament, clothing and body attribute clearly");
    expect(prompt).not.toContain("obey this request:");
    expect(prompt).not.toContain("expression mood:");
    expect(prompt).not.toContain("專業、沉穩、高雅、值得信賴的智囊");
    expect(prompt).not.toContain("商務顧問");
    expect(prompt).not.toContain("專業數據");
    expect(prompt).not.toContain("融資顧問");
    expect(prompt).not.toContain("不動產");
    expect(prompt).not.toContain("置產軍師");
    expect(prompt).not.toContain("敏姐是一位");
    expect(prompt).not.toContain("do not default to office suit");
  });

  it("keeps selected visual attributes free of stale persona appearance directions", () => {
    const request = "中国成年人，18至22岁的成年女性，马尾发型，妩媚性感气质，贴身缎面吊带睡裙";
    const prompt = buildReferenceSheetPrompt(
      nonWorkflowSetup({
        personaAppearance: "职业女性，正式西装，商务干练气质，专业房地产顾问",
        personaDescription: "专业房地产顾问",
        personaNationality: "中国",
      }),
      "专业房地产顾问",
      request,
    );

    expect(prompt).toContain(`mandatory appearance: ${request}`);
    expect(prompt.split(request).length - 1).toBe(1);
    expect(prompt).not.toContain("职业女性");
    expect(prompt).not.toContain("正式西装");
    expect(prompt).not.toContain("商务干练气质");
    expect(prompt).not.toContain("房地产顾问");
    expect(prompt).not.toContain(" or ");
  });

  it("keeps unmentioned visual details and still gives the user outfit request priority", () => {
    const prompt = buildReferenceSheetPrompt(
      nonWorkflowSetup({ personaNationality: "" }),
      "日常生活观察者，simple cream cardigan",
      "穿红色连衣裙",
    );
    expect(prompt).toContain("mandatory appearance: 穿红色连衣裙, twenty-something Taiwanese woman, fair skin, neat soft hands");
    expect(prompt.split("穿红色连衣裙").length - 1).toBe(1);
    expect(prompt).toContain("show every selected age, facial, hairstyle, temperament, clothing and body attribute clearly");
    expect(prompt).not.toContain("obey this request:");
    expect(prompt).not.toContain("appearance: twenty-something Taiwanese woman, fair skin, neat soft hands, simple cream cardigan");
    expect(prompt).not.toContain("naturally blend in these extra visual traits");
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

  it("builds environment-only prompts for explicit scene style", () => {
    const built = buildPersonaImagePrompt(
      "路过便利店买了杯冰美式",
      nonWorkflowSetup(),
      "scene",
      "none",
      "便利店夜景",
    );
    expect(built.mode).toBe("closed-scene");
    expect(built.withAvatar).toBe(false);
    expect(built.prompt).toContain("the persona protagonist must not appear");
    expect(built.prompt).toContain("other people, pedestrians or crowds may appear");
    expect(built.prompt).toContain("便利店夜景");
    expect(built.prompt).not.toContain("absolutely no person in frame");
    expect(built.prompt).not.toContain("photorealistic portrait or half-body lifestyle photo");
  });

  it("builds object-only prompts for explicit object style", () => {
    const built = buildPersonaImagePrompt(
      "路过便利店买了杯冰美式",
      nonWorkflowSetup(),
      "object",
      "none",
      "冰美式特写",
    );
    expect(built.mode).toBe("closed-scene");
    expect(built.withAvatar).toBe(false);
    expect(built.prompt).toContain("object-only still-life");
    expect(built.prompt).toContain("冰美式特写");
  });

  it("builds third-person documentary prompts instead of selfies", () => {
    const built = buildPersonaImagePrompt(
      "路过便利店买了杯冰美式",
      nonWorkflowSetup(),
      "third_person",
      "none",
      "路过便利店",
    );
    expect(built.mode).toBe("closed-person");
    expect(built.withAvatar).toBe(true);
    expect(built.prompt).toContain("third-person candid documentary photo");
    expect(built.prompt).toContain("not a selfie");
    expect(built.prompt).toContain("use this specific camera and pose setup for this post");
    expect(built.prompt).toContain("never a character sheet, multi-view layout");
    expect(built.prompt).not.toContain("photorealistic portrait or half-body lifestyle photo");
  });

  it("builds varied lived-in camera direction for persona tweet images", () => {
    const built = buildPersonaImagePrompt(
      "下班回家躺在床上，终于可以放松一下",
      nonWorkflowSetup(),
      "person",
      "none",
      "卧室随手拍",
    );
    const alternate = buildPersonaImagePrompt(
      "下班回家躺在床上，终于可以放松一下",
      nonWorkflowSetup(),
      "person",
      "none",
      "街头走动抓拍",
    );
    expect(built.mode).toBe("closed-person");
    expect(built.withAvatar).toBe(true);
    expect(built.prompt).toContain("卧室随手拍");
    expect(built.prompt).toContain("use this specific camera and pose setup for this post");
    expect(built.prompt).toContain("do not default to a centered eye-level front-facing half-body pose");
    expect(built.prompt).toContain("when the post does not name a location, use this fallback lived-in setting");
    expect(built.prompt).toContain("it overrides any conflicting camera, pose, or fallback setting");
    expect(built.prompt).toContain("keep the named action mandatory and adapt the selected setup around it");
    expect(built.prompt).toContain("use it only to preserve face and identity");
    expect(alternate.prompt).not.toBe(built.prompt);
    expect(built.prompt).not.toContain("photorealistic portrait or half-body lifestyle photo");
    expect(built.prompt).not.toContain("avoid a generic portrait, generic selfie");
  });

  it("keeps the no-tag default content-led and lifestyle-oriented", () => {
    const built = buildPersonaImagePrompt(
      "下班路过便利店买了杯冰美式，站在店外吹风",
      nonWorkflowSetup(),
      "person",
    );

    expect(built.mode).toBe("closed-person");
    expect(built.withAvatar).toBe(true);
    expect(built.prompt).toContain("下班路过便利店买了杯冰美式");
    expect(built.prompt).toContain("use this specific camera and pose setup for this post");
    expect(built.prompt).toContain("candid iPhone-style capture");
    expect(built.prompt).not.toContain("portrait direction:");
  });

  it("rotates through a broad camera and background sample pool", () => {
    const styleHints = [
      "卧室随手拍", "街头走动抓拍", "窗边侧拍", "镜前自拍", "通勤等待", "夜间闲逛",
      "靠墙抓拍", "俯拍近景", "购物途中", "坐姿回头", "户外阳光", "咖啡店日常",
    ];
    const prompts = styleHints.map((styleHint) => buildPersonaImagePrompt(
      "记录今天很普通但很开心的一刻",
      nonWorkflowSetup(),
      "person",
      "none",
      styleHint,
    ).prompt);
    const cameraSetups = new Set(prompts.map((prompt) => (
      prompt.match(/use this specific camera and pose setup for this post: (.+?), do not default/)?.[1] || ""
    )));
    const backgroundSetups = new Set(prompts.map((prompt) => (
      prompt.match(/use this fallback lived-in setting: (.+?), if the post explicitly/)?.[1] || ""
    )));
    expect(cameraSetups.has("")).toBe(false);
    expect(backgroundSetups.has("")).toBe(false);
    expect(cameraSetups.size).toBeGreaterThanOrEqual(9);
    expect(backgroundSetups.size).toBeGreaterThanOrEqual(6);

    const coveragePrompts = Array.from({ length: 200 }, (_, index) => buildPersonaImagePrompt(
      "记录今天很普通但很开心的一刻",
      nonWorkflowSetup(),
      "person",
      "none",
      `audit-${index}`,
    ).prompt).join("\n");
    [
      "close casual food or drink moment",
      "high overhead full-body phone angle",
      "busy street-market snapshot",
      "casual class, rehearsal, or group-activity moment",
      "a busy daytime market lane",
      "a casual restaurant or cafe table",
      "a dance, fitness, workshop or rehearsal room",
      "a neighborhood playground or small public park",
      "diagonal arm-extended bed snapshot",
      "casual bedroom outfit-check",
      "tight golden-hour coastal close-up",
      "outdoor exercise check-in",
      "at-home hobby moment",
      "window-side mood snapshot",
      "a breezy shoreline, riverside path or coastal promenade",
      "a compact bedroom outfit-check area",
    ].forEach((cue) => expect(coveragePrompts).toContain(cue));
  });
});
