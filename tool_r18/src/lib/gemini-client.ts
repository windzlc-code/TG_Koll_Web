/**
 * 本機 Gemini API 客戶端 — 直連模式
 */
import { getRuntimeApiConfigForProtocol, readRuntimeApiConfig, resolveModelProtocol } from "@/runtime/node/config";
import { buildApiHeaders, buildApiUrl, DEFAULT_API_BASE_URL } from "@/lib/api-endpoints";
import type { ApiProtocol } from "@/lib/api-endpoints";

const DEFAULT_TEXT_MODEL_MAPPINGS = {
  "xai/grok-4.3": { modelId: "xai/grok-4.3", protocol: "openai" },
  "grok-4.2": { modelId: "grok-4.2", protocol: "openai" },
  "gemini-3-flash-preview": { modelId: "gemini-3-flash-preview", protocol: "gemini-text" },
  "gemini-3-pro-preview": { modelId: "gemini-3-pro-preview", protocol: "gemini-text" },
  "gemini-3.1-pro-preview": { modelId: "gemini-3.1-pro-preview", protocol: "gemini-text" },
  "gemini-3.1-flash-image-preview": { modelId: "gemini-3.1-flash-image-preview", protocol: "gemini" },
  "gpt-image-2": { modelId: "gpt-image-2", protocol: "openai" },
} as const;

// Shim getApiConfig / getApiConfigForProtocol for modules that still reference them
function getApiConfig() {
  const config = readRuntimeApiConfig();
  return {
    apiKey: config.geminiTextKey || config.geminiKey || config.zhanhuKey || "",
    endpoint: config.geminiTextEndpoint || config.geminiEndpoint || config.zhanhuEndpoint || DEFAULT_API_BASE_URL,
    gptKey: config.gptKey || "",
    gptEndpoint: config.gptEndpoint || "",
    modelMappings: { ...DEFAULT_TEXT_MODEL_MAPPINGS, ...(config.modelMappings || {}) },
  };
}
function getApiConfigForProtocol(protocol: string) {
  // For text/vision models (like publish verification), prefer gemini-text config
  if (protocol === "gemini") {
    return getRuntimeApiConfigForProtocol("gemini-text");
  }
  return getRuntimeApiConfigForProtocol(protocol as any);
}
function getResolvedTextModelApiProtocol(model: { modelId: string; protocol?: string } | string): ApiProtocol {
  if (typeof model === "object" && model?.protocol) {
    if (model.protocol === "gemini-text") return "gemini";
    return model.protocol as ApiProtocol;
  }
  return resolveModelProtocol(typeof model === "string" ? model : model.modelId) as ApiProtocol;
}
function resolveTextModelMapping(model: string, mappings?: any): { modelId: string; protocol?: string } {
  const mapped = mappings?.[model];
  if (mapped && typeof mapped === "object") {
    return {
      modelId: String(mapped.modelId || model || "").trim() || model,
      protocol: typeof mapped.protocol === "string" ? mapped.protocol : undefined,
    };
  }
  return { modelId: model };
}

export const DEFAULT_GEMINI_BASE_URL = DEFAULT_API_BASE_URL;
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
export const TEXT_UNDERSTANDING_MODEL_FALLBACKS = [
  "xai/grok-4.3",
] as const;

function parseTextModelList(value?: string): string[] {
  return String(value || "")
    .split(/[,\n]/)
    .map((model) => model.trim())
    .filter(Boolean);
}

export function getTextUnderstandingModelFallbacks(primaryModel?: string): string[] {
  const primaryModels = parseTextModelList(primaryModel);
  const ordered = primaryModels.length ? primaryModels : [...TEXT_UNDERSTANDING_MODEL_FALLBACKS];
  return Array.from(new Set(ordered.map((model) => model.trim()).filter(Boolean)));
}

function createManagedRequestSignal(
  externalSignal?: AbortSignal,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): { signal: AbortSignal; didTimeout: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;

  const forwardAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) {
      forwardAbort();
    } else {
      externalSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      globalThis.clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", forwardAbort);
    },
  };
}

function normalizeGeminiError(error: unknown, didTimeout: boolean, timeoutMs: number): Error {
  if (didTimeout) {
    return new Error(`請求超時（${Math.ceil(timeoutMs / 1000)}s），請檢查 API 閘道器狀態後重試`);
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}

/** 從目標 URL 推斷服務名；非 AI 請求返回 null */
export function inferServiceFromUrl(url: string): string | null {
  if (url.includes("generativelanguage.googleapis.com")) return "gemini";
  if (url.includes(":generateContent") || url.includes(":streamGenerateContent")) return "gemini";
  if (url.includes("/chat/completions")) return "openai";
  if (url.includes("/v1/messages")) return "anthropic";
  if (url.includes("/v1/images/generations")) return "gemini";
  return null;
}

function buildOpenAiMessages(contents: any[]): Array<{ role: "system" | "user" | "assistant"; content: string | Array<any> }> {
  return contents.map((item) => {
    const role = item?.role === "model" ? "assistant" : (item?.role || "user");
    const parts = Array.isArray(item?.parts) ? item.parts : [];
    const content = parts.map((part: any) => {
      if (part?.text) {
        return { type: "text", text: String(part.text) };
      }
      if (part?.inlineData?.data) {
        const mimeType = part.inlineData.mimeType || "image/png";
        return {
          type: "image_url",
          image_url: {
            url: `data:${mimeType};base64,${part.inlineData.data}`,
          },
        };
      }
      return null;
    }).filter(Boolean);

    if (content.length === 1 && content[0]?.type === "text") {
      return { role, content: content[0].text };
    }
    return { role, content };
  });
}

function extractOpenAiTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        if (part?.text?.value) return part.text.value;
        return "";
      })
      .join("");
  }
  return "";
}

