import type { DramaSetup } from "@/types/drama";

const MEME_PATTERN = /梗圖|表情包|搞笑|幽默|段子|沙雕|抽象|整活|樂子|meme|funny|reaction|shitpost/i;
// Only match Chinese girl/beauty terms — no English words to avoid false positives from AI-generated persona text
const GIRL_PATTERN = /福利|美女|大姐姐|知心大姐姐|溫柔姐姐|御姐|小姐姐|顏值|寫真|女神|自拍|性感|嫵媚|擦邊/i;
const PERSONA_PHOTO_PATTERN = /育兒媽媽|主婦|爸爸|夫妻|媽媽|創作者|達人|專家|老師|諮詢師|規劃師|情感|毒舌|阿姨|貴族|離婚|相親|穿搭|美妝|肌膚保養|減肥|健身|旅行|職場/i;
const POOL_NOISE_PATTERN = /avatar|profile|icon|emoji|logo|sprite|badge|thumb|thumbnail|small|banner|cover|poster/i;
const GIRL_POOL_NOISE_PATTERN = /illustration|anime|drawing|flower|floral|vase|decor|figurine|toy|landscape|scenery|wallpaper|couple|wedding/i;

const CHINESE_STOP_WORDS = new Set([
  "今天", "真的", "這個", "那個", "我們", "你們", "他們", "感覺", "自己", "已經",
  "就是", "不是", "還是", "一個", "一下", "因為", "所以", "然後", "如果", "但是",
  "還有", "直接", "一下子", "真的會", "完全", "終於", "一直", "而且", "不要",
]);

const MEME_HINTS: Array<{ pattern: RegExp; zh: string; en: string }> = [
  { pattern: /脫單|單身|戀愛|情侶|前任|相親|crush/i, zh: "單身狗 戀愛吐槽", en: "single meme relationship meme reaction" },
  { pattern: /上班|打工|老闆|加班|週一|職場/i, zh: "打工人 職場吐槽", en: "work meme office reaction" },
  { pattern: /窮|省錢|工資|打折|月光|消費|花錢/i, zh: "窮鬼 消費吐槽", en: "broke meme shopping meme" },
  { pattern: /尷尬|無語|崩潰|破防|社死|離譜/i, zh: "無語 破防 反應", en: "awkward meme facepalm reaction" },
];

const PERSONA_ROLE_HINTS: Array<{ pattern: RegExp; zh: string; en: string; noFace?: boolean; excludes?: string[]; pinterestQuery?: string; pinterestUrl?: string }> = [
  {
    pattern: /算命|占卜|塔羅|玄學|風水|星座|命理|運勢/i,
    zh: "塔羅牌 符咒 水晶球 蠟燭 神秘", en: "fortune teller tarot divination tarot cards talisman crystal ball candles incense mystic altar",
    noFace: true,
    excludes: ["-stock chart", "-candlestick", "-financial chart"],
    pinterestQuery: "護身符",
    pinterestUrl: "https://www.pinterest.com/search/pins/?q=%E8%AD%B7%E8%BA%AB%E7%AC%A6&rs=srs&b_id=BLwQXdYuX1fuAAAAAAAAAABhClo4uVYJSxw1fasmq5sEGSZz27D-OZDsS1RCNTKTkx9F39sYv6yrDGowGR02cCQ&source_id=114QWOG2",
  },
  { pattern: /情感|婚戀|相親|脫單|兩性/i, zh: "愛心 情書 玫瑰 溫暖", en: "heart letter rose warm abstract love" },
  { pattern: /美妝|肌膚保養|穿搭|時尚/i, zh: "化妝品 肌膚保養品 口紅 瓶罐", en: "cosmetics lipstick skincare products flatlay bottles" },
  { pattern: /健身|減肥|營養|運動/i, zh: "啞鈴 跑鞋 蛋白粉 器材", en: "dumbbell running shoes protein gym equipment flatlay", noFace: true },
  { pattern: /理財|財經|股票|基金|投資|副業|省錢/i, zh: "股票走勢 K線圖 鈔票 金幣 存錢罐 計算器", en: "stock chart candlestick money bills coins calculator piggy bank financial newspaper", noFace: true },
  { pattern: /育兒媽媽|育兒|親子|孩子|母嬰/i, zh: "嬰兒用品 奶瓶 玩具 童書", en: "baby bottle toys children books nursery flatlay" },
  { pattern: /旅行|旅遊|出行|景點/i, zh: "風景 地標 護照 行李箱", en: "scenery landmark passport suitcase landscape", noFace: true },
  { pattern: /美食|烹飪|食譜|廚房/i, zh: "菜品 食材 餐盤 廚具", en: "food dish ingredients plate kitchen flatlay", noFace: true },
  { pattern: /職場|工作|辦公|創業/i, zh: "膝上型電腦 咖啡 辦公桌 文具", en: "laptop coffee desk stationery workspace flatlay", noFace: true },
  { pattern: /讀書|學習|知識|教育/i, zh: "書籍 筆記本 咖啡 書架", en: "books notebook coffee bookshelf study flatlay", noFace: true },
  { pattern: /寵物|貓|狗|養寵/i, zh: "貓咪 狗狗 寵物用品", en: "cat dog pet animal cute" },
];

