export function sanitizeDramaScriptToSocialPost(raw: string): string {
  const text = (raw || "").replace(/\r/g, "").trim();
  if (!text) return "";

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#\s*第\d+[集話篇]/.test(line))
    .filter((line) => !/^#\s*\d+-\d+\b/.test(line))
    .filter((line) => !/^第\d+[集話篇][：:].*/.test(line))
    .filter((line) => !/^出場人物[：:].*/.test(line))
    .filter((line) => !/^\*\*場景[：:].*/.test(line))
    .filter((line) => /^#/.test(line) === false)
    .filter((line) => /^(INT\.|EXT\.|內景|外景)\b/.test(line) === false)
    .filter((line) => /^(♪|音樂提示|Music|Score|OST|音楽)/i.test(line) === false)
    .filter((line) => /^（?場景|^\[場景/.test(line) === false);

  const joined = lines.join("\n").trim();
  if (!joined) return text;

  return joined
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(第\d+[集話篇]\s*[：:]?\s*)+/g, "")
    .trim();
}
