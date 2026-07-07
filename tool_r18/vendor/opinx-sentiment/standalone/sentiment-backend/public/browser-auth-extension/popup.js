const $ = (id) => document.getElementById(id);

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

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function loadState() {
  const values = await chrome.storage.local.get(["apiBase", "lastStatus"]);
  $("apiBase").value = displayApiBase(values.apiBase);
  setStatus(values.lastStatus || "等待同步");
}

$("saveApi").addEventListener("click", async () => {
  const apiBase = displayApiBase($("apiBase").value);
  $("apiBase").value = apiBase;
  const result = await send({ type: "set-api-base", apiBase });
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
    const values = await chrome.storage.local.get(["apiBase"]);
    $("apiBase").value = displayApiBase(values.apiBase);
    setStatus(result.ok ? "当前页面 Cookie 已同步。" : friendlyError(result.error));
  } catch (error) {
    setStatus(friendlyError(error.message));
  } finally {
    button.disabled = false;
  }
});

loadState().catch((error) => setStatus(friendlyError(error.message)));
