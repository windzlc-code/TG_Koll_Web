import {
  buildGirlPersonaImagePrompt,
  buildPersonaSocialImagePrompt,
  buildPersonaVisualIdentityCue,
  buildSceneOnlyImagePrompt,
  classifyPersonaImageSubject,
  getPersonaImageSignals,
  type PersonaImageSignals,
  type PersonaImageSubject,
} from "@/lib/persona-image-search";
import type { DramaSetup } from "@/types/drama";

export type PersonaImageGenerationMode = "auto" | "person" | "pov" | "scene" | "object" | "third_person";
export type PersonaImageReferenceMode = "none" | "outfit" | "pose" | "outfit+pose";
export type PersonaImageClosedMode = "closed-person" | "closed-pov" | "closed-scene";
export type PersonaImageResolvedMode = PersonaImageClosedMode | "blocked-missing-reference";
export type PersonaImageRouteKind =
  | "closed-person-with-reference"
  | "closed-pov"
  | "closed-scene"
  | "blocked-missing-reference";

export interface PersonaImageRoute {
  kind: PersonaImageRouteKind;
  mode: PersonaImageClosedMode | "blocked-missing-reference";
  subject: PersonaImageSubject;
  referenceUrl?: string;
}

export function resolvePersonaImageMode(
  content: string,
  setup: DramaSetup,
  requestedMode: PersonaImageGenerationMode = "auto",
): PersonaImageClosedMode {
  if (requestedMode === "person" || requestedMode === "third_person") return "closed-person";
  if (requestedMode === "pov") return "closed-pov";
  if (requestedMode === "scene" || requestedMode === "object") return "closed-scene";
  const subject = classifyPersonaImageSubject(content, setup);
  if (subject === "pov") return "closed-pov";
  if (subject === "scene") return "closed-scene";
  return "closed-person";
}

function getExplicitPersonaReferenceUrl(
  setup: DramaSetup,
  referenceImageUrl?: string,
  referenceSheetUrl?: string,
): string | undefined {
  const setupReference = typeof (setup as any).personaImageReferenceUrl === "string"
    ? (setup as any).personaImageReferenceUrl.trim()
    : "";
  return referenceImageUrl?.trim() || referenceSheetUrl?.trim() || setupReference || undefined;
}

export function resolvePersonaImageRoute(
  content: string,
  setup: DramaSetup,
  requestedMode: PersonaImageGenerationMode = "auto",
  referenceImageUrl?: string,
  referenceSheetUrl?: string,
): PersonaImageRoute {
  const mode = resolvePersonaImageMode(content, setup, requestedMode);
  const subject: PersonaImageSubject = mode === "closed-person"
    ? "person"
    : mode === "closed-pov"
      ? "pov"
      : "scene";

  if (subject === "person") {
    const referenceUrl = getExplicitPersonaReferenceUrl(setup, referenceImageUrl, referenceSheetUrl);
    if (!referenceUrl) {
      return { kind: "blocked-missing-reference", mode: "blocked-missing-reference", subject };
    }
    return { kind: "closed-person-with-reference", mode: "closed-person", subject, referenceUrl };
  }

  return {
    kind: subject === "pov" ? "closed-pov" : "closed-scene",
    mode,
    subject,
  };
}

const SHEET_VISUAL_SLOTS: Array<{ id: string; pattern: RegExp }> = [
  { id: "clothing", pattern: /穿|衣服|裙|西装|西裝|制服|外套|针织|針織|大衣|衬衫|襯衫|裤|褲|帽|鞋|低胸|黑丝|黑絲|丝袜|絲襪|袜|襪|吊带|吊帶|露肩|紧身|緊身|hoodie|jacket|dress|suit|cardigan|outfit|服装|服裝|衣着|衣著|毛衣|连衣|連衣|stockings|pantyhose|tights/i },
  { id: "hair", pattern: /发|髮|短发|长发|卷发|直发|发型|劉海|刘海|hair|bangs/i },
  { id: "face", pattern: /脸|臉|五官|妆|妝|网红脸|網紅臉|面容|face|makeup/i },
  { id: "body", pattern: /身材|胸|腰|臀|瘦|胖|高挑|矮|凹凸|爆乳|性感|诱惑|誘惑|身形|body|figure|slim|curvy/i },
  { id: "accessories", pattern: /眼镜|眼鏡|墨镜|墨鏡|耳环|耳環|项链|項鍊|手表|手錶|包|glasses|earring|necklace/i },
  { id: "age", pattern: /岁|歲|年龄|年齡|twenty|thirty|forty|\d+\s*year/i },
  { id: "background", pattern: /背景|办公室|辦公室|海边|海邊|室内|室內|场景|場景|background|office|beach/i },
  { id: "pose", pattern: /姿势|姿勢|坐着|站着|pose|sitting|standing/i },
  { id: "look", pattern: /风格|風格|赛博|賽博|写实|寫實|动漫|動漫|电影|電影|氛围|氛圍|质感|質感/i },
];

