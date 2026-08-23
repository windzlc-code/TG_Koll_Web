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

export type PersonaImageGenerationMode = "auto" | "person" | "pov" | "scene";
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
  if (requestedMode === "person") return "closed-person";
  if (requestedMode === "pov") return "closed-pov";
  if (requestedMode === "scene") return "closed-scene";
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

function refineSheetVisualTraits(customPrompt?: string): string {
  return (customPrompt || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

export function buildReferenceSheetPrompt(setup: DramaSetup, personaContent: string, customPrompt?: string): string {
  const appearance = setup.personaAppearance || setup.personaDescription || "";
  const gender = setup.personaGender || "女性";
  const nationality = setup.personaNationality || "";
  const contentHint = personaContent.slice(0, 300);
  const extraTraits = refineSheetVisualTraits(customPrompt);
  return [
    `character reference sheet, three views: front view, side view, back view, same person all three angles, consistent appearance`,
    appearance ? `appearance: ${appearance}` : "",
    `${nationality ? nationality + " " : ""}${gender}, photorealistic, natural lighting`,
    contentHint ? `persona style hint: ${contentHint.replace(/\n/g, " ").slice(0, 150)}` : "",
    extraTraits ? `naturally blend in these extra visual traits: ${extraTraits}` : "",
    "white or neutral background, full body or half body, no text, no watermark, high detail, consistent face and outfit across all three views",
  ].filter(Boolean).join(", ");
}

export function buildPersonaImagePrompt(
  content: string,
  setup: DramaSetup,
  requestedMode: PersonaImageGenerationMode = "auto",
  referenceMode: PersonaImageReferenceMode = "none",
): { prompt: string; mode: PersonaImageClosedMode; withAvatar: boolean } {
  const signals = getPersonaImageSignals(setup, content);
  const mode = resolvePersonaImageMode(content, setup, requestedMode);
  const referencePrompt = referenceMode === "outfit"
    ? "reference image should guide outfit and styling only, do not copy pose or framing"
    : referenceMode === "pose"
      ? "reference image should guide pose and body gesture only, do not copy outfit details"
      : referenceMode === "outfit+pose"
        ? "reference image should guide both outfit styling and pose, while keeping the new scene natural"
        : "";

  if (mode === "closed-person") {
    return {
      prompt: [
        buildPersonaSocialImagePrompt(content, setup, signals),
        "photorealistic portrait or half-body lifestyle photo, consistent same person, natural body language, no text, no watermark",
        referencePrompt,
      ].filter(Boolean).join(", "),
      mode,
      withAvatar: true,
    };
  }

  if (mode === "closed-pov") {
    return {
      prompt: [buildSceneOnlyImagePrompt(content, setup, signals), referencePrompt].filter(Boolean).join(", "),
      mode,
      withAvatar: false,
    };
  }

  return {
    prompt: [buildSceneOnlyImagePrompt(content, setup, signals), referencePrompt].filter(Boolean).join(", "),
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

export function buildLibraryImageEditPrompt(customPrompt: string): string {
  const request = (customPrompt || "").replace(/\s+/g, " ").trim();
  return [
    request ? `Current request: ${request}` : "",
    "Edit the attached source image. The attached image is the only visual source.",
    "Keep the original composition, layout, number of views, camera framing, and background unless the current request explicitly asks to change them.",
    "If the source is a three-view character sheet, keep three views of the same person: front view, side view, and back view.",
    "Apply the current request onto the person already in the attached image. Do not generate a new lifestyle photo, selfie, or unrelated scene. No text, no watermark.",
  ].filter(Boolean).join("\n");
}

export async function generateLibraryImageEdit(
  imageAPI: any,
  sourceImageUrl: string,
  customPrompt: string,
  model: string,
  aspectRatio: string,
  runtimeOptions?: PersonaImageRuntimeOptions,
): Promise<{ ok: boolean; url?: string; mode: "library-image-edit"; error?: string; timings?: unknown }> {
  if (!imageAPI?.generate) return { ok: false, mode: "library-image-edit", error: "image API 不可用" };
  const source = String(sourceImageUrl || "").trim();
  if (!source) return { ok: false, mode: "library-image-edit", error: "未找到要修改的人设图。" };
  const request = String(customPrompt || "").trim();
  if (!request) return { ok: false, mode: "library-image-edit", error: "请输入对选中人设图的修改要求。" };
  const prompt = buildLibraryImageEditPrompt(request);
  const avatarBase64 = source.replace(/^data:[^;]+;base64,/, "");
  const avatarMimeType = (source.match(/^data:([^;]+);/) || [])[1] || "image/jpeg";
  const result = await callClosedModel(imageAPI, prompt, model, aspectRatio, avatarBase64, avatarMimeType, runtimeOptions, {
    runningHubNewPersonaMode: "image-to-image",
    avatarSource: source,
  });
  return { ok: !!result?.ok, url: result?.url, mode: "library-image-edit", error: result?.error, timings: (result as any)?.timings };
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


  // Closed-model personas: use existing avatar as seed if available
  const avatarBase64 = setup.personaAvatarUrl
    ? setup.personaAvatarUrl.replace(/^data:[^;]+;base64,/, "")
    : undefined;
  const avatarMimeType = setup.personaAvatarUrl
    ? ((setup.personaAvatarUrl.match(/^data:([^;]+);/) || [])[1] || "image/jpeg")
    : undefined;
  return callClosedModel(imageAPI, prompt, model, "1:1", avatarBase64, avatarMimeType, runtimeOptions, {
    runningHubNewPersonaMode: "text-to-image",
    avatarSource: setup.personaAvatarUrl,
  });
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

  const built = buildPersonaImagePrompt(content, setup, requestedMode, referenceMode);
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
  return { ok: !!result?.ok, url: result?.url, mode, error: result?.error, timings: (result as any)?.timings };
}
