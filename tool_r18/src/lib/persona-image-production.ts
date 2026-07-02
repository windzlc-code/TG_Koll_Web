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
  | "workflow-person"
  | "closed-person-with-reference"
  | "closed-pov"
  | "closed-scene"
  | "blocked-missing-reference";

export interface PersonaImageRoute {
  kind: PersonaImageRouteKind;
  mode: PersonaImageClosedMode | "workflow" | "blocked-missing-reference";
  subject: PersonaImageSubject;
  referenceUrl?: string;
}

export function hasWorkflowImage(setup: DramaSetup): boolean {
  return Boolean(setup.imageWorkflow?.provider === "comfyui" && setup.imageWorkflow.workflowFile);
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

  if (hasWorkflowImage(setup) && subject === "person") {
    return { kind: "workflow-person", mode: "workflow", subject };
  }

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

export function buildReferenceSheetPrompt(setup: DramaSetup, personaContent: string): string {
  const appearance = setup.personaAppearance || setup.personaDescription || "";
  const gender = setup.personaGender || "女性";
  const nationality = setup.personaNationality || "";
  const contentHint = personaContent.slice(0, 300);
  return [
    `character reference sheet, three views: front view, side view, back view, same person all three angles, consistent appearance`,
    appearance ? `appearance: ${appearance}` : "",
    `${nationality ? nationality + " " : ""}${gender}, photorealistic, natural lighting`,
    contentHint ? `persona style hint: ${contentHint.replace(/\n/g, " ").slice(0, 150)}` : "",
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

function buildWorkflowRouteText(content: string, customPrompt?: string): string {
  return [content, customPrompt?.trim() || ""].filter(Boolean).join("\n");
}

function isWorkflowBackendFailure(error: unknown, timings?: unknown): boolean {
  const text = [
    String(error || ""),
    typeof timings === "object" && timings ? JSON.stringify(timings) : "",
  ].join(" ");
  return /ComfyUI\s*(?:返回|连接失败|連接失敗)|\b(?:404|408|429|5\d\d)\b|timeout|超時|超时|未返回|network|fetch failed|connection refused|ECONN|ETIMEDOUT/i.test(text);
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

function buildWorkflowPersonaPrompt(content: string, setup: DramaSetup): string {
  const cardSignals = getPersonaImageSignals(setup);
  const contentSignals = {
    ...getPersonaImageSignals(setup, content),
    isMemeType: cardSignals.isMemeType,
    isGirlType: cardSignals.isGirlType,
    isPersonaType: cardSignals.isPersonaType,
  };
  const basePrompt = cardSignals.isGirlType
    ? buildGirlPersonaImagePrompt(content, setup, contentSignals)
    : buildPersonaSocialImagePrompt(content, setup, contentSignals);
  return [
    buildWorkflowCompositionGuidance(content),
    basePrompt,
    buildPersonaCardImageDirection(setup, cardSignals),
    buildOptionalWorkflowStyleGuidance(content, setup),
    setup.imageWorkflow?.promptSuffix?.trim() || "",
  ].filter(Boolean).join(", ");
}

function buildOptionalWorkflowStyleGuidance(content: string, setup: DramaSetup): string {
  const text = String(content || "");
  const personaKey = String(setup.imageWorkflow?.personaKey || "");
  const cues: string[] = [];
  if (/jinjunya/i.test(personaKey)) {
    const negatesBunny = /不要.{0,8}(兔耳|兔子|髮箍|发箍|bunny|rabbit)|不.{0,8}(兔耳|兔子|髮箍|发箍|bunny|rabbit)|no\s+(?:bunny|rabbit|headband)/i.test(text);
    const negatesFlash = /不要.{0,8}(閃光|闪光|直閃|直闪|flash|自拍|selfie)|不.{0,8}(閃光|闪光|直閃|直闪|flash|自拍|selfie)|no\s+(?:flash|selfie)/i.test(text);
    if (!negatesBunny && /兔耳|兔子|髮箍|发箍|bunny|rabbit/i.test(text)) {
      cues.push("optional style requested by post: white fluffy bunny-ear headband may appear");
    }
    if (!negatesFlash && /閃光|闪光|直閃|直闪|flash|自拍|selfie/i.test(text)) {
      cues.push("optional style requested by post: direct flash smartphone selfie look may appear");
    }
  }
  return cues.join(", ");
}

function buildWorkflowCompositionGuidance(content: string): string {
  const text = String(content || "");
  const identityAndClothingGuard = [
    "the entire face must be visible from forehead to chin with both eyes, nose and mouth clearly in frame",
    "no cropped face, no cut off head, no phone covering the face, no face hidden by hair or framing",
    "no book, cup, phone, hand or other prop covering the mouth, nose, eyes or any part of the face",
    "books, coffee cups and objects should stay on the table or beside the person, not in front of the face",
    "both hands must stay away from the face and stay below chest level",
    "forearms resting flat on the table, hands beside the open book or coffee cup on the table, or hands relaxed on the lap",
    "clear unobstructed lower face and lips, mouth fully visible, hands must not rise above the chest",
    "no covering-mouth gesture, no shushing gesture, no blowing-kiss gesture, no hands touching lips or cheeks",
    "ordinary modest opaque everyday clothing that matches the post scene",
    "hands should not pull the neckline or shirt, no see-through clothing, no wet clothing, no cleavage-focused framing unless explicitly requested",
  ].join(", ");
  if (/中遠景|中远景|遠景|远景|中景|街拍|路人視角|路人视角|第三人稱|第三人称|3\s*(?:到|-|~)\s*5\s*(?:公尺|米)|medium[- ]?long|medium[- ]?wide|full[- ]?body|three[- ]?quarter|street photography/i.test(text)) {
    return [
      "composition hard constraint: medium-long or full-body street lifestyle photo, never a close-up, never a headshot, never a tight bust portrait",
      "camera distance must feel like 3 to 5 meters away from the persona, third-person passerby viewpoint, natural 35mm street photography",
      "show the full body or at least from head to knees, with head, shoulders, torso, waist, legs and surroundings visible",
      "the persona face should be recognizable but small in the frame, roughly 8-15 percent of the image area",
      "environment must occupy most of the frame, roughly 65-80 percent, with street, storefront, windows, pavement and ambient light clearly visible",
      identityAndClothingGuard,
      "both arms and both hands must be visible away from the face, below chest level and preferably below waist level",
      "hands naturally down at the sides, holding a bag near the hip, resting on the lap, or resting on the tabletop far below the face",
      "do not raise either hand above the shoulder line",
      "no hand on cheek, no palm on cheek, no hand near mouth, no hands near face, no cropped torso-only composition, no face-filling selfie framing",
    ].join(", ");
  }
  if (/特写|特寫|近拍|近照|大頭|大头|头像|頭像|close[- ]?up|headshot/i.test(text)) {
    return [
      "composition guidance: close-up is allowed only because the post explicitly asks for it",
      "still keep enough shoulders or environment so it does not look like a cropped ID headshot",
      identityAndClothingGuard,
      "direct flash look is allowed only when the post explicitly asks for flash or selfie",
    ].join(", ");
  }
  if (/全身|全身照|穿搭|ootd|站著|站着|走路|full[- ]?body/i.test(text)) {
    return [
      "composition guidance: full-body or three-quarter outfit photo",
      "the persona must be visibly in frame with a recognizable face unless the post explicitly asks for no person",
      identityAndClothingGuard,
      "show clothing, posture, hands and surrounding environment clearly",
      "face should not dominate the frame",
    ].join(", ");
  }
  if (/半身|上半身|坐著|坐着|咖啡|餐廳|餐厅|機場|机场|飯店|酒店|房間|房间|外站|旅行|甜點|甜点|lifestyle|cafe/i.test(text)) {
    return [
      "composition guidance: medium shot or waist-up lifestyle photo",
      "camera at arm's length or a natural third-person candid angle",
      "the persona must be visibly in frame, face recognizable, not hidden, not turned away, not cropped out",
      identityAndClothingGuard,
      "include torso, hands, outfit details and enough background context",
      "face occupies roughly 20-35 percent of the image, not an extreme close-up",
      "use soft ambient available light, no direct flash, no harsh wall shadow",
    ].join(", ");
  }
  return [
    "composition guidance: default social feed image should be a medium shot, waist-up or three-quarter lifestyle composition",
    "the persona must be visibly in frame with a recognizable face, not hidden, not turned away, not cropped out",
    identityAndClothingGuard,
    "include torso, hands, outfit and surrounding environment",
    "use natural phone-camera distance, not face-filling selfie framing",
    "use soft ambient available light, no direct flash, no harsh wall shadow",
    "avoid extreme close-up, avoid headshot, avoid cropped forehead or chin",
    "face should occupy roughly 20-35 percent of the image while keeping identity recognizable",
  ].join(", ");
}

export async function generateReferenceSheet(
  imageAPI: any,
  setup: DramaSetup,
  personaContent: string,
  model: string,
  runtimeOptions?: PersonaImageRuntimeOptions,
): Promise<{ ok: boolean; url?: string; error?: string; timings?: unknown }> {
  if (!imageAPI?.generate) return { ok: false, error: "image API 不可用" };
  const prompt = buildReferenceSheetPrompt(setup, personaContent);

  // Workflow personas use the workflow for the reference sheet too.
  if (hasWorkflowImage(setup)) {
    const result = await imageAPI.generate({
      prompt,
      workflowImage: setup.imageWorkflow,
      aspectRatio: "1:1",
      timeoutMs: 300_000,
      configPath: runtimeOptions?.configPath,
      dataDir: runtimeOptions?.dataDir,
    });
    return { ok: !!result?.ok, url: result?.url, error: result?.error, timings: result?.timings };
  }

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
): Promise<{ ok: boolean; url?: string; mode: PersonaImageResolvedMode | "workflow"; error?: string; timings?: unknown }> {
  if (!imageAPI?.generate) return { ok: false, mode: "closed-scene", error: "image API 不可用" };

  const routeText = buildWorkflowRouteText(content, customPrompt);
  const route = resolvePersonaImageRoute(routeText, setup, requestedMode, referenceImageUrl, referenceSheetUrl);

  if (route.kind === "blocked-missing-reference") {
    return {
      ok: false,
      mode: "blocked-missing-reference",
      error: "这个非工作流人设还没有人设图，请先在人设设置里生成人设图。",
    };
  }

  if (route.kind === "workflow-person") {
    const workflowPrompt = [
      buildWorkflowPersonaPrompt(content, setup),
      customPrompt?.trim() ? "visual instruction priority: obey the following visual instruction over incidental post wording if they conflict" : "",
      customPrompt?.trim() || "",
    ].filter(Boolean).join(", ");
    const requestPayload = {
      prompt: workflowPrompt,
      workflowImage: setup.imageWorkflow,
      aspectRatio,
      timeoutMs: 300_000,
      configPath: runtimeOptions?.configPath,
      dataDir: runtimeOptions?.dataDir,
    };
    const result = await imageAPI.generate(requestPayload);
    if (result?.ok && result?.url) {
      return { ok: true, url: result.url, mode: "workflow", error: result.error, timings: result.timings };
    }

    if (isWorkflowBackendFailure(result?.error, result?.timings)) {
      const attempts: any[] = [{ provider: "comfyui-workflow", result }];
      if (setup.imageWorkflow?.workflowId && setup.imageWorkflow.executionProvider !== "runninghub") {
        const runningHubWorkflow = { ...setup.imageWorkflow, executionProvider: "runninghub" as const };
        const runningHubResult = await imageAPI.generate({
          ...requestPayload,
          workflowImage: runningHubWorkflow,
        });
        attempts.push({ provider: "runninghub-workflow", result: runningHubResult });
        if (runningHubResult?.ok && runningHubResult?.url) {
          return {
            ok: true,
            url: runningHubResult.url,
            mode: "workflow",
            error: runningHubResult.error,
            timings: { primary: result?.timings, fallback: runningHubResult.timings, fallbackProvider: "runninghub-workflow", attempts },
          };
        }
      }

      const standardFallbackPrompt = [
        workflowPrompt,
        "fallback from unavailable workflow backend; keep the same persona card cues and current post context as much as possible",
      ].filter(Boolean).join(", ");
      const standardFallback = await callClosedModel(
        imageAPI,
        standardFallbackPrompt,
        model,
        aspectRatio,
        undefined,
        undefined,
        runtimeOptions,
        { runningHubNewPersonaMode: "text-to-image" },
      );
      attempts.push({ provider: "runninghub-standard-model", result: standardFallback });
      if (standardFallback?.ok && standardFallback?.url) {
        return {
          ok: true,
          url: standardFallback.url,
          mode: "workflow",
          error: standardFallback.error,
          timings: { primary: result?.timings, fallback: standardFallback.timings, fallbackProvider: "runninghub-standard-model", attempts },
        };
      }

      return {
        ok: false,
        url: standardFallback?.url || result?.url,
        mode: "workflow",
        error: `工作流与兜底生图均不可用。原始错误：${result?.error || "unknown"}；兜底错误：${standardFallback?.error || "unknown"}`,
        timings: { primary: result?.timings, fallback: standardFallback?.timings, attempts },
      };
    }

    return { ok: false, url: result?.url, mode: "workflow", error: result?.error, timings: result?.timings };
  }

  const { prompt, mode, withAvatar } = buildPersonaImagePrompt(content, setup, requestedMode, referenceMode);
  const customCue = customPrompt?.trim();
  const finalPrompt = withAvatar
    ? [
        "The attached persona reference image is the identity anchor. Keep the same recognizable face: face shape, eyes, nose, mouth, age impression, hairline/hairstyle, skin tone, and overall temperament. Do not create a different person.",
        "Only the face identity must remain locked. Clothing, pose, scene, action, camera angle, lighting, and props should follow the current user/post visual request instead of copying the reference sheet outfit or background.",
        customCue ? `Highest priority current visual request: ${customCue}` : "",
        "If the base persona description conflicts with the current visual request, obey the current visual request for scene/outfit/action, while preserving the reference face identity.",
        prompt,
      ].filter(Boolean).join("\n")
    : [prompt, customCue || ""].filter(Boolean).join(", ");

  const avatarSource = withAvatar ? route.referenceUrl : undefined;
  const avatarBase64 = avatarSource ? avatarSource.replace(/^data:[^;]+;base64,/, "") : undefined;
  const avatarMimeType = avatarSource
    ? ((avatarSource.match(/^data:([^;]+);/) || [])[1] || "image/jpeg")
    : undefined;

  const result = await callClosedModel(imageAPI, finalPrompt, model, aspectRatio, avatarBase64, avatarMimeType, runtimeOptions, {
    runningHubNewPersonaMode: withAvatar ? "image-to-image" : undefined,
    avatarSource,
  });
  if (!result?.ok && hasWorkflowImage(setup) && ((result as any)?.retryable || /timeout|超時|超时|未返回|5\d\d|429|network|fetch failed/i.test(String(result?.error || "")))) {
    const fallbackPrompt = [
      buildWorkflowPersonaPrompt(content, setup),
      customPrompt?.trim() ? "visual instruction priority: obey the following visual instruction over incidental post wording if they conflict" : "",
      customPrompt?.trim() || "",
      "fallback from slow closed image model; keep this as a natural social post image for the persona",
    ].filter(Boolean).join(", ");
    const fallback = await imageAPI.generate({
      prompt: fallbackPrompt,
      workflowImage: setup.imageWorkflow,
      aspectRatio,
      timeoutMs: 300_000,
      configPath: runtimeOptions?.configPath,
      dataDir: runtimeOptions?.dataDir,
    });
    return {
      ok: !!fallback?.ok,
      url: fallback?.url,
      mode: "workflow",
      error: fallback?.error || result?.error,
      timings: {
        primary: (result as any)?.timings,
        fallback: fallback?.timings,
        fallbackReason: result?.error,
      },
    };
  }
  return { ok: !!result?.ok, url: result?.url, mode, error: result?.error, timings: (result as any)?.timings };
}