const SOCIAL_PHOTO_SCENE_HINTS: Array<{ pattern: RegExp; scene: string }> = [
  { pattern: /捷運月台|地鐵月台|月台|站台|車站月台|地鐵站|捷運站/i, scene: "train platform or station background, rush-hour commute snapshot, spontaneous real-life social post" },
  { pattern: /下雨|大雨|暴雨|梅雨|淋雨|雨傘|濕答答|通勤/i, scene: "rainy day street or convenience store entrance, commuter mood, slightly damp hair, candid real-life moment" },
  { pattern: /超商|全家|便利商店|7-11|711/i, scene: "convenience store aisle or storefront, handheld smartphone photo, everyday shopping moment" },
  { pattern: /咖啡|奶茶|早餐|午餐|晚餐|外送|便當/i, scene: "food pickup or cafe corner, casual handheld social post photo, lived-in daily environment" },
  { pattern: /灑到|潑到|打翻|翻倒|弄濕|濕掉|濕透|胸前濕|衣服濕|spilled|spill|wet clothes/i, scene: "accidental drink spill on ordinary opaque clothing, visibly damp only where the drink actually spilled, embarrassed candid smartphone photo, caught in the exact messy moment" },
  { pattern: /公司|辦公室|加班|會議|午休|等外送|辦公桌/i, scene: "office desk or lobby, waiting-between-tasks candid moment, natural indoor lighting" },
  { pattern: /保養|精華|化妝水|面膜|乳液|素顏|妝|底妝|皮膚|亮到/i, scene: "close-up lifestyle beauty photo, after-skincare natural glow, mirror-side or window-light candid shot" },
  { pattern: /咖啡|奶茶|早餐|午餐|晚餐|外送|便當/i, scene: "food pickup or cafe corner, casual handheld social post photo, lived-in daily environment" },
  { pattern: /捷運|地鐵|公車|計程車|騎車|開車/i, scene: "commute transition moment, city sidewalk or station entrance, quick candid smartphone capture" },
  { pattern: /家裡|房間|臥室|化妝台|浴室|洗手台/i, scene: "home vanity or bedroom corner, intimate everyday selfie-style composition, natural personal space" },
];

const SOCIAL_PROMPT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/NT\$?\s*\d+(?:\.\d+)?/gi, ""],
  [/全家|7-11|711|便利商店/gi, "convenience store"],
  [/這色超仙|欠買|必買|回購|爆款|團購|貴婦光|發光肌/gi, ""],
  [/專櫃精華|精華液|保濕精華|化妝水|乳液/gi, "skincare product"],
  [/素顏皮膚|素顏肌|亮到像白帶濾鏡|白一階/gi, "fresh natural skin glow"],
];

