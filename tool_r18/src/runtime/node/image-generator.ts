import { getRuntimeApiConfigForProtocol, readRuntimeTextGenConfig } from "./config";

export type ImageGenerateResult = {
  ok: boolean;
  url?: string;
  error?: string;
  retryable?: boolean;
  reasonCode?: string;
  attempts?: number;
  timings?: unknown;
};

export type ImageAspectRatio = "1:1" | "4:5" | "3:4" | "9:16" | "4:3" | "16:9";

const DEFAULT_IMAGE_ASPECT_RATIO: ImageAspectRatio = "1:1";
const IMAGE_ASPECT_RATIOS = new Set<ImageAspectRatio>(["1:1", "4:5", "3:4", "9:16", "4:3", "16:9"]);

function normalizeImageAspectRatio(value: unknown): ImageAspectRatio {
  return typeof value === "string" && IMAGE_ASPECT_RATIOS.has(value as ImageAspectRatio)
    ? (value as ImageAspectRatio)
    : DEFAULT_IMAGE_ASPECT_RATIO;
}

function buildGeminiApiUrl(endpoint: string | undefined, model: string): string {
  const raw = (endpoint || "http://202.90.21.53:13003").trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withScheme);
  url.hash = "";
  url.search = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/v1beta\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/i, "/v1beta");
  pathname = pathname.replace(/\/v1\/(?:chat\/completions|messages|models)$/i, "");
  pathname = pathname.replace(/\/v1$/i, "/v1beta");
  if (!/\/v1beta$/i.test(pathname)) pathname = `${pathname}/v1beta`.replace(/^\/?/, "/");
  url.pathname = `${pathname}/models/${model}:generateContent`;
  return url.toString();
}

function buildOpenAiImageApiUrl(endpoint: string | undefined): string {
  const raw = (endpoint || "http://202.90.21.53:13003").trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withScheme);
  url.hash = "";
  url.search = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/v1\/(?:chat\/completions|messages|models|images\/generations?)$/i, "");
  pathname = pathname.replace(/\/v1beta\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/i, "");
  if (!/\/v1$/i.test(pathname)) pathname = `${pathname}/v1`.replace(/^\/?/, "/");
  url.pathname = `${pathname}/images/generations`;
  return url.toString();
}

