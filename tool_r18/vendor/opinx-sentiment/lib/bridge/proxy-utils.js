import { ProxyAgent as NodeProxyAgent } from "proxy-agent";
import { ProxyAgent as UndiciProxyAgent } from "undici";

const fetchProxyAgents = new Map();

export function getBridgeProxyUrl(proxyUrl) {
  return String(
    proxyUrl
    || process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.ALL_PROXY
    || "",
  ).trim();
}

export function createFetchInitWithProxy(init = {}, proxyUrl) {
  const effectiveProxy = getBridgeProxyUrl(proxyUrl);
  if (!effectiveProxy) return init;
  if (!fetchProxyAgents.has(effectiveProxy)) {
    fetchProxyAgents.set(effectiveProxy, new UndiciProxyAgent(effectiveProxy));
  }
  return {
    ...init,
    dispatcher: fetchProxyAgents.get(effectiveProxy),
  };
}

export function fetchWithProxy(url, init = {}, proxyUrl) {
  return fetch(url, createFetchInitWithProxy(init, proxyUrl));
}

function collectErrorChain(err) {
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
  return [...new Set(parts)];
}

export function formatBridgeFetchError(err, proxyUrl = "") {
  const parts = collectErrorChain(err);
  const raw = parts.join(" | ") || String(err);
  const effectiveProxy = getBridgeProxyUrl(proxyUrl);
  const lower = raw.toLowerCase();

  if (effectiveProxy) {
    if (
      lower.includes("econnrefused")
      || lower.includes("proxy connection ended")
      || lower.includes("proxy connect")
    ) {
      return `代理地址无法连接：${effectiveProxy}。请确认代理软件已开启，且 HTTP/Mixed 端口是这个地址。原始错误：${raw}`;
    }
    if (lower.includes("etimedout") || lower.includes("connect timeout") || lower.includes("headers timeout")) {
      return `代理连接超时：${effectiveProxy}。请确认代理软件正在运行，或换成当前可用的 HTTP/Mixed 端口。原始错误：${raw}`;
    }
    if (lower.includes("enotfound") || lower.includes("eai_again")) {
      return `通过代理解析目标地址失败：${effectiveProxy}。请检查代理是否可联网。原始错误：${raw}`;
    }
    return `通过代理请求失败：${effectiveProxy}。原始错误：${raw}`;
  }

  return raw;
}

export function createNodeProxyAgent(proxyUrl) {
  const effectiveProxy = getBridgeProxyUrl(proxyUrl);
  if (!effectiveProxy) return null;
  return new NodeProxyAgent({ getProxyForUrl: () => effectiveProxy });
}

export function createProxyHttpInstance(baseHttpInstance, nodeProxyAgent) {
  if (!nodeProxyAgent) return null;
  const withAgent = (opts = {}) => ({
    ...opts,
    proxy: false,
    httpAgent: nodeProxyAgent,
    httpsAgent: nodeProxyAgent,
  });

  return {
    request: (opts) => baseHttpInstance.request(withAgent(opts)),
    get: (url, opts) => baseHttpInstance.get(url, withAgent(opts)),
    delete: (url, opts) => baseHttpInstance.delete(url, withAgent(opts)),
    head: (url, opts) => baseHttpInstance.head(url, withAgent(opts)),
    options: (url, opts) => baseHttpInstance.options(url, withAgent(opts)),
    post: (url, data, opts) => baseHttpInstance.post(url, data, withAgent(opts)),
    put: (url, data, opts) => baseHttpInstance.put(url, data, withAgent(opts)),
    patch: (url, data, opts) => baseHttpInstance.patch(url, data, withAgent(opts)),
  };
}
