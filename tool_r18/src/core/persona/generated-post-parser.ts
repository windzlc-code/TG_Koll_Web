export function stripReasoningArtifacts(text: string): string {
  return (text || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^```[\s\S]*?```$/gm, "")
    .trim();
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff]/.test(text);
}

function isReasoningHeading(line: string): boolean {
  return /^\*{0,2}\s*(defining|crafting|refining|analyzing|analysis|objective|persona|draft|finalizing|checking|planning|thinking)\b/i.test(line.trim());
}

function isReasoningParagraph(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (containsCjk(text)) return false;
  return /\b(I'?m|I am|I need|I now|I have|I just|currently|focused on|building out|crafting|refined|requirements?|parameters?|word count|persona|teaser post|engagement|draft|output|goal)\b/i.test(text);
}

function stripMarkdownReasoningSections(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (isReasoningHeading(trimmed)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (!trimmed || isReasoningParagraph(trimmed) || isReasoningHeading(trimmed)) {
        continue;
      }
      skipping = false;
    }
    if (isReasoningParagraph(trimmed)) continue;
    kept.push(line);
  }

  return kept.join("\n").trim();
}

function normalizeParagraphs(segment: string): string {
  const seen = new Set<string>();
  return segment
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const key = part.replace(/\s+/g, " ");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n\n")
    .trim();
}

export function sanitizeGeneratedPostContent(content: string): string {
  return normalizeParagraphs(stripMarkdownReasoningSections(stripReasoningArtifacts(content || "")));
}

export function parseGeneratedPosts(raw: string, count: number): string[] {
  const cleaned = stripMarkdownReasoningSections(stripReasoningArtifacts(raw))
    .replace(/\r/g, "")
    .trim();

  const segments = cleaned
    .split(/\n?---\n?/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((segment) =>
      segment
        .replace(/^第\d+篇[：:].*?\n?/gm, "")
        .replace(/^篇\d+[：:].*?\n?/gm, "")
        .replace(/^第[一二三四五六七八九十\d]+篇（.*?）[：:]?\n?/gm, "")
        .replace(/^第[一二三四五六七八九十\d]+篇\s*[\(（].*?[\)）]\s*[：:]?\n?/gm, "")
        .replace(/^检查[：:].*$/gm, "")
        .replace(/^檢查[：:].*$/gm, "")
        .replace(/^話題[：:].*$/gm, "")
        .replace(/^开頭[：:].*$/gm, "")
        .replace(/^開頭[：:].*$/gm, "")
        .replace(/^結構[：:].*$/gm, "")
        .replace(/^结构[：:].*$/gm, "")
        .replace(/^情緒[：:].*$/gm, "")
        .replace(/^情绪[：:].*$/gm, "")
        .replace(/^長度[：:].*$/gm, "")
        .replace(/^长度[：:].*$/gm, "")
        .replace(/^正文[：:].*$/gm, "")
        .replace(/^用戶要求我.*$/gm, "")
        .replace(/^用户要求我.*$/gm, "")
        .replace(/^重要要求[：:].*$/gm, "")
        .replace(/^讓我.*$/gm, "")
        .replace(/^让我.*$/gm, "")
        .replace(/^我重新思考了.*$/gm, "")
        .replace(/^故事型.*$/gm, "")
        .replace(/^實用型.*$/gm, "")
        .replace(/^主題[：:].*$/gm, "")
        .replace(/^角度[：:].*$/gm, "")
        .replace(/^"|"$/g, "")
        .trim(),
    )
    .map(sanitizeGeneratedPostContent)
    .filter(Boolean)
    .filter((segment) => !/^(三篇都有了明确的差异化|三篇都有了明確的差異化|开始写|開始寫|我需要生成|我需要寫|我身邊|我媽最近)/.test(segment));

  return segments.slice(0, count);
}
