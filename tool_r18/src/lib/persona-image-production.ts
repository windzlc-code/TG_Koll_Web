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
  { id: "gender", pattern: /女性|男性|女人|男人|女生|男生|woman|women|female|man|men|male/i },
  { id: "face", pattern: /脸|臉|五官|妆|妝|肤色|膚色|皮肤|皮膚|网红脸|網紅臉|面容|face|makeup|skin/i },
  { id: "body", pattern: /身材|胸|腰|臀|手|瘦|胖|高挑|矮|凹凸|爆乳|性感|诱惑|誘惑|身形|body|figure|hands?|slim|curvy/i },
  { id: "accessories", pattern: /眼镜|眼鏡|墨镜|墨鏡|耳环|耳環|项链|項鍊|手表|手錶|包|glasses|earring|necklace/i },
  { id: "age", pattern: /岁|歲|年龄|年齡|twenty|thirty|forty|\d+\s*year/i },
  { id: "background", pattern: /背景|办公室|辦公室|海边|海邊|室内|室內|场景|場景|background|office|beach/i },
  { id: "pose", pattern: /姿势|姿勢|坐着|站着|pose|sitting|standing/i },
  { id: "look", pattern: /风格|風格|气质|氣質|神态|神態|赛博|賽博|写实|寫實|动漫|動漫|电影|電影|氛围|氛圍|质感|質感|temperament|mood/i },
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
    if (!slots.length) return options?.mode !== "strip";
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
    appearance ? `mandatory appearance: ${appearance}` : "",
    "show every selected age, facial, hairstyle, temperament, clothing and body attribute clearly",
    `photorealistic adult ${gender}, soft even studio light`,
    "pure white seamless background, full-body standing pose, no text, no watermark, identical face, hair, body proportions and outfit in all three views",
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
        buildLifestyleCameraDirection(true, `${content}|${hint}`),
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
        buildLifestyleCameraDirection(false, `${content}|${hint}`),
        "photorealistic everyday lifestyle social photo, consistent same person, natural body language, no text, no watermark",
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

const PERSON_LIFESTYLE_CAMERA_SETUPS = [
  "slightly high-angle handheld selfie, torso placed diagonally, relaxed shoulders, gaze just beside the lens, irregular close crop",
  "close wide-angle phone selfie from slightly below eye level, one shoulder nearer the lens, asymmetric crop, casual hand position",
  "off-center mirror snapshot, body turned three-quarter, phone partly visible, relaxed weight shift, room depth visible behind the person",
  "side or three-quarter seated moment, upper body naturally leaning, gaze toward the surrounding activity rather than a formal camera pose",
  "waist-up or full-body phone snapshot caught mid-step, clothing and hair responding naturally to movement, environment extending around the person",
  "slightly low camera from a nearby seat or table height, relaxed bent posture, foreground object creating natural depth",
  "over-the-shoulder turning moment, face still recognizable, background activity readable, imperfect spontaneous timing",
  "top-down casual sitting or reclining moment, limbs placed naturally, frame rotated slightly instead of squared to the body",
  "close transit-stop selfie with part of the face near the crop edge, city traffic softly blurred behind, spontaneous waiting expression",
  "high-angle close wide-lens frame while the person leans toward the phone, full posture still readable, playful perspective distortion",
  "hands-behind-back forward lean, shoulders and head at slightly different angles, candid expression, street depth behind the person",
  "one-arm-extended outdoor selfie from above, body moving through the frame, strong daylight and irregular pavement shadows",
  "window-side seated back or side view followed by a small head turn, room and window depth carrying as much detail as the person",
  "casual standing frame with one hip or shoulder resting against a wall or railing, uneven weight distribution, gaze away from center",
  "mid-laugh shopping or errand moment, one hand carrying an everyday bag or object, body caught between steps instead of frozen",
  "direct but imperfect phone snapshot near a textured wall or public artwork, slight head tilt, loose arms, non-symmetrical framing",
  "close casual food or drink moment at a cafe table, one hand lifting a small snack or cup, face and ordinary table clutter both visible",
  "high overhead full-body phone angle from a step, landing, or standing companion, person looking up with relaxed uneven posture",
  "busy street-market snapshot with pedestrians and scooters close behind, person reacting with a hand near the cheek instead of posing alone",
  "casual class, rehearsal, or group-activity moment with other people naturally continuing the activity in the background",
  "diagonal arm-extended bed snapshot while sitting, reclining, or turning on rumpled bedding, relaxed limbs and an imperfect overhead crop",
  "casual bedroom outfit-check near a mirror or window, body turned to show how the clothes sit, phone reflection and room edges left naturally visible",
  "tight golden-hour coastal close-up with wind moving loose hair across the face, warm horizon blur and an intentionally imperfect edge crop",
  "outdoor exercise check-in caught mid-walk or mid-jog, one arm holding the phone and the other making a small natural gesture, mildly flushed rather than posed",
  "at-home hobby moment while actually holding or using a guitar, book, perfume, cosmetic, or other everyday object, hands engaged with the action rather than displaying a product",
  "window-side mood snapshot with a small pout, side glance, hand-on-hip, or folded-arm reaction, expression candid and body placement uneven",
];

