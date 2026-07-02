import { fetchWithProxy, formatBridgeFetchError } from "../../../lib/bridge/proxy-utils.js";

function cleanProxyUrl(proxyUrl) {
  return String(proxyUrl || "").trim();
}

function formatRawError(err) {
  const seen = new Set();
  const parts = [];
  let current = err;
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = current.code ? `${current.code}: ` : "";
    const message = current.message ? String(current.message) : String(current);
    if (message) parts.push(`${code}${message}`);
    current = current.cause;
  }
  return [...new Set(parts)].join(" | ") || String(err);
}

export function fetchPublicSource(url, init = {}, proxyUrl = "") {
  const effectiveProxy = cleanProxyUrl(proxyUrl);
  if (!effectiveProxy) return globalThis.fetch(url, init);
  return fetchWithProxy(url, init, effectiveProxy);
}

export function formatSourceError(err, proxyUrl = "") {
  const effectiveProxy = cleanProxyUrl(proxyUrl);
  const raw = effectiveProxy ? formatBridgeFetchError(err, effectiveProxy) : formatRawError(err);
  const lower = raw.toLowerCase();
  if (
    lower.includes("econnreset")
    || lower.includes("client network socket disconnected")
    || lower.includes("socket disconnected")
    || lower.includes("tls connection was established")
  ) {
    return effectiveProxy
      ? `代理連線被中斷：${effectiveProxy}。請確認代理軟體正在運行，或關閉輿情搜索代理。`
      : "來源連線被中斷，請稍後重試";
  }
  if (
    lower.includes("aborted due to timeout")
    || lower.includes("the operation was aborted")
    || lower.includes("und_err_connect_timeout")
    || lower.includes("connect timeout")
  ) {
    return "請求超時，請確認網路或代理設定";
  }
  return raw;
}

export function httpFailure(res) {
  return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
}

export function scraperResult(inserted, failures = []) {
  return {
    inserted: Number(inserted || 0),
    failures: Array.isArray(failures) ? failures : [],
  };
}
