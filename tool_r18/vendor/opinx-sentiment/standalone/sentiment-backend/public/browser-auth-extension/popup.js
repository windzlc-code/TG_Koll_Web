const $ = (id) => document.getElementById(id);
const DEFAULT_API_BASE = "";
const LOCAL_API_BASE_CANDIDATES = [
  "http://127.0.0.1:8001",
  "http://localhost:8001",
  "http://127.0.0.1:8003",
  "http://localhost:8003",
  "http://127.0.0.1:8000",
  "http://localhost:8000",
];

function setStatus(message) {
  $("status").textContent = message;
}

function friendlyError(message) {
  const text = String(message || "").trim();
  if (/failed to fetch|networkerror|load failed/i.test(text)) {
    return "连接后端失败。请确认后端地址正确，或从安装说明加载固定助手目录。";
  }
  if (/invalid browser auth token|403/i.test(text)) {
    return "授权校验已自动刷新，请重新点击同步。";
  }
  return text || "操作失败";
}

function displayApiBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isLocalApiBase(value) {
  const normalized = displayApiBase(value).toLowerCase();
  if (!normalized) return false;
  if (LOCAL_API_BASE_CANDIDATES.map(displayApiBase).includes(normalized)) return true;
  try {
    return ["127.0.0.1", "localhost", "::1"].includes(new URL(normalized).hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function activeTabApiBase() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || "");
    if (!/^https?:$/.test(url.protocol)) return "";
    const path = `${url.pathname}${url.hash || ""}`;
    if (!/(^|\/)(admin|admin\.html|console|console\.html|browser-auth-extension)(\/|\.|#|$)/.test(path)) {
      return "";
    }
    return displayApiBase(url.origin);
  } catch {
    return "";
  }
}

async function preferredApiBase(storedValue, storedSource = "") {
  const stored = displayApiBase(storedValue);
  const injected = displayApiBase(DEFAULT_API_BASE);
  const active = await activeTabApiBase();
  if (active) return active;
  if (storedSource === "manual" && stored) return stored;
  if (injected) return injected;
  if (!stored) return injected;
  return stored;
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function loadState() {
  const values = await chrome.storage.local.get(["apiBase", "apiBaseSource", "lastStatus"]);
  const nextApiBase = await preferredApiBase(values.apiBase, values.apiBaseSource);
  $("apiBase").value = nextApiBase;
  setStatus(values.lastStatus || "等待同步");
  if (nextApiBase && nextApiBase !== displayApiBase(values.apiBase)) {
    const result = await send({ type: "set-api-base", apiBase: nextApiBase, apiBaseSource: "injected" });
    if (!result.ok) {
      setStatus(friendlyError(result.error));
    }
  }
}

$("saveApi").addEventListener("click", async () => {
  const apiBase = displayApiBase($("apiBase").value);
  $("apiBase").value = apiBase;
  const result = await send({ type: "set-api-base", apiBase, apiBaseSource: "manual" });
  setStatus(result.ok ? `已保存：${result.apiBase}\n已尝试刷新后端配置。` : friendlyError(result.error));
});

$("openAuth").addEventListener("click", async () => {
  const result = await send({ type: "open-auth-pages" });
  setStatus(result.ok ? "已打开授权页面，请逐个登录。" : friendlyError(result.error));
});

$("syncCurrent").addEventListener("click", async () => {
  const button = $("syncCurrent");
  button.disabled = true;
  setStatus("正在同步当前页面...");
  try {
    const result = await send({ type: "sync-current-tab" });
    const values = await chrome.storage.local.get(["apiBase", "apiBaseSource"]);
    $("apiBase").value = await preferredApiBase(values.apiBase, values.apiBaseSource);
    setStatus(result.ok ? "当前页面 Cookie 已同步。" : friendlyError(result.error));
  } catch (error) {
    setStatus(friendlyError(error.message));
  } finally {
    button.disabled = false;
  }
});

loadState().catch((error) => setStatus(friendlyError(error.message)));