function extractOpenAiDeltaText(delta: any): string {
  if (!delta) return "";
  if (typeof delta.content === "string") return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        if (part?.text?.value) return part.text.value;
        return "";
      })
      .join("");
  }
  return "";
}

function buildAnthropicMessages(contents: any[]): Array<{ role: "user" | "assistant"; content: Array<any> }> {
  return contents.map((item) => {
    const role = item?.role === "model" || item?.role === "assistant" ? "assistant" : "user";
    const parts = Array.isArray(item?.parts) ? item.parts : [];
    const content = parts.map((part: any) => {
      if (part?.text) return { type: "text", text: String(part.text) };
      if (part?.inlineData?.data) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: part.inlineData.mimeType || "image/png",
            data: part.inlineData.data,
          },
        };
      }
      return null;
    }).filter(Boolean);
    return { role, content };
  });
}

function extractAnthropicText(data: any): string {
  const text = (data?.content || [])
    .map((part: any) => part?.type === "text" ? part.text || "" : "")
    .join("")
    .trim();
  return stripThinkingBlocks(text);
}

async function callOpenAiChat(
  model: string,
  contents: any[],
  generationConfig?: Record<string, any>,
  signal?: AbortSignal,
): Promise<any> {
  const { apiKey, baseUrl } = getProtocolEndpoint("openai");

  if (!apiKey) throw new Error("請先在設定中設定 API Key");

  const timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const request = createManagedRequestSignal(signal, timeoutMs);
  const body: Record<string, any> = {
    model,
    messages: buildOpenAiMessages(contents),
  };
  if (generationConfig?.temperature !== undefined) body.temperature = generationConfig.temperature;
  if (generationConfig?.topP !== undefined) body.top_p = generationConfig.topP;
  if (generationConfig?.maxOutputTokens !== undefined) body.max_tokens = generationConfig.maxOutputTokens;

  try {
    const response = await proxiedFetch(
      buildApiUrl(baseUrl, "openai", "/chat/completions"),
      buildApiHeaders(baseUrl, "openai", apiKey),
      JSON.stringify(body),
      request.signal,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`模型 ${model} 呼叫失敗 (${response.status}): ${text.slice(0, 200)}`);
    }

    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw normalizeGeminiError(error, request.didTimeout(), timeoutMs);
  } finally {
    request.cleanup();
  }
}

