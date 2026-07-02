const $ = (id) => document.getElementById(id);

function setStatus(message) {
  $("status").textContent = message;
}

function friendlyError(message) {
  const text = String(message || "").trim();
  if (/failed to fetch|networkerror|load failed/i.test(text)) {
    return "连接后台失败。请确认后端地址正确，或从后台重新下载新版授权助手后加载。";
  }
  if (/invalid browser auth token|403/i.test(text)) {
    return "同步令牌已失效。请在后台重新下载新版授权助手，或让后台重新生成助手后加载。";
  }
  return text || "操作失败";
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function loadState() {
  const values = await chrome.storage.local.get(["apiBase", "lastStatus"]);
  $("apiBase").value = values.apiBase || "http://43.167.237.120";
  setStatus(values.lastStatus || "等待授权");
}

$("saveApi").addEventListener("click", async () => {
  const apiBase = $("apiBase").value.trim();
  const result = await send({ type: "set-api-base", apiBase });
  setStatus(result.ok ? `已保存：${result.apiBase}\n已尝试刷新后台配置。` : friendlyError(result.error));
});

$("openAuth").addEventListener("click", async () => {
  const result = await send({ type: "open-auth-pages" });
  setStatus(result.ok ? "已打开授权页面，请逐个登录" : friendlyError(result.error));
});

$("syncCurrent").addEventListener("click", async () => {
  const result = await send({ type: "sync-current-tab" });
  setStatus(result.ok ? "当前站点 Cookie 已同步" : friendlyError(result.error));
});

loadState().catch(error => setStatus(friendlyError(error.message)));
