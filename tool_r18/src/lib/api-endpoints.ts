export type ApiProtocol = "gemini" | "openai" | "anthropic";

export const DEFAULT_API_BASE_URL = "http://202.90.21.53:3008";

function withScheme(raw: string): string {
  const value = raw.trim() || DEFAULT_API_BASE_URL;
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

function cleanUrl(raw: string): URL {
  const url = new URL(withScheme(raw));
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function setPath(url: URL, path: string): string {
  url.pathname = path || "";
  return url.toString().replace(/\/+$/, "");
}

function stripCommonEndpointPath(pathname: string): string {
  let path = pathname.replace(/\/+$/, "");
  path = path.replace(/\/v1beta\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/i, "/v1beta");
  path = path.replace(/\/v1\/(?:chat\/completions|responses|images\/generations?)$/i, "/v1");
  path = path.replace(/\/v1\/messages$/i, "/v1");
  path = path.replace(/\/(?:v1beta|v1)\/models$/i, (match) => match.replace(/\/models$/i, ""));
  path = path.replace(/\/chat\/completions$/i, "");
  path = path.replace(/\/messages$/i, "");
  return path.replace(/\/+$/, "");
}

function appendVersion(pathname: string, version: "v1beta" | "v1"): string {
  const stripped = stripCommonEndpointPath(pathname);
  if (version === "v1beta") {
    if (/\/v1beta$/i.test(stripped)) return stripped;
    if (/\/v1$/i.test(stripped)) return stripped.replace(/\/v1$/i, "/v1beta");
    return `${stripped}/${version}`.replace(/^\/?/, "/");
  }
  if (/\/v1$/i.test(stripped)) return stripped;
  if (/\/v1beta$/i.test(stripped)) return stripped.replace(/\/v1beta$/i, "/v1");
  return `${stripped}/${version}`.replace(/^\/?/, "/");
}

export function normalizeApiEndpointInput(raw: string, fallback = DEFAULT_API_BASE_URL): string {
  try {
    return cleanUrl(raw || fallback).toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

export function getApiBaseUrl(raw: string, protocol: ApiProtocol): string {
  const url = cleanUrl(raw || DEFAULT_API_BASE_URL);
  if (protocol === "gemini") {
    return setPath(url, appendVersion(url.pathname, "v1beta"));
  }
  return setPath(url, appendVersion(url.pathname, "v1"));
}

export function joinApiPath(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  let suffix = path.startsWith("/") ? path : `/${path}`;
  try {
    const basePath = new URL(base).pathname;
    if (/\/v1(?:beta)?$/i.test(basePath) && /^\/v1(?:beta)?\//i.test(suffix)) {
      suffix = suffix.replace(/^\/v1(?:beta)?/i, "");
    }
  } catch {
    /* keep suffix as-is */
  }
  return `${base}${suffix}`;
}

export function buildApiUrl(raw: string, protocol: ApiProtocol, path: string): string {
  return joinApiPath(getApiBaseUrl(raw, protocol), path);
}

export function getApiKeyHeaderIssue(apiKey: string): string | null {
  const trimmed = String(apiKey || "").trim();
  if (!trimmed) return null;
  if (/^[•●·*]+$/.test(trimmed)) {
    return "目前 API Key 是隱藏佔位符，請在這台電腦輸入真實 API Key 後儲存";
  }
  if (/[\r\n]/.test(apiKey)) {
    return "API Key 不能包含換行，請重新貼上真實 API Key";
  }
  if (/[\u0100-\uFFFF]/.test(trimmed)) {
    return "API Key 含有中文、全形或特殊字元，請檢查是否複製了隱藏佔位符";
  }
  if ([...trimmed].some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127;
  })) {
    return "API Key 含有不可見控制字元，請重新貼上真實 API Key";
  }
  return null;
}

export function normalizeApiKeyForHeader(apiKey: string): string {
  const issue = getApiKeyHeaderIssue(apiKey);
  if (issue) throw new Error(issue);
  return String(apiKey || "").trim();
}

export function buildApiHeaders(raw: string, protocol: ApiProtocol, apiKey: string): Record<string, string> {
  const baseUrl = getApiBaseUrl(raw, protocol);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const safeApiKey = normalizeApiKeyForHeader(apiKey);
  if (!safeApiKey) return headers;

  if (protocol === "gemini" && baseUrl.includes("generativelanguage.googleapis.com")) {
    headers["x-goog-api-key"] = safeApiKey;
  } else if (protocol === "anthropic" && baseUrl.includes("anthropic.com")) {
    headers["x-api-key"] = safeApiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${safeApiKey}`;
    if (protocol === "anthropic") {
      headers["x-api-key"] = safeApiKey;
      headers["anthropic-version"] = "2023-06-01";
    }
  }
  return headers;
}

export function getModelListCandidates(raw: string, apiKey: string) {
  return [
    {
      protocol: "gemini" as const,
      label: "Gemini",
      url: buildApiUrl(raw, "gemini", "/models"),
      headers: buildApiHeaders(raw, "gemini", apiKey),
    },
    {
      protocol: "openai" as const,
      label: "OpenAI",
      url: buildApiUrl(raw, "openai", "/models"),
      headers: buildApiHeaders(raw, "openai", apiKey),
    },
    {
      protocol: "anthropic" as const,
      label: "Anthropic",
      url: buildApiUrl(raw, "anthropic", "/models"),
      headers: buildApiHeaders(raw, "anthropic", apiKey),
    },
  ];
}
