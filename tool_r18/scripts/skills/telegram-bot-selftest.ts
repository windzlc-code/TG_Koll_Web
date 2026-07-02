import { callCodex, fastPathListPersonas, fastPathPersonaDetail, generatePostsByMatchedPersona } from "@/telegram-bot";

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim() || "我现在需要创建推文";
  try {
    const isDetailRequest = /(查看|看看).+人设|人设详情|这个人设/.test(prompt);
    const isListRequest = /列出.*人设|我有哪些人设|当前所有人设|人设列表/.test(prompt);
    const isGenerateRequest = /生成.*推文|创建推文|写推文/.test(prompt);
    const detailPathResult = isDetailRequest ? await fastPathPersonaDetail(prompt).catch(() => null) : null;
    const listPathResult = detailPathResult ? null : await fastPathListPersonas(prompt).catch(() => null);
    const fastPathResult = detailPathResult || listPathResult || await generatePostsByMatchedPersona(prompt).catch(() => null);
    const result = isDetailRequest
      ? (detailPathResult || "当前还没有任何人设。")
      : isListRequest
        ? (listPathResult || "当前还没有任何人设。")
        : isGenerateRequest
          ? (fastPathResult || "❌ 生成推文失败，请稍后重试")
          : (fastPathResult || await callCodex(prompt));
    process.stdout.write(result || "<empty>");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(message);
    process.exitCode = 1;
  }
}

main();