const SOCIAL_PHOTO_NEGATIVE_TOKENS = [
  "not a livestream",
  "not an interview",
  "not a press conference",
  "not a trade show booth",
  "not a retail product launch",
  "no sponsor wall",
  "no microphone",
  "no billboard",
  "no poster backdrop",
  "no standee",
  "no event badge",
  "no stage lighting",
  "no host pose",
  "no ad label",
  "no on-screen graphics",
  "no text",
  "no watermark",
];

const GIRL_PROMPT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/知心大姐姐|溫柔姐姐|大姐姐|御姐|小姐姐/gi, "adult woman"],
  [/福利|擦邊/gi, "private lifestyle editorial"],
  [/性感|sexy|sensual|seductive|provocative/gi, "confident alluring"],
  [/嫵媚|glamour model/gi, "glamorous poised"],
  [/寫真|boudoir|lingerie/gi, "portrait photography"],
  [/美女|beauty girl/gi, "adult woman"],
  [/露胸|深v|低胸|爆乳|露腿|黑絲|白絲|絲襪/gi, "summer styling"],
  [/浴袍|浴巾|毛巾包頭|剛洗完澡|洗完澡|出浴/gi, "bathrobe towel-hair lifestyle"],
  [/臥室|床邊|酒店|酒店房間|落地窗|梳妝檯|鏡前|晨光|居家/gi, "bedroom vanity lifestyle"],
  [/裸|nude|naked|explicit|nsfw|erotic/gi, "natural editorial"],
];

export interface PersonaImageSignals {
  personaKeywords: string;
  personaStyle: string;
  appearanceHint: string;
  isMemeType: boolean;
  isGirlType: boolean;
  isPersonaType: boolean;
}