async function callOpenAiChatStream(
  model: string,
  contents: any[],
  onChunk: (accumulated: string) => void,
  generationConfig?: Record<string, any>,
  signal?: AbortSignal,
): Promise<string> {
  const { apiKey, baseUrl } = getProtocolEndpoint("openai");

  if (!apiKey) throw new Error("請先在設定中設定 API Key");

  const timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const request = createManagedRequestSignal(signal, timeoutMs);
  const body: Record<string, any> = {
    model,
    stream: true,
    messages: buildOpenAiMessages(contents),
  };
  if (generationConfig?.temperature !== undefined) body.temperature = generationConfig.temperature;
  if (generationConfig?.topP !== undefined) body.top_p = generationConfig.topP;
  if (generationConfig?.maxOutputTokens !== undefined) body.max_tokens = generationConfig.maxOutputTokens;

  try {
    const response = await proxiedFetch(
      buildApiUrl(baseUrl, "openai", "/chat/completions"),
      buildApiHeaders(baseUrl, "openai", apiKey),
      JSON.stringify(body),
      request.signal,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`模型 ${model} 呼叫失敗 (${response.status}): ${text.slice(0, 200)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("瀏覽器不支援流式讀取");

    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const delta = parsed?.choices?.[0]?.delta;
          const chunkText = extractOpenAiDeltaText(delta);
          if (chunkText) {
            accumulated += chunkText;
            onChunk(accumulated);
          }
        } catch {
          /* ignore malformed chunk */
        }
      }
    }

    if (!accumulated.trim()) {
      throw new Error("模型返回了空內容，請稍後重試。");
    }

    return stripThinkingBlocks(accumulated).trim();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw normalizeGeminiError(error, request.didTimeout(), timeoutMs);
  } finally {
    request.cleanup();
  }
}

async function callAnthropicMessages(
  model: string,
  contents: any[],
  generationConfig?: Record<string, any>,
  signal?: AbortSignal,
): Promise<any> {
  const { apiKey, baseUrl } = getProtocolEndpoint("anthropic");

  if (!apiKey) throw new Error("請先在設定中設定 API Key");

  const timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const request = createManagedRequestSignal(signal, timeoutMs);
  const body: Record<string, any> = {
    model,
    max_tokens: generationConfig?.maxOutputTokens ?? 4096,
    messages: buildAnthropicMessages(contents),
  };
  if (generationConfig?.temperature !== undefined) body.temperature = generationConfig.temperature;
  if (generationConfig?.topP !== undefined) body.top_p = generationConfig.topP;

  try {
    const response = await proxiedFetch(
      buildApiUrl(baseUrl, "anthropic", "/messages"),
      buildApiHeaders(baseUrl, "anthropic", apiKey),
      JSON.stringify(body),
      request.signal,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`模型 ${model} 呼叫失敗 (${response.status}): ${text.slice(0, 200)}`);
    }

    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw normalizeGeminiError(error, request.didTimeout(), timeoutMs);
  } finally {
    request.cleanup();
  }
}

/**
 * 直連 fetch（不經過任何代理）
 */
export async function proxiedFetch(
  targetUrl: string,
  targetHeaders: Record<string, string>,
  body?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const config = getApiConfig();
  const MAX_RETRIES = config.retryCount ?? 2;
  const RETRY_DELAY_MS = config.retryDelayMs ?? 3000;

  const headers: Record<string, string> = { ...targetHeaders };
  if (!headers["Content-Type"] && body) {
    headers["Content-Type"] = "application/json";
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (signal?.aborted) throw new Error("請求已取消");
      const resp = await fetch(targetUrl, {
        method: body ? "POST" : "GET",
        headers,
        body,
        signal,
      });
      if (resp.status === 502 && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return resp;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }

  return fetch(targetUrl, { method: body ? "POST" : "GET", headers, body, signal });
}

// ===== Request Building =====

export function buildGeminiRequest(baseUrl: string, path: string, apiKey: string) {
  const headers = buildApiHeaders(baseUrl, "gemini", apiKey);
  const url = buildApiUrl(baseUrl, "gemini", path);
  return { url, headers };
}

export function getGeminiEndpoint() {
  const { apiKey, endpoint } = getApiConfigForProtocol("gemini");
  return {
    apiKey,
    baseUrl: endpoint || DEFAULT_GEMINI_BASE_URL,
  };
}

export function getProtocolEndpoint(protocol: ApiProtocol) {
  const { apiKey, endpoint } = getApiConfigForProtocol(protocol);
  return {
    apiKey,
    baseUrl: endpoint || DEFAULT_GEMINI_BASE_URL,
  };
}

// ===== Core API Call =====

function getGeminiEndpointForModel(model: { modelId: string; protocol?: string } | string) {
  if (typeof model === "object" && model?.protocol === "gemini-text") {
    const { apiKey, endpoint } = getRuntimeApiConfigForProtocol("gemini-text");
    return { apiKey, baseUrl: endpoint || DEFAULT_GEMINI_BASE_URL };
  }
  return getGeminiEndpoint();
}

export async function callGemini(
  model: string,
  contents: any[],
  generationConfig?: Record<string, any>,
  signal?: AbortSignal,
): Promise<any> {
  const resolvedModel = resolveTextModelMapping(model, getApiConfig().modelMappings);
  const apiProtocol = getResolvedTextModelApiProtocol(resolvedModel);
  const apiModel = resolvedModel.modelId;

  if (apiProtocol === "openai") {
    return callOpenAiChat(apiModel, contents, generationConfig, signal);
  }
  if (apiProtocol === "anthropic") {
    return callAnthropicMessages(apiModel, contents, generationConfig, signal);
  }

  const { apiKey, baseUrl } = getGeminiEndpointForModel(resolvedModel);

  if (!apiKey) throw new Error("請先在設定中設定 API Key");

  const { url, headers } = buildGeminiRequest(baseUrl, `/models/${apiModel}:generateContent`, apiKey);
  const body: any = { contents };
  if (generationConfig && Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  const jsonBody = JSON.stringify(body);
  const timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const request = createManagedRequestSignal(signal, timeoutMs);

  try {
    if (signal?.aborted) throw new Error("請求已取消");

    const response = await proxiedFetch(url, headers, jsonBody, request.signal);

    if (response.ok) {
      const data = await response.json();
      // 部分閘道器仍返回 200 但 body 內含 error
      const errMsg = data?.error?.message ?? (typeof data?.error === "string" ? data.error : null);
      if (errMsg) {
        throw new Error(String(errMsg));
      }
      return data;
    }

    const text = await response.text().catch(() => "");
    throw new Error(`模型 ${apiModel} 呼叫失敗 (${response.status}): ${text.slice(0, 200)}`);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw normalizeGeminiError(error, request.didTimeout(), timeoutMs);
  } finally {
    request.cleanup();
  }
}

export function isTextModelFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed\s*out|AbortError|aborted|request.*(?:time|timeout)|請求超時|请求超时|超時|超时|瓒呮檪/i.test(message)) {
    return true;
  }
  return /402|429|503|502|504|upstream|overload|overloaded|insufficient.*(?:balance|credit|quota)|quota.*exceeded|payment required|余额不足|餘額不足|额度不足|額度不足|饱和|飽和|繁忙|稍后再试|稍後再試|No available channel|no available distributor|model_not_found|MAX_TOKENS|返回空|空内容|空內容|未返回|模型 .*呼叫失敗/i.test(message);
}

export async function callTextUnderstandingModelWithFallback(
  primaryModel: string,
  contents: any[],
  generationConfig?: Record<string, any>,
  signal?: AbortSignal,
  options?: {
    isUsableResponse?: (data: any) => boolean;
    isRetryableError?: (error: unknown) => boolean;
    onFallback?: (event: { from: string; to: string; error: string }) => void;
    attemptTimeoutMs?: number | ((args: { model: string; index: number; total: number }) => number);
  },
): Promise<{ model: string; data: any }> {
  const models = getTextUnderstandingModelFallbacks(primaryModel);
  let lastError: unknown;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    try {
      const configuredAttemptTimeoutMs = typeof options?.attemptTimeoutMs === "function"
        ? options.attemptTimeoutMs({ model, index, total: models.length })
        : options?.attemptTimeoutMs;
      const attemptSignal = configuredAttemptTimeoutMs
        ? (signal ? AbortSignal.any([signal, AbortSignal.timeout(configuredAttemptTimeoutMs)]) : AbortSignal.timeout(configuredAttemptTimeoutMs))
        : signal;
      const data = await callGemini(model, contents, generationConfig, attemptSignal);
      if (!options?.isUsableResponse || options.isUsableResponse(data)) {
        return { model, data };
      }
      lastError = new Error(explainGeminiNoText(data) || `${model} 返回空内容`);
    } catch (error) {
      lastError = error;
    }

    if (signal?.aborted) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    const retryable = options?.isRetryableError
      ? options.isRetryableError(lastError)
      : isTextModelFallbackError(lastError);
    const next = models[index + 1];
    if (!retryable || !next) break;
    options?.onFallback?.({
      from: model,
      to: next,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 當 extractText 為空時，從原始響應推斷原因（安全攔截、僅 thought 等） */
export function explainGeminiNoText(data: unknown): string | null {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return null;

  const err = d.error as { message?: string } | string | undefined;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && err.message) return String(err.message);

  const pf = d.promptFeedback as { blockReason?: string; blockReasonMessage?: string } | undefined;
  if (pf?.blockReason) {
    const extra = pf.blockReasonMessage ? `（${pf.blockReasonMessage}）` : "";
    return `請求未生成正文：內容審核 ${pf.blockReason}${extra}`;
  }

  const cand = (d.candidates as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
  if (!cand) {
    return "模型未返回候選結果，可能被安全策略攔截或閘道器截斷了響應。";
  }

  const fr = cand.finishReason as string | undefined;
  if (fr && fr !== "STOP" && fr !== "FINISH_REASON_STOP") {
    const frMap: Record<string, string> = {
      SAFETY: "因安全策略未輸出文字，請換一張參考圖或簡化畫面內容後重試。",
      RECITATION: "因模型版權引用限制未輸出文字。",
      MAX_TOKENS: "輸出被長度限制截斷，請重試。",
      OTHER: "模型提前結束（OTHER），請稍後重試。",
    };
    return frMap[fr] ?? `模型結束原因：${fr}`;
  }

  const parts = (cand.content as { parts?: unknown[] } | undefined)?.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    const onlyThought = parts.every((p: unknown) => (p as { thought?: boolean }).thought === true);
    if (onlyThought) {
      return "模型只返回了內部推理，沒有可見文字。請稍後重試，或檢查閘道器是否支援目前模型。";
    }
  }

  return null;
}

/**
 * Streaming version of callGemini — calls streamGenerateContent and invokes
 * onChunk with the accumulated text after each SSE event.
 * Returns the final complete text.
 */
export async function callGeminiStream(
  model: string,
  contents: any[],
  onChunk: (accumulated: string) => void,
  generationConfig?: Record<string, any>,
  signal?: AbortSignal,
): Promise<string> {
  const resolvedModel = resolveTextModelMapping(model, getApiConfig().modelMappings);
  const apiProtocol = getResolvedTextModelApiProtocol(resolvedModel);
  const apiModel = resolvedModel.modelId;

  if (apiProtocol === "openai") {
    return callOpenAiChatStream(apiModel, contents, onChunk, generationConfig, signal);
  }
  if (apiProtocol === "anthropic") {
    const data = await callAnthropicMessages(apiModel, contents, generationConfig, signal);
    const text = extractAnthropicText(data);
    if (!text) throw new Error("模型返回了空內容，請稍後重試。");
    onChunk(text);
    return text;
  }

  const { apiKey, baseUrl } = getGeminiEndpointForModel(resolvedModel);

  if (!apiKey) throw new Error("請先在設定中設定 API Key");

  const { url, headers } = buildGeminiRequest(
    baseUrl,
    `/models/${apiModel}:streamGenerateContent?alt=sse`,
    apiKey,
  );
  const body: any = { contents };
  if (generationConfig && Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  const timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  const request = createManagedRequestSignal(signal, timeoutMs);

  try {
    if (signal?.aborted) throw new Error("請求已取消");

    const response = await proxiedFetch(url, headers, JSON.stringify(body), request.signal);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`模型 ${apiModel} 呼叫失敗 (${response.status}): ${text.slice(0, 200)}`);
    }

    // Some proxies return plain JSON instead of SSE — detect and handle both
    const contentType = response.headers.get("content-type") || "";
    const isSSE = contentType.includes("text/event-stream");

    if (!isSSE) {
      // Non-streaming response: parse as regular JSON
      const data = await response.json().catch(() => null);
      const text = extractText(data);
      if (text) { onChunk(text); return text; }
      const noTextReason = explainGeminiNoText(data) ?? "模型返回了空內容，請稍後重試。";
      throw new Error(noTextReason);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("瀏覽器不支援流式讀取");

    const decoder = new TextDecoder();
    let accumulated = "";
    let buffer = "";
    let rawBuffer = ""; // keep full raw content for fallback

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any remaining content in buffer
        if (buffer.trim()) {
          const line = buffer.trim();
          if (line.startsWith("data: ")) {
            const jsonStr = line.slice(6).trim();
            if (jsonStr && jsonStr !== "[DONE]") {
              try {
                const parsed = JSON.parse(jsonStr);
                const parts = parsed?.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                  if (!part.thought && part.text) { accumulated += part.text; onChunk(accumulated); }
                }
              } catch { /* ignore */ }
            }
          }
        }
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      rawBuffer += chunk;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const parts = parsed?.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.thought) continue;
            if (part.text) { accumulated += part.text; onChunk(accumulated); }
          }
        } catch { /* skip malformed JSON */ }
      }
    }

    // Fallback: if SSE parsing yielded nothing, try parsing the raw body as plain JSON
    // (some proxies return generateContent response instead of SSE stream)
    if (!accumulated && rawBuffer.trim()) {
      try {
        const data = JSON.parse(rawBuffer.trim());
        const text = extractText(data);
        if (text) { onChunk(text); return text; }
        const reason = explainGeminiNoText(data);
        if (reason) throw new Error(reason);
      } catch (e: any) {
        if (e?.message && !e.message.includes("JSON")) throw e;
        // not valid JSON either, fall through
      }
    }

    if (!accumulated) {
      // Last resort: try the raw buffer as a concatenated JSON array or newline-delimited JSON
      const lines = rawBuffer.split("\n").filter(l => l.trim());
      for (const line of lines) {
        const jsonStr = line.startsWith("data: ") ? line.slice(6).trim() : line.trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const parts = parsed?.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (!part.thought && part.text) accumulated += part.text;
          }
        } catch { /* ignore */ }
      }
      if (accumulated) { onChunk(accumulated); return accumulated.trim(); }
      throw new Error("模型返回了空內容，請稍後重試。");
    }

    return stripThinkingBlocks(accumulated).trim();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw normalizeGeminiError(error, request.didTimeout(), timeoutMs);
  } finally {
    request.cleanup();
  }
}

// ===== Response Parsing =====

/** Strip <think>...</think> blocks that some models emit inline */
function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export function extractText(data: any): string {
  if (typeof data === "string") {
    return stripThinkingBlocks(data.trim());
  }
  const openAiMessageText = extractOpenAiTextContent(data?.choices?.[0]?.message?.content);
  if (openAiMessageText.trim()) {
    return stripThinkingBlocks(openAiMessageText.trim());
  }
  const anthropicText = extractAnthropicText(data);
  if (anthropicText.trim()) {
    return anthropicText;
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const raw = parts
    .filter((p: any) => !p.thought)
    .map((p: any) => p.text || "")
    .join("")
    .trim();
  return stripThinkingBlocks(raw);
}

export async function extractImageBase64(data: any): Promise<{ base64: string; mimeType: string } | null> {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts) return null;

  // Try inlineData first
  for (const part of parts) {
    if (part.inlineData) {
      return { base64: part.inlineData.data, mimeType: part.inlineData.mimeType || "image/png" };
    }
  }

  // Fallback: fileData
  for (const part of parts) {
    if (part.fileData?.fileUri) {
      const result = await fetchImageAsBase64(part.fileData.fileUri);
      if (result) return { base64: result.data, mimeType: result.mimeType };
    }
  }

  // Fallback: URL in text
  for (const part of parts) {
    if (part.text) {
      const mdMatch = part.text.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/);
      const urlMatch = mdMatch?.[1] || part.text.match(/(https?:\/\/\S+\.(?:png|jpg|jpeg|webp|gif))/i)?.[1];
      if (urlMatch) {
        const result = await fetchImageAsBase64(urlMatch);
        if (result) return { base64: result.data, mimeType: result.mimeType };
      }
    }
  }

  return null;
}

// ===== Image Utilities =====

export async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const maybeBustCache = (inputUrl: string) => {
      if (!/\/api\/agent\/pad\/screenshot/i.test(inputUrl)) return inputUrl;
      try {
        const parsed = new URL(inputUrl);
        if (parsed.searchParams.has("sign")) return inputUrl;
        parsed.searchParams.set("_ts", String(Date.now()));
        return parsed.toString();
      } catch {
        return inputUrl;
      }
    };

    const requestUrl = maybeBustCache(url);
    const electronImageProxy = typeof window !== "undefined"
      ? ((window as any).electronAPI?.image?.proxy as
        | ((args: { url: string; referer?: string }) => Promise<{ ok?: boolean; dataUrl?: string }>)
        | undefined)
      : undefined;

    // In Electron, prefer the main-process proxy to avoid renderer-side CORS
    // issues on signed media links.
    if (electronImageProxy && requestUrl.startsWith("http")) {
      const proxied = await electronImageProxy({ url: requestUrl, referer: requestUrl });
      if (proxied?.ok && proxied.dataUrl) {
        const match = proxied.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          return { mimeType: match[1], data: match[2] };
        }
      }
    }

    const config = getApiConfig();
    // Use proxy for HTTP URLs to avoid mixed content issues (unless direct mode)
    const needsProxy = !config.directMode && requestUrl.startsWith("http://");
    const resp = needsProxy
      ? await proxiedFetch(requestUrl, {}, undefined)
      : await fetch(requestUrl);
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const base64 = btoa(binary);
    const contentType = resp.headers.get("content-type") || "image/png";
    return { mimeType: contentType.split(";")[0], data: base64 };
  } catch {
    return null;
  }
}

export async function getInlineData(imageUrl: unknown): Promise<{ mimeType: string; data: string } | null> {
  if (typeof imageUrl !== "string") return null;
  if (imageUrl.startsWith("data:")) {
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;
    return { mimeType: match[1], data: match[2] };
  }
  if (imageUrl.startsWith("http")) {
    return fetchImageAsBase64(imageUrl);
  }
  return null;
}

// ===== Storage Upload =====

export async function uploadImageToStorage(base64: string, mimeType: string, folder: string): Promise<string> {
  const ext = mimeType.includes("png") ? "png" : "jpg";
  const fileName = `${folder}/${crypto.randomUUID()}.${ext}`;

  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const { error } = await supabase.storage
    .from("generated-images")
    .upload(fileName, bytes, { contentType: mimeType, upsert: false });

  if (error) throw new Error(`圖片上傳失敗: ${error.message}`);

  const { data } = supabase.storage.from("generated-images").getPublicUrl(fileName);
  return data.publicUrl;
}

/** Upload a File object directly to storage */
export async function uploadFileToStorage(file: File, folder: string): Promise<string> {
  const ext = file.name.split(".").pop() || "png";
  const fileName = `${folder}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from("generated-images")
    .upload(fileName, file, { contentType: file.type, upsert: false });

  if (error) throw new Error(`圖片上傳失敗: ${error.message}`);

  const { data } = supabase.storage.from("generated-images").getPublicUrl(fileName);
  return data.publicUrl;
}

export async function callOpenAiImageGeneration(
  prompt: string,
  options: { model?: string; size?: string; image?: string[]; signal?: AbortSignal } = {},
): Promise<{ base64: string; mimeType: string }> {
  const { apiKey, baseUrl: endpoint } = getProtocolEndpoint("openai");
  if (!apiKey) throw new Error("GPT API Key 未設定，請在設定中設定");

  const payload: any = {
    model: options.model || "gpt-image-2",
    prompt,
    size: options.size || "1024x1024",
  };

  if (options.image && options.image.length > 0) {
    const processedImages: string[] = [];
    for (const img of options.image) {
      if (img.startsWith("data:")) {
        processedImages.push(img);
      } else {
        const fetched = await fetchImageAsBase64(img).catch(() => null);
        if (fetched) {
          processedImages.push(`data:${fetched.mimeType};base64,${fetched.data}`);
        }
      }
    }
    if (processedImages.length > 0) {
      payload.image = processedImages;
    }
  }

  const resp = await proxiedFetch(
    buildApiUrl(endpoint, "openai", "/images/generations"),
    buildApiHeaders(endpoint, "openai", apiKey),
    JSON.stringify(payload),
    options.signal,
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`GPT 圖片生成失敗 (${resp.status}): ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const imgItem = data.data?.[0];
  if (imgItem?.b64_json) {
    return { base64: imgItem.b64_json, mimeType: "image/png" };
  }
  if (imgItem?.url) {
    const imgResp = await proxiedFetch(imgItem.url, {});
    if (!imgResp.ok) throw new Error("GPT 圖片下載失敗");
    const buf = await imgResp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const ct = imgResp.headers.get("content-type") || "";
    return { base64: btoa(binary), mimeType: ct.includes("png") ? "image/png" : "image/jpeg" };
  }
  throw new Error("GPT 圖片模型未返回圖片");
}

// ===== Style Maps =====

export const CHAR_STYLE_MAP: Record<string, string> = {
  "live-action": "Photorealistic live-action cinematography. Shot on high-end cinema camera (ARRI Alexa / RED V-Raptor). Cinematic lighting with motivated key light, soft fill, and subtle rim light. Film-grade color grading with natural skin tones, accurate subsurface scattering on skin, pore-level detail, real fabric weave and stitching on clothing. Shallow depth of field with anamorphic bokeh. No post-processing glow or bloom. The image must look indistinguishable from a real film still.",
  "hyper-cg": "Hyper-realistic CG render at AAA game cinematic quality (Unreal Engine 5 / Nanite-level detail). Physically-based rendering (PBR) with ray-traced global illumination, accurate subsurface scattering on skin, micro-detail normal maps on all surfaces. Ultra-high polygon count with no visible faceting. Realistic hair strand simulation, cloth physics folds, and specular response on metals and wet surfaces. Studio-quality three-point lighting setup with HDRI environment reflections.",
  "3d-cartoon": "3D cartoon animation style matching Pixar / Disney / Illumination feature-film quality. Smooth subdivided surfaces with appealing stylized proportions (slightly oversized head, expressive eyes). Soft volumetric ambient occlusion, subsurface scattering on skin for a warm translucent feel. Rim lighting for silhouette readability. Rich saturated color palette with complementary accent colors. Clean topology with no artifacts. The character should feel like a frame from a theatrical animated feature.",
  "2.5d-stylized": "2.5D stylized illustration blending hand-painted 2D textures over 3D geometry, inspired by Spider-Man: Into the Spider-Verse and Arcane: League of Legends. Visible artistic brushstrokes, Ben-Day dots, and cross-hatching layered on top of three-dimensional forms. Graphic novel panel aesthetic with strong ink outlines of varying weight. Limited but bold color palette with intentional color holds on linework. Slight printing misregistration effect. Mixed frame-rate feel captured in a still image.",
  "anime-3d": "3D cel-shaded anime style inspired by Genshin Impact, Honkai: Star Rail, and Guilty Gear Strive. Hard-edge toon shading with exactly 2-3 shadow steps and no smooth gradients. Crisp black outlines of uniform weight rendered over clean 3D geometry. Anime-proportioned facial features: large luminous eyes with detailed iris highlights, small nose and mouth. Vibrant highly-saturated color palette. Specular highlights rendered as sharp geometric shapes. Hair rendered as stylized chunky planes with clear silhouette.",
  "cel-animation": "Traditional 2D hand-drawn cel animation style evoking classic Disney Renaissance, Studio Ghibli, and golden-age theatrical shorts. Crisp confident ink lineart with consistent line weight and occasional taper. Large areas of flat solid color fills with no gradients. Shadow rendered as a single flat darker tone with a razor-sharp terminator line (no soft falloff). Highlight as a single lighter shape. Clean negative space. Slight paper-texture grain overlay. The image should feel like a hand-inked and hand-painted animation cel photographed on a rostrum camera.",
  "retro-comic": "Vintage American comic book style evoking 1960s-1970s Marvel / DC print era and pulp illustration. Bold, confident ink outlines with dramatic thick-to-thin brush strokes. High-contrast flat color blocks using a limited CMYK print palette. Mechanical halftone Ben-Day dot patterns for all mid-tones, shadows, and gradients (visible dot grid, not smooth). Slight ink bleed and paper yellowing. Strong chiaroscuro lighting with deep black shadows. Dynamic poses with foreshortening. Speech-balloon-ready composition. The image must feel like a freshly printed newsprint comic page.",
};

export const SCENE_STYLE_MAP: Record<string, string> = {
  "live-action": "Photorealistic live-action cinematography of an environment / location. Shot on high-end cinema camera with cinematic lighting, motivated practical light sources, film-grade color grading, real-world material textures (concrete, wood, metal, fabric), atmospheric haze and depth fog, shallow depth of field with anamorphic bokeh. The image must look indistinguishable from a real film location scout photograph.",
  "hyper-cg": "Hyper-realistic CG environment render at AAA game cinematic quality (Unreal Engine 5 / Nanite-level). Physically-based rendering with ray-traced global illumination, accurate material PBR responses, volumetric fog and god rays, ultra-detailed environment props with micro-surface detail. HDRI sky lighting with realistic time-of-day atmosphere. No visible LOD pop-in or texture stretching.",
  "3d-cartoon": "3D cartoon environment matching Pixar / Disney / Illumination feature-film quality. Stylized but detailed world-building with appealing shape language (rounded edges, exaggerated proportions). Soft volumetric lighting with warm ambient occlusion. Rich saturated color palette with clear color storytelling. Clean modular set design that feels like a miniature stage set brought to life.",
  "2.5d-stylized": "2.5D stylized environment illustration blending hand-painted 2D textures over 3D geometry, inspired by Spider-Man: Into the Spider-Verse and Arcane: League of Legends. Visible artistic brushstrokes and cross-hatching on architectural surfaces. Graphic novel aesthetic with strong ink outlines of varying weight. Bold limited color palette with intentional color holds. Slight printing misregistration effect. Atmospheric depth achieved through layered parallax planes.",
  "anime-3d": "3D cel-shaded anime environment inspired by Genshin Impact and Honkai: Star Rail open-world landscapes. Hard-edge toon shading with 2-3 shadow steps on all surfaces. Clean outlines on major architectural forms. Vibrant highly-saturated color palette with stylized foliage and sky. Specular highlights as sharp geometric shapes on water and metal. Anime-style clouds and atmospheric perspective.",
  "cel-animation": "Traditional 2D hand-painted background art in the style of classic Disney, Studio Ghibli, and golden-age animation. Lush painterly environment with visible gouache / watercolor brushwork. Flat perspective with subtle depth layering for multiplane camera effect. Warm natural color palette with soft atmospheric gradients in sky and distance. No lineart on backgrounds — shapes defined by color and value changes. Slight paper-texture grain overlay.",
  "retro-comic": "Vintage American comic book environment evoking 1960s-1970s Marvel / DC print era. Bold ink outlines on architecture and props with dramatic thick-to-thin brushwork. High-contrast flat color blocks using limited CMYK palette. Mechanical halftone Ben-Day dot patterns for skies, shadows, and gradients. Slight ink bleed and paper yellowing. Strong chiaroscuro lighting with deep black shadow areas. The environment must feel like a freshly printed comic panel background.",
};

export const STORYBOARD_STYLE_MAP: Record<string, string> = {
  "live-action": "Photorealistic cinematic storyboard frame. Shot on high-end cinema camera (ARRI Alexa / RED V-Raptor). Cinematic lighting with motivated key light, soft fill, and subtle rim light. Film-grade color grading with natural skin tones, accurate subsurface scattering on skin, pore-level detail. Shallow depth of field with anamorphic bokeh. No post-processing glow or bloom. The image must look indistinguishable from a real film still.",
  "hyper-cg": "Hyper-realistic CG storyboard frame at AAA game cinematic quality (Unreal Engine 5 / Nanite-level). Physically-based rendering with ray-traced global illumination, accurate subsurface scattering on skin, micro-detail normal maps. Ultra-high polygon count with no visible faceting. Realistic hair strand simulation and cloth physics. Studio-quality three-point lighting setup with HDRI environment reflections.",
  "3d-cartoon": "3D cartoon storyboard frame matching Pixar / Disney / Illumination feature-film quality. Smooth subdivided surfaces with appealing stylized proportions. Soft volumetric ambient occlusion, subsurface scattering on skin. Rim lighting for silhouette readability. Rich saturated color palette. Clean composition — feels like a frame from a theatrical animated feature.",
  "2.5d-stylized": "2.5D stylized storyboard illustration blending hand-painted 2D textures over 3D geometry, inspired by Spider-Man: Into the Spider-Verse and Arcane. Visible artistic brushstrokes, Ben-Day dots, and cross-hatching. Graphic novel panel aesthetic with strong ink outlines. Limited bold color palette with intentional color holds. Slight printing misregistration effect.",
  "anime-3d": "3D cel-shaded anime storyboard inspired by Genshin Impact and Honkai: Star Rail. Hard-edge toon shading with 2-3 shadow steps. Crisp black outlines of uniform weight. Anime-proportioned facial features. Vibrant highly-saturated color palette. Specular highlights as sharp geometric shapes.",
  "cel-animation": "Traditional 2D hand-drawn cel animation storyboard evoking classic Disney and Studio Ghibli. Crisp ink lineart with consistent line weight. Large areas of flat solid color fills with no gradients. Shadow rendered as a single flat darker tone. Clean negative space. Slight paper-texture grain overlay.",
  "retro-comic": "Vintage American comic book storyboard evoking 1960s-1970s Marvel / DC era. Bold confident ink outlines with dramatic brush strokes. High-contrast flat color blocks using limited CMYK palette. Mechanical halftone Ben-Day dot patterns. Slight ink bleed and paper yellowing. Strong chiaroscuro lighting.",
};
