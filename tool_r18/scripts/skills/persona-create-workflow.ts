import "@/runtime/node/browser-shim";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installNodePersonaArchiveBridge } from "@/runtime/node/persona-archive-store";
import { readRuntimeApiConfig } from "@/runtime/node/config";
import { runPersonaWorkflow } from "@/core/persona/persona-workflow-service";
import { buildWarmupInterestKeywords } from "@/lib/mobile-publisher";
import { callTextUnderstandingModelWithFallback, extractText, isTextModelFallbackError } from "@/lib/gemini-client";
import type { DramaSetup } from "@/types/drama";

installNodePersonaArchiveBridge();

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CODEX_BOT_TIMEOUT_MS = Number(process.env.CODEX_BOT_TIMEOUT_MS || 300_000);
const CREATE_PERSONA_KEYWORD_COUNT = 5;
const CREATE_PERSONA_MAX_SELECTED_KEYWORDS = 2;

type Input =
  | { action: "suggest-keywords"; personaName: string; userPrompt: string }
  | { action: "derive-profile"; personaName: string; userPrompt: string; selectedKeywords?: string[] }
  | { action: "create-from-prompt"; personaName: string; userPrompt: string; selectedKeywords?: string[] };

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function normalizeSingleLine(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeErrorForLog(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compactLongAiInput(value: string, maxLength = 9000): string {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  const headLength = 6500;
  const tailLength = 2000;
  const omitted = Math.max(0, text.length - headLength - tailLength);
  return [
    text.slice(0, headLength),
    "",
    `[中间 ${omitted} 字已省略，保留首尾关键信息用于提炼]`,
    "",
    text.slice(-tailLength),
  ].join("\n");
}

function pickString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function pickStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean)
    .slice(0, 3);
  return items.length ? items : fallback;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizePersonaInterestTags(value: unknown, fallback: string[] = []): string[] {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of [...source, ...fallback]) {
    const tag = normalizeSingleLine(String(item || ""))
      .replace(/^#/, "")
      .replace(/[，。；;\s]+$/g, "")
      .slice(0, 12);
    if (tag.length < 2) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= 8) break;
  }
  return result;
}

function derivePersonaInterestTags(setup: Partial<DramaSetup> | undefined, content = ""): string[] {
  const persona = {
    name: setup?.personaName,
    description: [setup?.personaDescription, setup?.contentTheme, setup?.customTopic, content].filter(Boolean).join(" "),
    style: setup?.personaStyle,
    personality: setup?.personaPersonality,
    interests: normalizePersonaInterestTags(setup?.interests),
  };
  const candidates = [
    ...(setup?.genres || []),
    ...normalizePersonaInterestTags(setup?.interests),
    ...buildWarmupInterestKeywords(persona),
  ];
  return normalizePersonaInterestTags(candidates).slice(0, 8);
}

function extractJsonObject(raw: string): any {
  const text = (raw || "").trim();
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const ch = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, index + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("未找到可解析的 JSON 输出");
}

function createTempPromptFile(content: string): string {
  const filePath = path.join(os.tmpdir(), `codex-bot-prompt-${Date.now()}.txt`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function removeTempFile(filePath: string) {
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

function getCodexOutputPath(): string {
  return path.join(os.tmpdir(), `codex-bot-out-${Date.now()}.txt`);
}

function getCodexExecutable(): string {
  const configured = process.env.CODEX_CLI_PATH?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    const candidates = [
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "codex.cmd") : "",
      path.join(os.homedir(), "AppData", "Roaming", "npm", "codex.cmd"),
      path.join(PROJECT_ROOT, "node_modules", ".bin", "codex.cmd"),
    ].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) return found;
  }
  return "codex";
}