function sanitizeSocialPromptText(text: string): string {
  if (!text) return "";
  let normalized = text;
  for (const [pattern, replacement] of SOCIAL_PROMPT_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized
    .replace(/[✨💖💅😂🤣😍🥹😭🙃🤍🫶]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .trim();
}

function extractCoreTerms(content: string): string[] {
  const normalized = content
    .replace(/《[^》]{1,30}》/g, "")
    .replace(/「[^」]{1,30}」/g, "")
    .replace(/【[^】]{1,30}】/g, "")
    .replace(/["""][^"""]{1,60}["""]/g, "")
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9 ]/g, " ");

  return (normalized.match(/[\u4e00-\u9fa5]{2,6}|[a-zA-Z0-9]{2,20}/g) || [])
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !CHINESE_STOP_WORDS.has(word))
    .slice(0, 6);
}

export function getPersonaImageSignals(setup: DramaSetup, extraText = ""): PersonaImageSignals {
  const personaKeywords = (setup.genres || []).join(" ");
  const personaStyle = setup.personaPersonality
    ? `${setup.personaPersonality} ${setup.personaGender || ""}`.trim()
    : "";
  const appearanceHint = setup.personaAppearance || "";
  const combined = [
    personaKeywords,
    personaStyle,
    setup.personaDescription || "",
    setup.contentTheme || "",
    appearanceHint,
    extraText,
  ].join(" ");

  const explicitMemeType = !!(setup as any).isMemePersona;
  const explicitGirlType = !!(setup as any).isGirlPersona;

  const isGirlType = explicitGirlType || GIRL_PATTERN.test(combined);
  const isMemeType = explicitMemeType || (!isGirlType && MEME_PATTERN.test(combined));
  const isPersonaType = isGirlType || PERSONA_PHOTO_PATTERN.test(combined);

  return {
    personaKeywords,
    personaStyle,
    appearanceHint,
    isMemeType,
    isGirlType,
    isPersonaType,
  };
}

export function buildPersonaImageQuery(content: string, signals: PersonaImageSignals): { query: string; pinterestQuery?: string; pinterestUrl?: string } {
  const coreTerms = extractCoreTerms(content);
  const base = coreTerms.join(" ") || signals.personaKeywords || "lifestyle";
  const roleHint = PERSONA_ROLE_HINTS.find((item) => item.pattern.test(`${content} ${signals.personaKeywords} ${signals.personaStyle}`));

  if (signals.isMemeType) {
    const hint = MEME_HINTS.find((item) => item.pattern.test(content));
    return {
      query: [
        hint?.zh, base, hint?.en,
        "梗圖", "表情包", "搞笑", "meme", "reaction image", "funny meme",
        "-anime", "-illustration", "-drawing", "-wedding", "-flower", "-decor",
      ].filter(Boolean).join(" ").slice(0, 180),
    };
  }

  if (signals.isGirlType) {
    const anchor = signals.appearanceHint || "adult woman portrait";
    return {
      query: [
        anchor, base,
        "adult woman portrait photo", "beauty lifestyle",
        "bathrobe hotel lifestyle", "towel hair vanity mirror",
        "bikini swimwear editorial", "beach resort photography",
        "poolside magazine", "morning bedroom window light",
        "real person", "portrait photography",
        "-anime", "-illustration", "-drawing", "-couple", "-wedding", "-flower", "-decor", "-toy", "-figurine",
      ].filter(Boolean).join(" ").slice(0, 220),
    };
  }

  // Normal persona: use role-specific hints, exclude faces for object-focused roles
  const contentQuery = [
    roleHint?.zh,
    roleHint?.en,
    base,
  ].filter(Boolean).join(" ");

  const excludes = [
    "-ad", "-banner", "-logo", "-poster", "-avatar",
    ...(roleHint?.excludes || []),
  ];
  // For roles that should show objects/scenes, not people
  if (roleHint?.noFace) {
    excludes.push(
      "-portrait", "-headshot", "-selfie",
      "-person", "-people", "-woman", "-man", "-face",
      "-businessman", "-businesswoman", "-professional photo",
    );
  }

  return {
    query: [contentQuery, ...excludes].filter(Boolean).join(" ").slice(0, 220),
    pinterestQuery: roleHint?.pinterestQuery,
    pinterestUrl: roleHint?.pinterestUrl,
  };
}

export function buildPersonaSocialImagePrompt(
  content: string,
  setup: DramaSetup,
  signals: PersonaImageSignals,
): string {
  const allSceneHints = SOCIAL_PHOTO_SCENE_HINTS
    .filter((item) => item.pattern.test(`${content} ${setup.contentTheme || ""}`))
    .map((item) => item.scene);
  const uniqueSceneHints = [...new Set(allSceneHints)];
  const locationHints = uniqueSceneHints.filter((scene) => /station|platform|storefront|convenience store|bedroom|vanity|office|desk/i.test(scene));
  const eventHints = uniqueSceneHints.filter((scene) => !locationHints.includes(scene));
  const rawSceneHints = [...locationHints.slice(0, 1), ...eventHints.slice(0, 2)];
  const sceneHints = rawSceneHints.length > 0
    ? rawSceneHints.slice(0, 3)
    : ["candid smartphone social media photo, everyday life moment, natural body language, authentic daily environment"];

  const appearance = sanitizeSocialPromptText(
    setup.personaAppearance || signals.appearanceHint || signals.personaStyle || signals.personaKeywords || "real person lifestyle portrait",
  );
  const cleanedContent = sanitizeSocialPromptText(content)
    .replace(/[“”"']/g, "")
    .slice(0, 180);
  const theme = sanitizeSocialPromptText(setup.contentTheme || signals.personaKeywords || "");
  const visualIdentityCue = buildPersonaVisualIdentityCue(setup, signals, content);

  return [
    appearance,
    visualIdentityCue,
    ...sceneHints,
    cleanedContent,
    theme ? `subtle theme cues: ${theme}` : "",
    "the image must make the persona type, core field, personality, and recurring visual world recognizable at first glance; avoid a generic portrait, generic selfie, generic street photo, or interchangeable influencer image",
    "personal social media post photo, candid iPhone-style capture, realistic skin texture, natural lighting, non-commercial everyday scene, imperfect timing, unpolished framing, looks like a real post someone uploaded seconds after the incident",
    SOCIAL_PHOTO_NEGATIVE_TOKENS.join(", "),
  ].filter(Boolean).join(", ");
}

export function buildPersonaVisualIdentityCue(
  setup: DramaSetup,
  signals?: PersonaImageSignals,
  currentContent?: string,
): string {
  const resolvedSignals = signals || getPersonaImageSignals(setup, currentContent);
  const identityType = sanitizeSocialPromptText([
    setup.personaName || "",
    (setup.genres || []).join(" "),
    setup.contentTheme || "",
    resolvedSignals.personaKeywords || "",
  ].filter(Boolean).join(" ")).slice(0, 180);
  const coreSetting = sanitizeSocialPromptText([
    setup.personaDescription || "",
    setup.personaAppearance || resolvedSignals.appearanceHint || "",
  ].filter(Boolean).join(" ")).slice(0, 280);
  const personality = sanitizeSocialPromptText([
    setup.personaPersonality || "",
    setup.personaStyle || "",
  ].filter(Boolean).join(" ")).slice(0, 180);
  const visualAnchors = sanitizeSocialPromptText([
    (setup.trendTopics || []).join(" "),
  ].filter(Boolean).join(" ")).slice(0, 180);
  const stylingCore = sanitizeSocialPromptText([
    identityType,
    coreSetting,
    personality,
    visualAnchors,
  ].filter(Boolean).join(" ")).slice(0, 520);

  return [
    "persona visual identity cue:",
    identityType ? `type and field: ${identityType}` : "",
    coreSetting ? `core character and visual world: ${coreSetting}` : "",
    personality ? `personality shown through posture, expression, props, scene choice, and camera distance: ${personality}` : "",
    visualAnchors ? `recurring visual anchors: ${visualAnchors}` : "",
    stylingCore ? `derive a signature wardrobe and styling system from this persona, not a generic outfit: ${stylingCore}` : "",
    "visible differentiation requirements: design role-specific clothing silhouette, layering, fabric texture, color palette, grooming, hair or makeup logic, accessories, hand-held objects, background objects, and camera distance so the persona is identifiable without reading text",
    "if another persona wore the same basic clothing item, this persona must still look different through fit, layering, accessories, grooming, posture, facial expression, props, environment, and color mood",
    "translate the persona card into visible details: clothing logic, props, workspace or living environment, color mood, body language, and social-media composition must all fit this specific persona",
  ].filter(Boolean).join("; ");
}

export function sanitizeGirlPromptText(text: string): string {
  if (!text) return "";
  let normalized = text;
  for (const [pattern, replacement] of GIRL_PROMPT_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
}

const GIRL_SCENE_PRESETS = [
  "luxury hotel room, white bathrobe, towel-wrapped hair, vanity mirror, morning window light, soft bokeh",
  "poolside lounge chair, cover-up sarong, sunglasses, tropical resort, golden hour",
  "bedroom editorial, silk sheets, morning light through sheer curtains, relaxed candid pose",
  "spa day, fluffy robe, candles, serene expression, soft warm lighting",
  "beach at sunset, flowing sundress, barefoot in sand, warm golden light",
  "rooftop terrace, city lights at night, elegant look, confident gaze",
  "hotel bathroom mirror, fresh out of shower, wrapped in towel, natural glow, steam",
  "balcony morning, oversized shirt, messy hair, coffee cup, candid lifestyle",
];

const GIRL_EVENT_DETAIL_HINTS: Array<{ pattern: RegExp; detail: string }> = [
  {
    pattern: /灑到|潑到|打翻|翻倒|弄濕|濕掉|濕透|胸前濕|衣服濕|spilled|spill|wet clothes/i,
    detail: "accidental drink spill on a normal everyday opaque top, damp marks only where the liquid actually hit, off-center phone snapshot composition, flushed embarrassed half-laugh, immediate post-accident reaction, non-explicit adult styling",
  },
  {
    pattern: /捷運月台|地鐵月台|月台|站台|車站月台|地鐵站|捷運站|捷運|地鐵/i,
    detail: "Taipei metro platform or station entrance context, candid commuter snapshot, no studio pose, no polished influencer framing",
  },
  {
    pattern: /下雨|大雨|暴雨|梅雨|淋雨|雨傘|濕答答/i,
    detail: "slightly messy hair, damp shoulders, awkward real-life timing, looks like a rushed phone photo instead of a planned shoot",
  },
];

export function hasConcreteSocialEvent(content: string): boolean {
  return /下雨|大雨|暴雨|梅雨|淋雨|雨傘|濕答答|通勤|超商|全家|便利商店|7-11|711|飲料|手搖|奶茶|咖啡|果汁|可樂|汽水|冰飲|熱飲|灑到|潑到|打翻|翻倒|弄濕|濕掉|濕透|胸前濕|衣服濕|捷運|地鐵|月台|站台|車站|公車|計程車|公司|辦公室|加班|午休|等外送|家裡|房間|臥室|化妝台|浴室|洗手台/i.test(content);
}

const POV_LIFESTYLE_IMAGE_PATTERN = /咖啡店|咖啡廳|咖啡馆|咖啡館|咖啡|拿鐵|拿铁|美式|甜點|蛋糕|餐廳|餐厅|等待|等人|等餐|發呆|放空|心情|窗邊|窗边|桌面|桌上|杯子|咖啡杯|手握|握著|握着|手拿|拿著杯|拿着杯|first person|pov/i;
const EXPLICIT_POV_IMAGE_PATTERN = /第一人稱|第一人称|主觀視角|主观视角|從我的視角|从我的视角|我的視角|我的视角|手持視角|手持视角|視角照|视角照|手拿|手握|握著|握着|拿著杯|拿着杯|只露手|只露出手|first person|pov/i;
const PERSON_FOCUSED_IMAGE_PATTERN = /自拍|合照|人像|本人|臉|表情|笑|哭|尷尬|害羞|生氣|累|崩潰|穿搭|衣服|裙|褲|制服|外套|上衣|領口|肩|鎖骨|胸|腰|腿|身材|妝|頭髮|髮型|拉著|站著|坐著|走路|出門|回家|上班|下班|空服|機組|乘客|她|他|女生|女孩|女人|小姐姐|姐姐|adult woman|woman|girl|selfie|portrait|outfit|body|face|expression/i;
const SCENERY_OR_OBJECT_IMAGE_PATTERN = /風景|景色|天空|雲|夕陽|夜景|街景|海邊|山|雨景|窗外|機場|飛機|跑道|飯店|餐廳|咖啡廳|甜點|蛋糕|飲料|食物|餐點|便當|包包|行李箱|票|車票|房間角落|桌面|路牌|招牌|空鏡|街頭|城市|landscape|scenery|street|sky|sunset|food|dessert|coffee|object/i;
const EXPLICIT_NO_PERSON_IMAGE_PATTERN = /不出現人物|不要出現人物|不出现人物|不要出现人物|不出現人|不要出現人|不出现人|不要出现人|不要有人|沒有人|没有人|無人|无人|不要有人臉|不要有人脸|不要人臉|不要人脸|不要臉|不要脸|不要手|不露手|(?:^|[，。,；;、\s])(只拍|只拍攝|只拍摄)|空鏡|空镜|no person|no people|no face|no body|no hands|scene only|object only/i;
const PARTIAL_HAND_POV_IMAGE_PATTERN = /自己[^，。,；;]*?(手|握|拿)|手[^，。,；;]*?(杯|咖啡|拿鐵|拿铁|美式|書|书|筆|笔|手機|手机)|握著杯子的手|握着杯子的手|只露手|只露出手|partial hands|hand holding/i;
const MEDIUM_LONG_SCENE_IMAGE_PATTERN = /中遠景|中远景|遠景|远景|風景|风景|景色|街景|街頭|街头|街道|城市|店面|店門口|店门口|招牌|路燈|路灯|天空|路面|窗戶|窗户|landscape|scenery|street|city|storefront|medium[- ]?long|wide shot/i;

export type PersonaImageSubject = "person" | "pov" | "scene";

function isStrictNoPersonImageRequest(content: string): boolean {
  if (!EXPLICIT_NO_PERSON_IMAGE_PATTERN.test(content)) return false;
  if (/不要手|不露手|no hands/i.test(content)) return true;
  return !PARTIAL_HAND_POV_IMAGE_PATTERN.test(content);
}

export function classifyPersonaImageSubject(content: string, setup?: DramaSetup): PersonaImageSubject {
  if (isStrictNoPersonImageRequest(content)) return "scene";
  const hasPersonFocus = PERSON_FOCUSED_IMAGE_PATTERN.test(content);
  const hasPovLifestyle = POV_LIFESTYLE_IMAGE_PATTERN.test(content) && EXPLICIT_POV_IMAGE_PATTERN.test(content);
  const hasSceneryOrObject = SCENERY_OR_OBJECT_IMAGE_PATTERN.test(content);
  if (hasPersonFocus) return "person";
  if (hasPovLifestyle) return "pov";
  if (hasSceneryOrObject) return "scene";

  const fallbackText = [setup?.contentTheme || "", setup?.personaDescription || ""].join(" ");
  if (PERSON_FOCUSED_IMAGE_PATTERN.test(fallbackText)) return "person";
  return "person";
}

export function shouldUseWorkflowPersonaImage(content: string, setup?: DramaSetup): boolean {
  void content;
  void setup;
  return false;
}

function buildPovHandPersonaHint(setup: DramaSetup, signals: PersonaImageSignals): string {
  const cues = [
    setup.personaGender ? `gender: ${setup.personaGender}` : "",
    setup.personaNationality ? `region or ethnicity cue: ${setup.personaNationality}` : "",
    setup.personaPersonality ? `personality cue: ${setup.personaPersonality}` : "",
    setup.personaStyle ? `style cue: ${setup.personaStyle}` : "",
    setup.personaAppearance || signals.appearanceHint ? `appearance cue: ${setup.personaAppearance || signals.appearanceHint}` : "",
  ].filter(Boolean).join("; ");
  return cues
    ? `if hands or forearms are visible, they must match the persona identity cues (${cues}), natural skin texture, correct gender presentation and age impression, no mismatched hand model`
    : "if hands or forearms are visible, keep them natural and consistent with the persona gender and age impression";
}

export function buildSceneOnlyImagePrompt(content: string, setup: DramaSetup, signals: PersonaImageSignals): string {
  const cleanedContent = sanitizeSocialPromptText(content).replace(/[“”"']/g, "").slice(0, 220);
  const theme = sanitizeSocialPromptText(setup.contentTheme || signals.personaKeywords || "");
  const explicitNoPerson = isStrictNoPersonImageRequest(content);
  const explicitMediumLongScene = explicitNoPerson && MEDIUM_LONG_SCENE_IMAGE_PATTERN.test(content);
  const explicitNoPersonContent = explicitNoPerson
    ? cleanedContent
      .replace(/她|他|本人|人物|人像|自拍|穿搭|臉|脸|手|身材|胸|腰|腿|女人|女生|小姐姐|adult woman|woman|girl|selfie|portrait|body|face/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
    : cleanedContent;
  const sceneHints = SOCIAL_PHOTO_SCENE_HINTS
    .filter((item) => item.pattern.test(`${content} ${setup.contentTheme || ""}`))
    .map((item) => item.scene)
    .slice(0, 3);
  const explicitNoPersonHints = explicitNoPerson
    ? explicitMediumLongScene
      ? [
        "medium-long distance environment-only landscape photo",
        "wide street or city scene with storefronts, windows, pavement, sky, street lights and natural ambient light",
        "camera positioned several meters away from the main street view, not a tabletop close-up, not first-person POV",
        "no coffee cup foreground, no phone foreground, no book foreground, no tabletop object close-up",
      ]
      : [
        "object-focused tabletop lifestyle photo",
        "coffee cup, notebook or book, table texture, and window-side natural light",
        "no phone in the frame unless explicitly requested; if any screen exists it must be blank and show no face or body",
        "realistic phone snapshot of objects only",
      ]
    : [];
  return [
    ...(explicitNoPerson ? explicitNoPersonHints : sceneHints),
    explicitNoPerson ? explicitNoPersonContent : cleanedContent,
    (!explicitNoPerson && theme) ? `subtle theme cues only for color and setting, not a person: ${theme}` : "",
    (POV_LIFESTYLE_IMAGE_PATTERN.test(content) && !explicitNoPerson)
      ? `first-person POV lifestyle photo, no face visible, no full person, only partial hands are allowed, no body beyond partial hands or forearms, ${buildPovHandPersonaHint(setup, signals)}, one hand holding a coffee cup or resting near the cup if relevant, cafe table, window-side atmosphere, mood-focused composition, intimate everyday phone snapshot`
      : explicitNoPerson
        ? explicitMediumLongScene
          ? "strict no-person medium-long landscape photo, absolutely no humans in frame, no pedestrians, no human silhouettes, no face, no head, no body, no hands, no reflection of a person, no person shown on a phone screen, no close-up foreground object, focus on the wider environment and street scenery, realistic everyday city landscape composition"
          : "strict scene-only social media photo, absolutely no humans in frame, no person, no people, no selfie, no portrait, no face, no head, no body, no hands, no fingers, no reflection, no shadow of a person, no person shown on a phone screen, no face on any screen, no printed portrait photo, focus only on objects and environment mentioned in the post, candid phone snapshot, natural available light, realistic everyday composition"
        : "scene-only social media photo, no person visible, no selfie, no portrait, no face, no body, no model posing, focus on the place or object described in the post, candid phone snapshot, natural available light, realistic everyday composition",
    "no text, no watermark",
  ].filter(Boolean).join(", ");
}

export function buildGirlPersonaImagePrompt(content: string, setup: DramaSetup, signals: PersonaImageSignals): string {
  const appearance = sanitizeGirlPromptText(
    setup.personaAppearance || signals.appearanceHint || signals.personaKeywords || signals.personaStyle || "adult woman",
  );
  const socialPrompt = sanitizeGirlPromptText(buildPersonaSocialImagePrompt(content, setup, signals));
  const trimmedSocialPrompt = socialPrompt.startsWith(`${appearance},`)
    ? socialPrompt.slice(appearance.length + 1).trimStart()
    : socialPrompt;
  const socialPromptWithoutRepeatedAppearance = appearance
    ? trimmedSocialPrompt
      .split(appearance)
      .map((part) => part.replace(/^[,;:\s]+|[,;:\s]+$/g, ""))
      .filter(Boolean)
      .join(", ")
    : trimmedSocialPrompt;
  const eventDetails = GIRL_EVENT_DETAIL_HINTS
    .filter((item) => item.pattern.test(`${content} ${setup.contentTheme || ""}`))
    .map((item) => item.detail);
  const uniqueEventDetails = [...new Set(eventDetails)].slice(0, 3);
  const fallbackScene = hasConcreteSocialEvent(content)
    ? ""
    : GIRL_SCENE_PRESETS[Math.floor(Math.random() * GIRL_SCENE_PRESETS.length)];

  return [
    appearance,
    ...uniqueEventDetails,
    socialPromptWithoutRepeatedAppearance,
    fallbackScene,
    hasConcreteSocialEvent(content)
      ? "photorealistic candid smartphone social photo, event-first storytelling, keep the image grounded in the exact situation described by the post, visible post-accident or post-event messiness when relevant, natural imperfect composition like a real tweet photo, playful embarrassed reaction only if the content supports it, realistic body language, natural available light, non-explicit, no text, no watermark, consistent appearance, same person"
      : "photorealistic candid smartphone lifestyle photo, natural everyday attractiveness, soft feminine charm, realistic body language, casual unforced posing, lifestyle mood over sexual posing, subtle social-media appeal without exaggerated body emphasis, natural available light, no text, no watermark, consistent appearance, same person",
  ].filter(Boolean).join(", ");
}

export function sanitizeImportedImagePool(urls: string[], mode: "meme" | "girl"): string[] {
  const uniq = [...new Set(urls.filter(Boolean))];
  return uniq.filter((url) => {
    if (POOL_NOISE_PATTERN.test(url)) return false;
    if (mode === "girl" && GIRL_POOL_NOISE_PATTERN.test(url)) return false;
    return true;
  });
}