const THIRD_PERSON_LIFESTYLE_CAMERA_SETUPS = [
  "off-center three-quarter environmental medium shot, person occupied with the moment rather than presenting to the camera",
  "side-profile candid shot with foreground depth, natural weight shift, gaze following the surrounding activity",
  "over-the-shoulder observation angle, face partly turned and recognizable, real background action kept readable",
  "slightly high-angle seated or leaning moment, asymmetric body placement, ordinary objects surrounding the person",
  "slightly low-angle full-body moment caught mid-step, natural movement in clothing and hair, street or room depth visible",
  "medium-long candid frame from several steps away, person interacting with the place instead of posing against it",
  "street-corner candid while carrying a small shopping bag, laugh or conversation caught between steps, storefront depth behind",
  "full-body waiting moment beside a railing, bus stop, or station edge, one leg relaxed, attention directed toward the street",
  "front three-quarter frame as the person leans slightly toward a companion or nearby phone, spontaneous expression and uneven crop",
  "back or side view seated near a window, bed, bench, or cafe table, with a small head turn that keeps identity recognizable",
  "bright outdoor snapshot with folded or loosely crossed arms, real midday shadows, residential or neighborhood details visible",
  "night street candid from the side as the person turns or laughs, practical shop lighting, signs and passing traffic softly out of focus",
  "close table-side candid while the person tastes a snack or lifts a drink, shot between bites with cafe details and foreground objects visible",
  "high overhead full-body frame from a stair, balcony, or standing companion, person glancing upward without flattening the environment",
  "crowded market-lane candid with people, scooters, stalls, and uneven daylight surrounding the person instead of a clean empty backdrop",
  "group class or rehearsal-room candid where the person remains the subject while classmates continue naturally in the deeper background",
  "bedroom candid from beside or above the bed while the person reclines, turns, or adjusts clothing, with rumpled bedding and furniture edges kept in frame",
  "natural outfit-check captured near a mirror or bright window, full or three-quarter body visible with the phone, reflection, and room depth treated as ordinary context",
  "coastal golden-hour portrait caught between poses, loose hair crossing the face and the horizon or promenade remaining softly readable",
  "home hobby candid while the person plays an instrument, reads, applies fragrance, or handles an everyday object without turning the moment into a product advertisement",
];

const LIFESTYLE_BACKGROUND_FALLBACKS = [
  "a lived-in bedroom corner with rumpled bedding, curtains, shelves, soft toys or ordinary personal items and window light",
  "a city sidewalk or transit waiting area with railing, curb, passing traffic, pavement texture and distant pedestrians",
  "a residential lane with garden edges, low walls, utility shadows, neighboring buildings and uneven afternoon sunlight",
  "a convenience-store, cafe or casual storefront edge with real shelves, signs, reflections and people moving in the distance",
  "a night-market or evening street with scooters, shop lights, small signs, mixed practical lighting and soft background motion",
  "a home mirror, vanity or window-side area with furniture edges, everyday clutter, fabric texture and natural room depth",
  "a public corridor, mural wall or textured building entrance with imperfect surfaces and ambient pedestrian context",
  "a bus, train or station-adjacent setting with seats, windows, handrails, route lighting and ordinary commuter detail",
  "a busy daytime market lane with produce stalls, scooters, awnings, shoppers and narrow pedestrian depth",
  "a casual restaurant or cafe table with cups, small plates, condiment jars, chairs and warm practical room light",
  "a dance, fitness, workshop or rehearsal room with mirrors, benches, equipment and other participants in soft background focus",
  "a neighborhood playground or small public park with railings, benches, paving, trees and families moving farther behind",
  "a breezy shoreline, riverside path or coastal promenade at golden hour with a soft horizon, railing and passing walkers",
  "a compact bedroom outfit-check area with a standing mirror, bright window, rumpled bedding, open shelves and ordinary clothing nearby",
];

function selectStableCameraSetup(key: string, candidates: string[]): string {
  let hash = 0;
  for (const character of key) hash = ((hash * 31) + character.codePointAt(0)!) >>> 0;
  return candidates[hash % candidates.length];
}

function buildLifestyleCameraDirection(thirdPerson: boolean, selectionKey: string): string {
  const candidates = thirdPerson ? THIRD_PERSON_LIFESTYLE_CAMERA_SETUPS : PERSON_LIFESTYLE_CAMERA_SETUPS;
  const selectedCameraSetup = selectStableCameraSetup(selectionKey, candidates);
  const selectedBackgroundFallback = selectStableCameraSetup(`${selectionKey}|background`, LIFESTYLE_BACKGROUND_FALLBACKS);
  return [
    "output one single candid social-media photo with one instance of the person, never a character sheet, multi-view layout, pose lineup, collage, or studio cutout",
    "if the persona reference is a three-view sheet, use it only to preserve face and identity; do not copy its straight standing pose, eye-level camera, white or neutral background, or side-by-side presentation",
    `use this specific camera and pose setup for this post: ${selectedCameraSetup}`,
    "do not default to a centered eye-level front-facing half-body pose; vary camera height, shot distance, body orientation, gaze direction, hand placement, weight shift, crop, and foreground depth across different posts and selected style hints",
    `when the post does not name a location, use this fallback lived-in setting: ${selectedBackgroundFallback}`,
    "if the post explicitly names a location, action, weather, time or event, it overrides any conflicting camera, pose, or fallback setting; keep the named action mandatory and adapt the selected setup around it, then enrich the real context with ordinary background detail, depth, small asymmetries, mild perspective distortion, and natural available light",
    "keep posture relaxed and physically plausible rather than symmetrical, mannequin-like, commercially posed, or excessively polished",
  ].join(", ");
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