function codexConfigHasProfile(profileName: string): boolean {
  const escaped = profileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\[profiles\\.(?:\"${escaped}\"|'${escaped}'|${escaped})\\]`);
  const candidates = [
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "config.toml") : "",
    path.join(os.homedir(), ".codex", "config.toml"),
  ].filter(Boolean);
  return candidates.some((filePath) => {
    try {
      return pattern.test(fs.readFileSync(filePath, "utf8"));
    } catch {
      return false;
    }
  });
}

function resolveCodexConfigProfile(env: NodeJS.ProcessEnv): string {
  const explicit = String(env.CODEX_CONFIG_PROFILE || process.env.CODEX_CONFIG_PROFILE || "").trim();
  if (explicit) return explicit;
  if (String(env.MINIMAX_API_KEY || process.env.MINIMAX_API_KEY || "").trim() && codexConfigHasProfile("m27")) {
    return "m27";
  }
  return "";
}

function runCodexDirect(promptFile: string, outputFile: string, env: NodeJS.ProcessEnv): Promise<string> {
  const executable = getCodexExecutable();
  const stdin = fs.readFileSync(promptFile, "utf-8");
  const childEnv = { ...process.env, ...env };
  const args = ["exec", "--skip-git-repo-check", "-s", "read-only", "-o", outputFile, "-"];
  const profile = resolveCodexConfigProfile(childEnv);
  if (profile) {
    args.splice(2, 0, "-p", profile);
  } else {
    const botModel = String(childEnv.CODEX_BOT_MODEL || process.env.CODEX_BOT_MODEL || "gpt-5.4-mini").trim();
    if (botModel) args.splice(2, 0, "-m", botModel);
    args.splice(2, 0, "-c", 'service_tier="fast"');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: PROJECT_ROOT,
      timeout: CODEX_BOT_TIMEOUT_MS,
      env: childEnv,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdin.write(stdin);
    child.stdin.end();
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      try {
        const out = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf-8") : stdout;
        if (code && code !== 0 && !out.trim()) {
          reject(new Error(stderr || stdout || `codex exited with code ${code}`));
          return;
        }
        const normalized = out
          .replace(/\bin D:\\GitHub\\Automatic-script exited \d+ in \d+ms:[\s\S]*?(?=\n\nexec\n|$)/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        resolve(normalized || out);
      } catch (error: any) {
        reject(new Error(error?.message || String(error)));
      }
    });
  });
}

function resolveTextModelPreference(): string {
  const config = readRuntimeApiConfig() as Record<string, unknown>;
  return [
    config.llmFreeModelPriorityOrder,
    config.llm_free_model_priority_order,
    config.llmModelPriorityOrder,
    config.llm_model_priority_order,
    config.llmDefaultModelGpt,
    config.llm_default_model_gpt,
    config.llmDefaultModel,
    config.llm_default_model,
  ].map((value) => String(value || "").trim()).find(Boolean) || "xai/grok-4.3";
}

async function runCodexJsonInstruction(instruction: string): Promise<any> {
  const promptFile = createTempPromptFile(instruction);
  const outputFile = getCodexOutputPath();
  let raw = "";
  try {
    raw = await runCodexDirect(promptFile, outputFile, {
      CODEX_BOT_MODE: "1",
      CODEX_BOT_TASK: "persona-structure",
    });
    return extractJsonObject(raw);
  } catch (error: any) {
    const message = error?.message || String(error);
    console.warn("[persona-create][codex_json_fallback]", normalizeErrorForLog(message).slice(0, 500));
    try {
      const result = await callTextUnderstandingModelWithFallback(
        resolveTextModelPreference(),
        [{ role: "user", parts: [{ text: instruction }] }],
        { maxOutputTokens: 4096, temperature: 0.35 },
        undefined,
        {
          isUsableResponse: (data) => Boolean(extractText(data).trim()),
          isRetryableError: isTextModelFallbackError,
        },
      );
      raw = extractText(result.data).trim();
      return extractJsonObject(raw);
    } catch (fallbackError: any) {
      console.error("[persona-create][ai_json_parse_error]", fallbackError?.message || fallbackError, normalizeErrorForLog(raw).slice(0, 500));
      throw new Error("人设生成返回格式无效。");
    }
  } finally {
    removeTempFile(promptFile);
    removeTempFile(outputFile);
  }
}