function createAbortTimeout(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

function getOpenAiImageSize(aspectRatio: ImageAspectRatio): string {
  if (aspectRatio === "16:9" || aspectRatio === "4:3") return "1536x1024";
  if (aspectRatio === "9:16" || aspectRatio === "4:5" || aspectRatio === "3:4") return "1024x1536";
  return "1024x1024";
}

function classifyImageGenerateError(errorText: string): { retryable: boolean; reasonCode: string } {
  const text = String(errorText || "");
  if (/model_not_found|無可用渠道|无可用渠道|no available distributor/i.test(text)) {
    return { retryable: false, reasonCode: "model_unavailable" };
  }
  if (/未設定 API Key|API Key/i.test(text)) {
    return { retryable: false, reasonCode: "auth_missing" };
  }
  if (/安全策略攔截|版權引用限制|SAFETY|RECITATION/i.test(text)) {
    return { retryable: false, reasonCode: "policy_blocked" };
  }
  if (/API 返回 4\d\d/i.test(text) && !/429/.test(text)) {
    return { retryable: false, reasonCode: "client_error" };
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|fetch failed|network/i.test(text)) {
    return { retryable: true, reasonCode: "network_error" };
  }
  if (/API 返回 5\d\d|API 返回 429|未返回圖片|未返回图片|響應結構未識別|响应结构未识别|MAX_TOKENS|OTHER/i.test(text)) {
    return { retryable: true, reasonCode: "upstream_error" };
  }
  return { retryable: false, reasonCode: "unknown" };
}

export async function generateClosedModelImage(params: {
  prompt: string;
  model: string;
  aspectRatio?: string;
  avatarBase64?: string;
  avatarMimeType?: string;
  configPath?: string;
  dataDir?: string;
  timeoutMs?: number;
}): Promise<ImageGenerateResult> {
  const protocol = params.model.startsWith("gpt-image-") ? "openai" : "gemini";
  const { apiKey, endpoint } = getRuntimeApiConfigForProtocol(protocol, {
    configPath: params.configPath,
    dataDir: params.dataDir,
  });
  if (!apiKey) {
    return { ok: false, error: "未設定 API Key", retryable: false, reasonCode: "auth_missing" };
  }

  const aspectRatio = normalizeImageAspectRatio(params.aspectRatio);
  const timeoutMs = params.timeoutMs || 150_000;
  const timeout = createAbortTimeout(timeoutMs);
  try {
    if (/^gpt-image-/i.test(params.model)) {
      const imageSize = getOpenAiImageSize(aspectRatio);
      if (params.avatarBase64) {
        const editsUrl = buildOpenAiImageApiUrl(endpoint).replace(/\/images\/generations$/, "/images/edits");
        const boundary = `----FormBoundary${Date.now()}`;
        const mimeType = params.avatarMimeType || "image/jpeg";
        const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
        const imgBuffer = Buffer.from(params.avatarBase64, "base64");
        const parts: Buffer[] = [];
        const field = (name: string, value: string) =>
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
        parts.push(field("model", params.model));
        parts.push(field("prompt", params.prompt));
        parts.push(field("size", imageSize));
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="reference.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
        parts.push(imgBuffer);
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
        const body = Buffer.concat(parts);
        const resp = await fetch(editsUrl, {
          method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, Authorization: `Bearer ${apiKey}` },
          signal: timeout.signal,
          body,
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          const error = `API 返回 ${resp.status}：${errText.slice(0, 300)}`;
          return { ok: false, error, ...classifyImageGenerateError(error) };
        }
        const data: any = await resp.json();
        const item = data?.data?.[0];
        if (item?.b64_json) return { ok: true, url: `data:image/png;base64,${item.b64_json}` };
        if (item?.url) return { ok: true, url: item.url };
        return { ok: false, error: "GPT 圖片模型未返回圖片", ...classifyImageGenerateError("GPT 圖片模型未返回圖片") };
      }

      const genUrl = buildOpenAiImageApiUrl(endpoint);
      const payload = { model: params.model, prompt: params.prompt, size: imageSize, n: 1 };
      const resp = await fetch(genUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        signal: timeout.signal,
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        const error = `API 返回 ${resp.status}：${errText.slice(0, 300)}`;
        return { ok: false, error, ...classifyImageGenerateError(error) };
      }
      const data: any = await resp.json();
      const item = data?.data?.[0];
      if (item?.b64_json) return { ok: true, url: `data:image/png;base64,${item.b64_json}` };
      if (item?.url) return { ok: true, url: item.url };
      return { ok: false, error: "GPT 圖片模型未返回圖片", ...classifyImageGenerateError("GPT 圖片模型未返回圖片") };
    }

    const url = buildGeminiApiUrl(endpoint, params.model);
    const parts: any[] = [];
    if (params.avatarBase64) {
      parts.push({ inlineData: { mimeType: params.avatarMimeType || "image/jpeg", data: params.avatarBase64 } });
    }
    parts.push({ text: params.prompt });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (url.includes("generativelanguage.googleapis.com")) {
      headers["x-goog-api-key"] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      signal: timeout.signal,
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["IMAGE", "TEXT"],
          imageConfig: { aspectRatio },
        },
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      const error = `API 返回 ${resp.status}：${errText.slice(0, 300)}`;
      return { ok: false, error, ...classifyImageGenerateError(error) };
    }
    const data: any = await resp.json();
    const resParts = data?.candidates?.[0]?.content?.parts || [];
    for (const part of resParts) {
      if (part.inlineData?.data) {
        const mimeType = part.inlineData.mimeType || "image/png";
        return { ok: true, url: `data:${mimeType};base64,${part.inlineData.data}` };
      }
      if (part.fileData?.fileUri) return { ok: true, url: part.fileData.fileUri };
      if (typeof part.text === "string") {
        const dataUrlMatch = part.text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
        if (dataUrlMatch) return { ok: true, url: dataUrlMatch[0] };
        const mdMatch = part.text.match(/!\[.*?\]\((https?:\/\/[^)]+|data:image\/[^)]+)\)/);
        if (mdMatch) return { ok: true, url: mdMatch[1] };
        const urlMatch = part.text.match(/(https?:\/\/\S+\.(png|jpg|jpeg|webp|gif))/i);
        if (urlMatch) return { ok: true, url: urlMatch[1] };
        if (part.text.startsWith("http://") || part.text.startsWith("https://") || part.text.startsWith("data:image/")) return { ok: true, url: part.text.trim() };
      }
    }
    return { ok: false, error: "響應結構未識別", ...classifyImageGenerateError("響應結構未識別") };
  } catch (e: any) {
    const aborted = e?.name === "AbortError" || timeout.signal.aborted;
    const error = aborted ? `圖片 API 請求逾時（${Math.round(timeoutMs / 1000)} 秒）` : e?.message || String(e);
    return { ok: false, error, ...(aborted ? { retryable: true, reasonCode: "timeout" } : classifyImageGenerateError(error)) };
  } finally {
    timeout.cleanup();
  }
}

export async function generateClosedModelImageWithRetries(params: {
  prompt: string;
  model: string;
  aspectRatio?: string;
  avatarBase64?: string;
  avatarMimeType?: string;
  configPath?: string;
  dataDir?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}): Promise<ImageGenerateResult> {
  const retryConfig = readRuntimeTextGenConfig({ configPath: params.configPath, dataDir: params.dataDir });
  const maxAttempts = params.maxAttempts ?? Math.max(1, (retryConfig.retryCount ?? 1) + 1);
  const retryDelayMs = Math.max(200, retryConfig.retryDelayMs ?? 800);
  let lastResult: ImageGenerateResult = { ok: false, error: "未知錯誤", retryable: false, reasonCode: "unknown" };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await generateClosedModelImage(params);
    if (result.ok) return { ...result, attempts: attempt };
    lastResult = { ...result, attempts: attempt };
    if (!result.retryable || attempt >= maxAttempts) return lastResult;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
  }

  return lastResult;
}