function splitVisualClauses(text: string): string[] {
  return String(text || "")
    .split(/[，,。；;、\n]+/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function clauseVisualSlots(clause: string): string[] {
  return SHEET_VISUAL_SLOTS.filter((item) => item.pattern.test(clause)).map((item) => item.id);
}

function refineSheetVisualRequest(customPrompt?: string): string {
  return (customPrompt || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

export function applyUserVisualReplacements(
  baseText: string,
  userPrompt?: string,
  options?: { mode?: "merge" | "strip" },
): string {
  const request = refineSheetVisualRequest(userPrompt);
  const base = String(baseText || "").replace(/\s+/g, " ").trim();
  if (!request) return base;
  const replacedSlots = new Set(splitVisualClauses(request).flatMap(clauseVisualSlots));
  if (!replacedSlots.size) replacedSlots.add("look");
  const baseClauses = splitVisualClauses(base);
  const kept = baseClauses.filter((clause) => {
    const slots = clauseVisualSlots(clause);
    if (!slots.length) return true;
    return !slots.some((slot) => replacedSlots.has(slot));
  });
  if (options?.mode === "strip") {
    return kept.length === baseClauses.length ? base : kept.join(", ");
  }
  return [...kept, request].filter(Boolean).join(", ");
}

function resolveSheetGender(setup: DramaSetup, customPrompt?: string): string {
  const request = String(customPrompt || "");
  const mentionsMale = /男性|男人|男生|男的/.test(request);
  const mentionsFemale = /女性|女人|女生|女的/.test(request);
  if (mentionsMale && !mentionsFemale) return "男性";
  if (mentionsFemale && !mentionsMale) return "女性";
  return setup.personaGender || "女性";
}

export function buildReferenceSheetPrompt(setup: DramaSetup, personaContent: string, customPrompt?: string): string {
  const request = refineSheetVisualRequest(customPrompt);
  const nationality = setup.personaNationality || "";
  const gender = request
    ? resolveSheetGender(setup, request)
    : (setup.personaGender || "女性");

  if (!request) {
    const appearance = setup.personaAppearance || setup.personaDescription || "";
    const contentHint = personaContent.slice(0, 300);
    return [
      `character reference sheet, three views: front view, side view, back view, same person all three angles, consistent appearance`,
      appearance ? `appearance: ${appearance}` : "",
      `${nationality ? nationality + " " : ""}${gender}, photorealistic, natural lighting`,
      contentHint ? `persona style hint: ${contentHint.replace(/\n/g, " ").slice(0, 150)}` : "",
      "white or neutral background, full body or half body, no text, no watermark, high detail, consistent face and outfit across all three views",
    ].filter(Boolean).join(", ");
  }

  const visualBase = String(setup.personaAppearance || "").replace(/\s+/g, " ").trim();
  const keptVisual = applyUserVisualReplacements(visualBase, request, { mode: "strip" });
  const appearance = [request, keptVisual].filter(Boolean).join(", ");
  return [
    `character reference sheet, three views: front view, side view, back view, same person all three angles, consistent appearance`,
    appearance ? `appearance: ${appearance}` : "",
    "user appearance has highest priority and must be visible",
    `${nationality ? nationality + " " : ""}${gender}, photorealistic, natural lighting`,
    "white or neutral background, full body or half body, no text, no watermark, high detail, consistent face and outfit across all three views",
  ].filter(Boolean).join(", ");
}

export function buildPersonaImagePrompt(
  content: string,
  setup: DramaSetup,
  requestedMode: PersonaImageGenerationMode = "auto",
  referenceMode: PersonaImageReferenceMode = "none",
  styleHint?: string,
): { prompt: string; mode: PersonaImageClosedMode; withAvatar: boolean } {
  const signals = getPersonaImageSignals(setup, content);
  const mode = resolvePersonaImageMode(content, setup, requestedMode);
  const hint = normalizePromptCue(styleHint || "");
  const referencePrompt = referenceMode === "outfit"
    ? "reference image should guide outfit and styling only, do not copy pose or framing"
    : referenceMode === "pose"
      ? "reference image should guide pose and body gesture only, do not copy outfit details"
      : referenceMode === "outfit+pose"
        ? "reference image should guide both outfit styling and pose, while keeping the new scene natural"
        : "";

  if (requestedMode === "object") {
    const objectContent = `${content}\n不出现人物，不要手，object only，只拍事物特写${hint ? `：${hint}` : ""}`;
    return {
      prompt: [
        buildSceneOnlyImagePrompt(objectContent, setup, signals),
        hint ? `featured object: ${hint}` : "",
        "object-only still-life or product close-up from the post, no person, no face, no body, no hands, candid phone snapshot of the object itself",
        referencePrompt,
      ].filter(Boolean).join(", "),
      mode: "closed-scene",
      withAvatar: false,
    };
  }

  if (requestedMode === "scene") {
    const cleanedContent = String(content || "").replace(/\s+/g, " ").trim().slice(0, 220);
    return {
      prompt: [
        cleanedContent,
        hint ? `visual setting: ${hint}` : "",
        "photograph the background, scenery, architecture, street, interior or landscape described by the post",
        "the persona protagonist must not appear; this is not a portrait or selfie of the main character",
        "other people, pedestrians or crowds may appear as part of the real place when they belong there",
        "not an empty deserted shot, not a vacant no-human void, not a tabletop object close-up, not first-person hands",
        "candid realistic photo, natural available light, no text, no watermark",
        referencePrompt,
      ].filter(Boolean).join(", "),
      mode: "closed-scene",
      withAvatar: false,
    };
  }

  if (requestedMode === "pov") {
    const povContent = `${content}\n第一人称视角，手拿，只露手${hint ? `：${hint}` : ""}`;
    return {
      prompt: [
        buildSceneOnlyImagePrompt(povContent, setup, signals),
        hint ? `first-person subject: ${hint}` : "",
        referencePrompt,
      ].filter(Boolean).join(", "),
      mode: "closed-pov",
      withAvatar: false,
    };
  }

  if (requestedMode === "third_person") {
    return {
      prompt: [
        buildPersonaSocialImagePrompt(content, setup, signals),
        hint ? `third-person scene: ${hint}` : "",
        "third-person candid documentary photo of the same person inside the real environment from the post, three-quarter or full body, not a selfie, not a mirror self-portrait, not looking into the camera, not a studio half-body cutout against a fake backdrop, environment must remain readable",
        referencePrompt,
      ].filter(Boolean).join(", "),
      mode: "closed-person",
      withAvatar: true,
    };
  }

  if (mode === "closed-person") {
    return {
      prompt: [
        buildPersonaSocialImagePrompt(content, setup, signals),
        hint ? `portrait direction: ${hint}` : "",
        "photorealistic portrait or half-body lifestyle photo, consistent same person, natural body language, no text, no watermark",
        referencePrompt,
      ].filter(Boolean).join(", "),
      mode,
      withAvatar: true,
    };
  }

  if (mode === "closed-pov") {
    return {
      prompt: [
        buildSceneOnlyImagePrompt(content, setup, signals),
        hint ? `first-person subject: ${hint}` : "",
        referencePrompt,
      ].filter(Boolean).join(", "),
      mode,
      withAvatar: false,
    };
  }

  return {
    prompt: [
      buildSceneOnlyImagePrompt(content, setup, signals),
      hint ? `environment subject: ${hint}` : "",
      referencePrompt,
    ].filter(Boolean).join(", "),
    mode,
    withAvatar: false,
  };
}

function buildRouteText(content: string, customPrompt?: string): string {
  return [content, customPrompt?.trim() || ""].filter(Boolean).join("\n");
}

export interface PersonaImageRuntimeOptions {
  configPath?: string;
  dataDir?: string;
}

function callClosedModel(
  imageAPI: any,
  prompt: string,
  model: string,
  aspectRatio: string,
  avatarBase64?: string,
  avatarMimeType?: string,
  runtimeOptions?: PersonaImageRuntimeOptions,
  options?: { runningHubNewPersonaMode?: "text-to-image" | "image-to-image"; avatarSource?: string },
): Promise<{ ok: boolean; url?: string; error?: string; timings?: unknown }> {
  return imageAPI.generate({
    prompt,
    model,
    avatarBase64,
    avatarMimeType,
    aspectRatio,
    runningHubNewPersonaMode: options?.runningHubNewPersonaMode,
    avatarSource: options?.avatarSource,
    configPath: runtimeOptions?.configPath,
    dataDir: runtimeOptions?.dataDir,
  });
}

function normalizePromptCue(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function buildPersonaCardImageDirection(setup: DramaSetup, signals?: PersonaImageSignals): string {
  const resolvedSignals = signals || getPersonaImageSignals(setup);
  const cardCues = normalizePromptCue(buildPersonaVisualIdentityCue(setup, resolvedSignals));
  const direction = resolvedSignals.isMemeType
    ? "persona-card visual direction: meme or reaction-image leaning only when the persona card supports it"
    : resolvedSignals.isGirlType
      ? "persona-card visual direction: adult lifestyle social-photo leaning, beauty or playful appeal only when the persona card supports it, non-explicit"
      : "persona-card visual direction: role-based lifestyle or everyday scene, follow the persona card instead of a fixed template";

  return [
    direction,
    cardCues ? `persona card cues: ${cardCues.slice(0, 760)}` : "",
    "the generated image must be immediately distinguishable from other personas by field, role, recurring objects, environment, color mood, and personality-driven body language",
  ].filter(Boolean).join(", ");
}

export async function generateReferenceSheet(
  imageAPI: any,
  setup: DramaSetup,
  personaContent: string,
  model: string,
  runtimeOptions?: PersonaImageRuntimeOptions,
  customPrompt?: string,
): Promise<{ ok: boolean; url?: string; error?: string; timings?: unknown }> {
  if (!imageAPI?.generate) return { ok: false, error: "image API 不可用" };
  const prompt = buildReferenceSheetPrompt(setup, personaContent, customPrompt);
  const result = await callClosedModel(imageAPI, prompt, model, "1:1", undefined, undefined, runtimeOptions, {
    runningHubNewPersonaMode: "text-to-image",
  });
  return {
    ...result,
    prompt,
    customPrompt: String(customPrompt || "").trim(),
  };
}

export async function generatePersonaImage(
  imageAPI: any,
  setup: DramaSetup,
  content: string,
  requestedMode: PersonaImageGenerationMode,
  model: string,
  aspectRatio: string,
  referenceMode: PersonaImageReferenceMode = "none",
  referenceImageUrl?: string,
  referenceSheetUrl?: string,
  runtimeOptions?: PersonaImageRuntimeOptions,
  customPrompt?: string,
  styleHint?: string,
): Promise<{ ok: boolean; url?: string; mode: PersonaImageResolvedMode; error?: string; timings?: unknown }> {
  if (!imageAPI?.generate) return { ok: false, mode: "closed-scene", error: "image API 不可用" };

  const routeText = buildRouteText(content, customPrompt);
  const route = resolvePersonaImageRoute(routeText, setup, requestedMode, referenceImageUrl, referenceSheetUrl);
  const explicitReferenceUrl = referenceImageUrl?.trim() || "";

  if (route.kind === "blocked-missing-reference") {
    return {
      ok: false,
      mode: "blocked-missing-reference",
      error: "这个人设还没有人设图，请先在人设设置里生成人设图。",
    };
  }

  const built = buildPersonaImagePrompt(content, setup, requestedMode, referenceMode, styleHint);
  // An explicitly selected library image always means image-to-image editing.
  // Keep the normal scene/POV classifier for text-only generation, but do not
  // discard the user's source image just because the edit prompt describes a scene.
  const { prompt, mode } = built;
  const withAvatar = Boolean(referenceImageUrl?.trim()) || built.withAvatar;
  const customCue = customPrompt?.trim();
  const finalPrompt = withAvatar
      ? [
        "Use the attached persona reference image as the source. Preserve every area and detail that the current request does not explicitly ask to change; do not replace it with an unrelated image.",
        "Keep the recognizable face and identity unchanged unless the current request explicitly asks to change the face or identity. Clothing, pose, scene, action, camera angle, lighting, and props should follow the current visual request instead of copying the source image unchanged.",
        customCue ? `Highest priority current visual request: ${customCue}` : "",
        "If the base persona description conflicts with the current visual request, obey the current visual request for scene/outfit/action, while preserving the reference face identity.",
        prompt,
      ].filter(Boolean).join("\n")
    : [prompt, customCue || ""].filter(Boolean).join(", ");

  const avatarSource = withAvatar ? (explicitReferenceUrl || route.referenceUrl) : undefined;
  const avatarBase64 = avatarSource ? avatarSource.replace(/^data:[^;]+;base64,/, "") : undefined;
  const avatarMimeType = avatarSource
    ? ((avatarSource.match(/^data:([^;]+);/) || [])[1] || "image/jpeg")
    : undefined;

  const result = await callClosedModel(imageAPI, finalPrompt, model, aspectRatio, avatarBase64, avatarMimeType, runtimeOptions, {
    // 推文配图统一使用后台配置的 RunningHub 链路：有参考图走图生图，
    // 无参考图的场景或 POV 走文生图，不能回退到通用闭源模型。
    runningHubNewPersonaMode: withAvatar ? "image-to-image" : "text-to-image",
    avatarSource,
  });
  return {
    ok: !!result?.ok,
    url: result?.url,
    mode,
    error: result?.error,
    timings: (result as any)?.timings,
    prompt: finalPrompt,
    customPrompt: customCue || "",
  };
}
