import { describe, expect, it } from "vitest";

import {
  buildPersonaImagePrompt,
  buildPersonaCardImageDirection,
  generatePersonaImage,
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
    imageWorkflow: {
      provider: "comfyui",
      workflowFile: "人设3小mii.json",
      workflowId: "2056699900515143681",
      personaKey: "xiaomii",
    },
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
  it("uses the generated post as the main workflow image prompt source", async () => {
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
    expect(calls[0].prompt).toContain("persona-card visual direction");
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
    expect(calls[0].workflowImage).toBeUndefined();
    expect(calls[0].prompt).toContain("first-person POV");
    expect(calls[0].prompt).toContain("gender: 男性");
    expect(calls[0].prompt).toContain("no full person");
  });

  it("keeps ordinary workflow persona cafe posts on the person workflow path", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/cafe-person.png" };
      },
    };

    const result = await generatePersonaImage(
      imageAPI,
      workflowSetup(),
      "今天在咖啡館等朋友，桌上有拿鐵和筆記本，下午光線很好",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(result).toMatchObject({ ok: true, mode: "workflow" });
    expect(calls[0].workflowImage).toBeTruthy();
    expect(calls[0].prompt).toContain("the persona must be visibly in frame");
    expect(calls[0].prompt).toContain("face recognizable");
    expect(calls[0].prompt).toContain("the entire face must be visible from forehead to chin");
    expect(calls[0].prompt).toContain("no book, cup, phone, hand or other prop covering the mouth");
    expect(calls[0].prompt).toContain("both hands must stay away from the face and stay below chest level");
    expect(calls[0].prompt).toContain("forearms resting flat on the table");
    expect(calls[0].prompt).toContain("clear unobstructed lower face and lips");
    expect(calls[0].prompt).toContain("no covering-mouth gesture");
    expect(calls[0].prompt).toContain("no see-through clothing");
    expect(calls[0].prompt).toContain("hands should not pull the neckline or shirt");
    expect(calls[0].prompt).not.toContain("accidental drink spill");
    expect(calls[0].prompt).not.toContain("wet fabric");
  });

  it("falls back to the workflow when a workflow persona closed-model scene times out", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        if (!payload.workflowImage) {
          return { ok: false, error: "圖片 API 請求逾時（180 秒）", retryable: true, reasonCode: "timeout" };
        }
        return { ok: true, url: "https://example.com/workflow-fallback.png", timings: { provider: "runninghub-workflow" } };
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

    expect(result).toMatchObject({ ok: true, mode: "workflow", url: "https://example.com/workflow-fallback.png" });
    expect(calls).toHaveLength(2);
    expect(calls[0].workflowImage).toBeUndefined();
    expect(calls[1].workflowImage).toBeTruthy();
    expect(calls[1].prompt).toContain("fallback from slow closed image model");
  });

  it("keeps person-focused mixed content on the workflow path", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/selfie.png" };
      },
    };

    const result = await generatePersonaImage(
      imageAPI,
      workflowSetup(),
      "她在咖啡店自拍，穿搭是球場外套和休閒褲",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(result).toMatchObject({ ok: true, mode: "workflow" });
    expect(calls[0].workflowImage).toBeTruthy();
  });

  it("uses custom visual instructions when routing generated workflow images", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/visual-instruction.png" };
      },
    };

    const result = await generatePersonaImage(
      imageAPI,
      workflowSetup(),
      "今天分享桌上的咖啡、書和窗邊光影",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
      "none",
      undefined,
      undefined,
      undefined,
      "配图必须出现该人设本人，真实手机生活照，不要纯场景图",
    );

    expect(result).toMatchObject({ ok: true, mode: "workflow" });
    expect(calls[0].workflowImage).toBeTruthy();
    expect(calls[0].prompt).toContain("配图必须出现该人设本人");
    expect(calls[0].prompt).toContain("visual instruction priority");
  });

  it("does not treat negated object-only wording as a no-person request", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/not-object-only.png" };
      },
    };

    const result = await generatePersonaImage(
      imageAPI,
      workflowSetup(),
      "今天分享桌上的咖啡、書和窗邊光影",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
      "none",
      undefined,
      undefined,
      undefined,
      "配图必须出现该人设本人，不要纯场景图，不要只拍物件",
    );

    expect(result).toMatchObject({ ok: true, mode: "workflow" });
    expect(calls[0].workflowImage).toBeTruthy();
  });

  it("falls back to RunningHub workflow when remote ComfyUI workflow generation fails", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        if (payload.workflowImage?.executionProvider === "runninghub") {
          return { ok: true, url: "https://example.com/runninghub-fallback.png", timings: { provider: "runninghub-workflow" } };
        }
        return { ok: false, error: "ComfyUI 返回 404：", timings: { provider: "comfyui-workflow" } };
      },
    };

    const result = await generatePersonaImage(
      imageAPI,
      workflowSetup({
        imageWorkflow: {
          provider: "comfyui",
          workflowFile: "人设1 金君雅.json",
          workflowId: "2056699867040403457",
          personaKey: "jinjunya",
        } as any,
      }),
      "她在咖啡店自拍，穿搭是球場外套和休閒褲",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].workflowImage?.executionProvider).toBeUndefined();
    expect(calls[1].workflowImage?.executionProvider).toBe("runninghub");
    expect(result).toMatchObject({ ok: true, mode: "workflow", url: "https://example.com/runninghub-fallback.png" });
  });

  it("falls back to the AI app when both remote ComfyUI and RunningHub workflow fail", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        if (!payload.workflowImage) {
          return { ok: true, url: "https://example.com/ai-app-fallback.png", timings: { provider: "runninghub-ai-app" } };
        }
        return { ok: false, error: "ComfyUI 返回 404：" };
      },
    };

    const result = await generatePersonaImage(
      imageAPI,
      workflowSetup({
        imageWorkflow: {
          provider: "comfyui",
          workflowFile: "人设1 金君雅.json",
          workflowId: "2056699867040403457",
          personaKey: "jinjunya",
        } as any,
      }),
      "她在咖啡店自拍，穿搭是球場外套和休閒褲",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(calls).toHaveLength(3);
    expect(calls[0].workflowImage?.executionProvider).toBeUndefined();
    expect(calls[1].workflowImage?.executionProvider).toBe("runninghub");
    expect(calls[2].workflowImage).toBeUndefined();
    expect(result).toMatchObject({ ok: true, mode: "workflow", url: "https://example.com/ai-app-fallback.png" });
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
    expect(calls[0].workflowImage).toBeUndefined();
    expect(calls[0].prompt).toContain("medium-long distance environment-only landscape photo");
    expect(calls[0].prompt).toContain("strict no-person medium-long landscape photo");
    expect(calls[0].prompt).toContain("no pedestrians");
    expect(calls[0].prompt).not.toContain("object-focused tabletop lifestyle photo");
    expect(calls[0].prompt).not.toContain("coffee cup, notebook or book");
    expect(calls[0].prompt).not.toContain("no phone in the frame unless explicitly requested");
    expect(calls[0].prompt).not.toContain("金君雅");
  });

  it("adds medium-shot composition guidance to workflow post images by default", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/lifestyle.png" };
      },
    };

    await generatePersonaImage(
      imageAPI,
      workflowSetup(),
      "她在外站下午茶拍了一張生活照，點了一塊蛋糕，旁邊窗景很漂亮",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(calls[0].prompt).toContain("medium shot or waist-up lifestyle photo");
    expect(calls[0].prompt).toContain("face occupies roughly 20-35 percent");
    expect(calls[0].prompt).toContain("include torso, hands, outfit details");
    expect(calls[0].prompt).toContain("no direct flash");
    expect(calls[0].prompt).not.toContain("face-filling selfie framing");
  });

  it("uses a stronger medium-long composition branch when explicitly requested", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/medium-long.png" };
      },
    };

    await generatePersonaImage(
      imageAPI,
      workflowSetup(),
      "今天在城市街角的咖啡店外散步，想拍一張正常中遠景生活照，讓人和街景一起入鏡。",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
      "none",
      undefined,
      undefined,
      undefined,
      "相機距離人物約 3 到 5 公尺，第三人稱路人視角，35mm street photography，人物全身或七分身入鏡",
    );

    expect(calls[0].prompt).toContain("composition hard constraint: medium-long or full-body street lifestyle photo");
    expect(calls[0].prompt).toContain("camera distance must feel like 3 to 5 meters");
    expect(calls[0].prompt).toContain("environment must occupy most of the frame");
    expect(calls[0].prompt).toContain("both arms and both hands must be visible away from the face");
    expect(calls[0].prompt).toContain("do not raise either hand above the shoulder line");
    expect(calls[0].prompt).toContain("no hand on cheek");
    expect(calls[0].prompt).not.toContain("medium shot or waist-up lifestyle photo");
  });

  it("only allows close-up workflow framing when the post asks for it", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/closeup.png" };
      },
    };

    await generatePersonaImage(
      imageAPI,
      workflowSetup(),
      "今天想拍一張妝容特寫，看看眼妝有沒有成功",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(calls[0].prompt).toContain("close-up is allowed only because the post explicitly asks for it");
    expect(calls[0].prompt).toContain("does not look like a cropped ID headshot");
  });

  it("does not inject optional bunny or flash style when explicitly negated", async () => {
    const calls: any[] = [];
    const imageAPI = {
      generate: async (payload: any) => {
        calls.push(payload);
        return { ok: true, url: "https://example.com/no-optional-style.png" };
      },
    };

    await generatePersonaImage(
      imageAPI,
      workflowSetup({ imageWorkflow: { provider: "comfyui", workflowFile: "x.json", personaKey: "jinjunya" } as any }),
      "不要兔耳也不要閃光自拍，今天在咖啡店拍生活照",
      "auto",
      "gemini-3.1-flash-image-preview",
      "1:1",
    );

    expect(calls[0].prompt).not.toContain("optional style requested by post: white fluffy bunny-ear headband may appear");
    expect(calls[0].prompt).not.toContain("optional style requested by post: direct flash smartphone selfie look may appear");
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
