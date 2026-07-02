export function buildRegeneratePostInstruction(originalContent: string, attempt = 1): string {
  return [
    "重新生成下面这 1 篇待发布推文。",
    "要求：",
    "1. 只生成一篇新的推文文案，不要解释，不要输出编号。",
    "2. 保持同一个人设和同一个主题方向；文风必须以当前人设设置、当前推文风格设置和当前生成规则为准。",
    "3. 原推文只用于识别主题和信息点，不得把原推文当作风格模板；如果推文风格已经恢复初始状态，必须回到通用人设推文规则。",
    "4. 不要复用原文句式、段落节奏、口头禅、表情密度或结尾互动方式；表达必须明显不同。",
    attempt > 1 ? `5. 上一次重写与原文过于相似；这次必须重新组织开头、段落顺序、语气和结尾互动。` : "",
    "",
    `原推文：${String(originalContent || "").trim()}`,
  ].filter(Boolean).join("\n");
}

function normalizeSimilarityText(value: string): string {
  return String(value || "")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "")
    .toLowerCase();
}

function stripStableTrailingContactBlock(value: string): string {
  const lines = String(value || "").split(/\r?\n/);
  const nonEmptyItems = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((item) => item.line);
  if (!nonEmptyItems.length) return String(value || "");
  const contactLinePattern = /(?:https?:\/\/|www\.|t\.me\/|line\s*[:：]|telegram|聯絡|联系|電話|电话|手機|手机|行動|微信|wechat|@|0\d{1,3}[-\s]?\d{3,}|\d{3,}[-\s]\d{3,})/i;
  const contactBlockPattern = /(?:專案|专案|方案|利率|低息|諮詢|咨询|私訊|私讯|聯絡|联系|補個|补个|詳情|详情|教程|更多|預約|预约|申請|申请|放款|貸款|贷款)/i;
  let cursor = nonEmptyItems.length - 1;
  while (cursor >= 0 && !contactLinePattern.test(nonEmptyItems[cursor].line)) cursor -= 1;
  if (cursor < 0 || nonEmptyItems.length - 1 - cursor > 2) return String(value || "");

  let start = cursor;
  for (let index = cursor - 1; index >= 0 && cursor - index <= 3; index -= 1) {
    const line = nonEmptyItems[index].line;
    if (line.length > 80) break;
    if (!contactLinePattern.test(line) && !contactBlockPattern.test(line)) break;
    start = index;
  }
  const next = lines.slice(0, nonEmptyItems[start].index).join("\n").trim();
  return next ? next : String(value || "");
}

function bigramSet(value: string): Set<string> {
  const set = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    set.add(value.slice(index, index + 2));
  }
  return set;
}

function hasLongSharedFragment(original: string, generated: string, minLength = 24): boolean {
  const shorter = original.length <= generated.length ? original : generated;
  const longer = original.length <= generated.length ? generated : original;
  if (shorter.length < minLength) return false;
  for (let index = 0; index <= shorter.length - minLength; index += 1) {
    if (longer.includes(shorter.slice(index, index + minLength))) return true;
  }
  return false;
}

function countListStructureMarkers(value: string): number {
  const text = String(value || "");
  const matches = text.match(/(?:^|[\n\s。！？；;，,])(?:\d{1,2}[.、)]|[一二三四五六七八九十]+[.、)]|[-•*])\s*/g);
  return matches?.length || 0;
}

function hasCopiedListStructure(originalContent: string, generatedContent: string): boolean {
  const originalMarkers = countListStructureMarkers(originalContent);
  const generatedMarkers = countListStructureMarkers(generatedContent);
  return originalMarkers >= 2 && generatedMarkers >= 2;
}

function calculateNormalizedSimilarity(original: string, generated: string, denominator: "min" | "max" = "min"): number {
  if (!original || !generated) return 0;
  if (original === generated) return 1;
  const originalSet = bigramSet(original);
  const generatedSet = bigramSet(generated);
  if (!originalSet.size || !generatedSet.size) return 0;
  let overlap = 0;
  for (const item of generatedSet) {
    if (originalSet.has(item)) overlap += 1;
  }
  const base = denominator === "max"
    ? Math.max(originalSet.size, generatedSet.size)
    : Math.min(originalSet.size, generatedSet.size);
  return overlap / base;
}

export function calculateRegeneratedPostSimilarity(originalContent: string, generatedContent: string): number {
  return calculateNormalizedSimilarity(
    normalizeSimilarityText(originalContent),
    normalizeSimilarityText(generatedContent),
  );
}

export function isRegeneratedPostTooSimilar(
  originalContent: string,
  generatedContent: string,
  options: { allowSameListStructure?: boolean; similarityThreshold?: number; allowShortTemplateReuse?: boolean; ignoreStableTrailingContactBlock?: boolean } = {},
): boolean {
  const fullOriginal = normalizeSimilarityText(originalContent);
  const fullGenerated = normalizeSimilarityText(generatedContent);
  if (!fullOriginal || !fullGenerated) return false;
  if (fullOriginal === fullGenerated) return true;
  const comparisonOriginalContent = options.ignoreStableTrailingContactBlock ? stripStableTrailingContactBlock(originalContent) : originalContent;
  const comparisonGeneratedContent = options.ignoreStableTrailingContactBlock ? stripStableTrailingContactBlock(generatedContent) : generatedContent;
  const original = normalizeSimilarityText(comparisonOriginalContent);
  const generated = normalizeSimilarityText(comparisonGeneratedContent);
  if (!original || !generated) return false;
  const isShortTemplateRewrite = Boolean(options.allowShortTemplateReuse) && original.length < 90;
  const shortOriginal = original.slice(0, Math.min(original.length, 80));
  const shortGenerated = generated.slice(0, Math.min(generated.length, 80));
  if (!isShortTemplateRewrite && shortOriginal.length >= 20 && (generated.includes(shortOriginal) || original.includes(shortGenerated))) return true;
  if (hasLongSharedFragment(original, generated, isShortTemplateRewrite ? 36 : 24)) return true;
  if (!options.allowSameListStructure && hasCopiedListStructure(originalContent, generatedContent)) return true;
  return calculateNormalizedSimilarity(original, generated, options.ignoreStableTrailingContactBlock ? "max" : "min") >= (options.similarityThreshold ?? 0.72);
}