function normalizePersonaDirectionKeyword(value: unknown): string {
  return normalizeSingleLine(String(value || ""))
    .replace(/^[\s\d.、\-_*#]+/g, "")
    .replace(/[，。；;：:「」『』"'`]+$/g, "")
    .slice(0, 18);
}

function isWeakPersonaDirectionKeyword(keyword: string): boolean {
  const value = normalizeSingleLine(keyword);
  if (!value) return true;
  if (/^(平常做什么|私下爱好|穿什么衣服|外貌形象|身形轮廓|怎么说话|常在哪里|长什么样子)$/.test(value)) return true;
  if (/^(身份|外貌|穿搭|口吻|场景|性格|行为|圈子|生活|风格|核心|方向|关键词)$/.test(value)) return true;
  if (/[什么哪里如何怎样]/.test(value)) return true;
  if (/^(有特色|有辨识度|很特别|很明确|很鲜明|人设感|故事感|氛围感)$/.test(value)) return true;
  return false;
}

function expandPersonaDirectionKeywordCandidates(originalText: string): string[] {
  const text = String(originalText || "").toLowerCase();
  const groups: Array<{ pattern: RegExp; keywords: string[] }> = [
    { pattern: /阿宅|宅男|宅女|二次元|动漫|動畫|动画|游戏|遊戲|acg|otaku/i, keywords: ["爱看动漫", "喜欢手办", "常去漫展", "会打游戏", "有点社恐"] },
    { pattern: /司机|司機|出租车|出租車|网约车|網約車|开车|開車|货车|貨車/i, keywords: ["常跑夜班", "很熟路线", "话不多", "爱听乘客聊天", "懂城市角落"] },
    { pattern: /教授|物理|化学|化學|科学|科學|研究员|研究員|学者|學者|实验|實驗|博士/i, keywords: ["大学教授", "会讲物理", "爱做实验", "说话很冷静", "穿白衬衫"] },
    { pattern: /老师|老師|教师|教師|补习|補習|校园|校園|学生|學生/i, keywords: ["会教学生", "讲话有耐心", "常在教室", "穿得干净", "有老师气场"] },
    { pattern: /上班族|白领|白領|打工|职场|職場|办公室|辦公室|社畜/i, keywords: ["每天通勤", "常在办公室", "加班很多", "穿衬衫西装", "说话很职场"] },
    { pattern: /妈妈|媽媽|人妻|主妇|主婦|家庭|太太|宝妈|寶媽/i, keywords: ["会照顾人", "常在家里", "会做家务", "说话温柔", "像邻家太太"] },
    { pattern: /健身|运动|運動|瑜伽|跑步|教练|教練|身材/i, keywords: ["每天健身", "穿运动装", "身材很紧实", "说话很直接", "爱流汗运动"] },
    { pattern: /旅行|旅游|旅遊|背包|摄影|攝影|探店|咖啡|露营|露營/i, keywords: ["常去旅行", "爱拍照片", "喜欢咖啡店", "会露营", "走路看城市"] },
    { pattern: /阿姨|大妈|大媽|婶|嬸|中年女人|中年女性|中年妇女|中年婦女/i, keywords: ["像邻家阿姨", "说话会套近乎", "穿朴素外套", "常拎购物袋", "眼神很精明"] },
    { pattern: /人贩|人販|拐卖|拐賣|绑架|綁架|黑帮|黑幫|骗子|騙子|小偷|杀手|殺手|反派/i, keywords: ["街头反派", "眼神很警惕", "穿深色外套", "话术很强", "常在车站附近"] },
  ];
  const matched: string[] = [];
  for (const group of groups) {
    if (group.pattern.test(text)) matched.push(...group.keywords);
  }
  return matched;
}

function buildPersonaPromptFallbackKeywords(originalText: string): string[] {
  const clean = normalizeSingleLine(originalText)
    .replace(/[。！？!?，,；;：:「」『』"'`]/g, "")
    .replace(/^(我想要|我要|请生成|生成|新建|做一个|一个)/, "")
    .replace(/的人设$/g, "")
    .trim();
  if (!clean) return [];
  const seed = clean.length > 8 ? clean.slice(0, 8) : clean;
  return [
    `${seed}身份`,
    `${seed}口吻`,
    `${seed}穿搭`,
    `${seed}日常`,
    `${seed}场景`,
  ];
}

function normalizePersonaDirectionKeywords(raw: unknown, originalText: string): string[] {
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.keywords)
      ? (raw as any).keywords
      : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of source) {
    const value = typeof item === "string" ? item : (item as any)?.label || (item as any)?.keyword || (item as any)?.name;
    const keyword = normalizePersonaDirectionKeyword(value);
    if (keyword.length < 2) continue;
    if (isWeakPersonaDirectionKeyword(keyword)) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(keyword);
    if (result.length >= CREATE_PERSONA_KEYWORD_COUNT) break;
  }
  if (result.length >= CREATE_PERSONA_KEYWORD_COUNT) return result;

  const fallbackCandidates = [
    ...expandPersonaDirectionKeywordCandidates(originalText),
    ...String(originalText || "").split(/[\s,，。；;、\n\r]+/g),
    ...buildPersonaPromptFallbackKeywords(originalText),
  ];
  for (const item of fallbackCandidates) {
    const keyword = normalizePersonaDirectionKeyword(item);
    if (keyword.length < 2 || keyword.length > 18) continue;
    if (isWeakPersonaDirectionKeyword(keyword)) continue;
    if (/^(我|我要|希望|生成|新建|人设|提示词|一个)$/.test(keyword)) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(keyword);
    if (result.length >= CREATE_PERSONA_KEYWORD_COUNT) break;
  }
  return result.slice(0, CREATE_PERSONA_KEYWORD_COUNT);
}

async function derivePersonaDirectionKeywordsWithCodex(personaName: string, userPrompt: string): Promise<string[]> {
  const originalText = String(userPrompt || "").trim();
  const keywordContextText = [personaName, originalText].filter(Boolean).join(" ");
  const aiInput = compactLongAiInput(originalText, 3000);
  const instruction = [
    "你是自动化推文人设策划助手。",
    "任务：根据用户的新建人设提示词，先生成 5 个自然、可选、有延展空间的核心关键词，让用户决定人设走向。",
    "关键词要往“人设本身”靠：这个人是谁、外貌形象、身形轮廓、平常做什么、穿什么、怎么说话、常出现在哪里、和什么圈子有关。不要只做单篇内容选题。",
    "请用直白、口语化、看一眼就懂的短句。不要用含糊抽象词，不要让用户猜意思。",
    "可以根据现实生活做合理联想扩展，但所有扩展都要能回到人设构成。比如“阿宅”可联想到爱看动漫、喜欢手办、常去漫展、会打游戏、有点社恐、穿宽松帽衫；“物理学家教授”可联想到大学教授、会讲物理、爱做实验、说话很冷静、穿白衬衫、斯文外貌；“出租车司机”可联想到常跑夜班、很熟路线、话不多、爱听乘客聊天、懂城市角落、穿深色外套。",
    "要求：",
    "1. 关键词要像按钮选项，直白、具体、有画面感，最好能直接看出身份、外貌形象、身形轮廓、行为、穿搭、口吻或生活环境。",
    "2. 不要求五个词必须属于不同分类，但要避免近义重复；每个词最好都能带出不同的人设味道。",
    "3. 每个关键词都要能影响后续人物形象、外貌形象、身形轮廓、穿搭、语气、社交方式、内容边界或视觉风格。",
    "4. 反向限制：不要输出黑板气质、学院派、理性克制、实验洁癖、氛围感、松弛感这类抽象概念；不要输出单篇标题、剧情桥段、临时活动、发布话题、工具功能、工作流程，也不要胡乱跳到无关职业或无关圈层。",
    "5. 关键词要短，3 到 10 个中文字最佳，可以是口语短句，不要输出完整人设文案。",
    "6. 只输出 JSON，不要 Markdown。",
    "",
    "JSON schema:",
    JSON.stringify({ keywords: ["核心关键词1", "核心关键词2", "核心关键词3", "核心关键词4", "核心关键词5"] }, null, 2),
    "",
    `人设名称：${personaName}`,
    `用户提示词：${aiInput}`,
  ].join("\n");
  try {
    return normalizePersonaDirectionKeywords(await runCodexJsonInstruction(instruction), keywordContextText);
  } catch (error: any) {
    console.warn("[persona-create][keyword_fallback]", error?.message || error);
    return normalizePersonaDirectionKeywords([], keywordContextText);
  }
}

function normalizeCodexPersonaSpec(raw: any, originalText: string): { name: string; content: string; setup: DramaSetup } {
  const name = pickString(raw?.name);
  const content = pickString(raw?.content);
  const setupRaw = raw?.setup && typeof raw.setup === "object" ? raw.setup : {};
  if (!name || !content) {
    throw new Error("AI 未返回有效的人设名称或简介");
  }
  const genres = pickStringArray(setupRaw.genres, [name]);
  const setup: DramaSetup = {
    genres,
    personaPersonality: pickString(setupRaw.personaPersonality, "贴近生活、有辨识度"),
    personaGender: pickString(setupRaw.personaGender, "不限"),
    personaStyle: pickString(setupRaw.personaStyle, "真实口语表达，先讲具体场景再给反应"),
    totalEpisodes: Number(setupRaw.totalEpisodes) || 50,
    targetMarket: pickString(setupRaw.targetMarket, "cn"),
    chineseScript: "simplified" as DramaSetup["chineseScript"],
    personaName: pickString(setupRaw.personaName, name),
    personaDescription: pickString(setupRaw.personaDescription, content),
    contentTheme: pickString(setupRaw.contentTheme, genres.join("、")),
    customTopic: pickString(setupRaw.customTopic, originalText),
  };
  setup.interests = derivePersonaInterestTags(
    {
      ...setup,
      interests: normalizePersonaInterestTags(setupRaw.interests),
    },
    content,
  );
  const isGirlPersona = pickBoolean(setupRaw.isGirlPersona);
  const isMemePersona = pickBoolean(setupRaw.isMemePersona);
  if (isGirlPersona !== undefined) setup.isGirlPersona = isGirlPersona;
  if (isMemePersona !== undefined) setup.isMemePersona = isMemePersona;
  return { name, content, setup };
}

async function derivePersonaSpecWithCodex(text: string): Promise<{ name: string; content: string; setup: DramaSetup }> {
  const originalText = String(text || "").trim();
  const aiInput = compactLongAiInput(originalText);
  const instruction = [
    "你是自动化推文运营控制台的人设结构化助手。",
    "必须根据用户输入创建一个可用于后续生成推文和配图的人设卡片。",
    "要求：",
    "1. 必须理解用户真实意图，名称要和人设内容匹配，不能用泛名。",
    "2. content 是后续生成推文和生成图片都会参考的人设简介，要写清身份、内容领域、语气、视觉倾向和边界。",
    "3. 图片视觉倾向只能来自人设卡片，例如生活类、搞笑类、职场类等，不能硬编码成固定模板。",
    "4. 如果是美女传播型，只能标记 isGirlPersona=true，但描述必须限定为成年人、非露骨、非色情。",
    "5. 如果是梗图、搞笑、表情包型，可以标记 isMemePersona=true。",
    "6. 如果用户输入是一整段很长的提示词、模板、脚本规则或内容要求，也必须提炼成人设卡片；不要因为它不是短句而失败。",
    "7. 如果没有明确人设名称，必须根据核心主题自动起一个具体名称。",
    "8. 只输出 JSON 对象，不要 Markdown，不要解释。",
    "",
    "输出要求：所有 JSON 字符串必须使用简体中文。",
    "强制 setup.targetMarket = \"cn\"，强制 setup.chineseScript = \"simplified\"。",
    "JSON schema:",
    JSON.stringify({
      name: "人设名称",
      content: "人设简介卡片",
      setup: {
        genres: ["领域或内容类型"],
        personaPersonality: "性格基调",
        personaGender: "女性/男性/不限",
        personaStyle: "表达方式",
        totalEpisodes: 50,
        targetMarket: "cn",
        chineseScript: "simplified",
        personaName: "人设名称",
        personaDescription: "同 content 或更短描述",
        contentTheme: "内容主题和图片视觉倾向",
        interests: ["Threads 可填写的兴趣标签"],
        customTopic: "用户原始输入",
        isGirlPersona: false,
        isMemePersona: false,
      },
    }, null, 2),
    "",
    aiInput.length !== originalText.length ? `用户原始输入较长，已保留首尾关键信息用于提炼（原长度 ${originalText.length} 字）。` : "",
    `用户输入：${aiInput}`,
  ].filter(Boolean).join("\n");
  return normalizeCodexPersonaSpec(await runCodexJsonInstruction(instruction), originalText);
}

function buildPersonaPromptWithKeywords(personaName: string, userPrompt: string, selectedKeywords: string[]): string {
  return [
    `角色名称：${personaName}`,
    "",
    userPrompt,
    "",
    selectedKeywords.length
      ? `用户已选择的人设走向核心关键词：${selectedKeywords.join("、")}。请把这些方向作为最高优先级，生成完整人设。`
      : "用户未额外选择核心关键词，请根据原始提示词自主判断最合理的人设走向。",
  ].join("\n");
}

async function createPersonaFromPromptSelection(personaName: string, userPrompt: string, selectedKeywords: string[]) {
  const personaPrompt = buildPersonaPromptWithKeywords(personaName, userPrompt, selectedKeywords);
  const spec = await derivePersonaSpecWithCodex(personaPrompt);
  spec.name = personaName;
  spec.setup = {
    ...spec.setup,
    personaName,
    customTopic: userPrompt,
    contentTheme: [
      spec.setup.contentTheme,
      selectedKeywords.length ? `核心走向：${selectedKeywords.join("、")}` : "",
    ].filter(Boolean).join("\n"),
  } as DramaSetup;
  spec.setup.interests = derivePersonaInterestTags(
    {
      ...spec.setup,
      interests: [...normalizePersonaInterestTags(spec.setup.interests), ...selectedKeywords],
    },
    spec.content,
  );
  const created = await runPersonaWorkflow({
    action: "create",
    name: spec.name,
    content: spec.content,
    setup: spec.setup,
  });
  if (!created?.ok || !created.archiveId) {
    throw new Error("新建人设失败，未返回 archiveId");
  }
  return {
    ok: true,
    action: "create-from-prompt",
    archiveId: created.archiveId,
    name: created.name,
    content: spec.content,
    setup: spec.setup,
    selectedKeywords: selectedKeywords.slice(0, CREATE_PERSONA_MAX_SELECTED_KEYWORDS),
  };
}

async function derivePersonaProfileFromPrompt(personaName: string, userPrompt: string, selectedKeywords: string[]) {
  const personaPrompt = buildPersonaPromptWithKeywords(personaName, userPrompt, selectedKeywords);
  const spec = await derivePersonaSpecWithCodex(personaPrompt);
  spec.name = personaName;
  spec.setup = {
    ...spec.setup,
    personaName,
    customTopic: userPrompt,
    contentTheme: [
      spec.setup.contentTheme,
      selectedKeywords.length ? `selected keywords: ${selectedKeywords.join(", ")}` : "",
    ].filter(Boolean).join("\n"),
  } as DramaSetup;
  spec.setup.interests = derivePersonaInterestTags(
    {
      ...spec.setup,
      interests: [...normalizePersonaInterestTags(spec.setup.interests), ...selectedKeywords],
    },
    spec.content,
  );
  return {
    ok: true,
    action: "derive-profile",
    name: spec.name,
    content: spec.content,
    setup: spec.setup,
    selectedKeywords: selectedKeywords.slice(0, CREATE_PERSONA_MAX_SELECTED_KEYWORDS),
  };
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    printJson({ ok: false, error: "missing JSON input" });
    process.exitCode = 1;
    return;
  }
  const input = JSON.parse(raw) as Input;
  if (input.action === "suggest-keywords") {
    const personaName = normalizeSingleLine(String(input.personaName || "")).slice(0, 40);
    const userPrompt = String(input.userPrompt || "").trim();
    if (!personaName) throw new Error("persona name cannot be empty");
    if (!userPrompt) throw new Error("persona prompt cannot be empty");
    const keywords = await derivePersonaDirectionKeywordsWithCodex(personaName, userPrompt);
    printJson({ ok: true, action: input.action, personaName, keywords });
    return;
  }
  if (input.action === "create-from-prompt") {
    const personaName = normalizeSingleLine(String(input.personaName || "")).slice(0, 40);
    const userPrompt = String(input.userPrompt || "").trim();
    const selectedKeywords = Array.isArray(input.selectedKeywords)
      ? input.selectedKeywords
        .map((item) => normalizePersonaDirectionKeyword(item))
        .filter(Boolean)
        .slice(0, CREATE_PERSONA_MAX_SELECTED_KEYWORDS)
      : [];
    if (!personaName) throw new Error("persona name cannot be empty");
    if (!userPrompt) throw new Error("persona prompt cannot be empty");
    printJson(await createPersonaFromPromptSelection(personaName, userPrompt, selectedKeywords));
    return;
  }
  if (input.action === "derive-profile") {
    const personaName = normalizeSingleLine(String(input.personaName || "")).slice(0, 40);
    const userPrompt = String(input.userPrompt || "").trim();
    const selectedKeywords = Array.isArray(input.selectedKeywords)
      ? input.selectedKeywords
        .map((item) => normalizePersonaDirectionKeyword(item))
        .filter(Boolean)
        .slice(0, CREATE_PERSONA_MAX_SELECTED_KEYWORDS)
      : [];
    if (!personaName) throw new Error("persona name cannot be empty");
    if (!userPrompt) throw new Error("persona prompt cannot be empty");
    printJson(await derivePersonaProfileFromPrompt(personaName, userPrompt, selectedKeywords));
    return;
  }
  throw new Error(`unsupported action: ${(input as any)?.action || ""}`);
}

main().catch((error) => {
  printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
