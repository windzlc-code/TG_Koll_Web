function el(id) {
  return document.getElementById(id);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "include", ...opts });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { detail: text || `HTTP ${res.status}` };
  }
  if (!res.ok) throw data || { detail: `HTTP ${res.status}` };
  return data;
}

function setMsg(id, message, ok = true) {
  const node = el(id);
  if (!node) return;
  node.textContent = message || "";
  node.className = `msg ${ok ? "ok" : "err"}`;
}

function tryParseJson(text) {
  const t = String(text || "").trim();
  if (!t) return {};
  return JSON.parse(t);
}

let currentPlan = null;

async function loadMe() {
  const me = await api("/api/auth/me");
  el("meName").textContent = me.username;
  el("meBalance").textContent = String(me.balance_cents || 0);
}

async function doPlan() {
  const zip = el("zipFile").files && el("zipFile").files[0];
  if (!zip) throw new Error("请先选择 zip 文件");

  const fd = new FormData();
  fd.append("zip_file", zip);
  fd.append("defaults_json", el("defaultsJson").value || "{}");
  fd.append("param_prompt", el("paramPrompt").value || "");
  fd.append("enable_ai", el("enableAi").checked ? "1" : "0");

  const data = await api("/api/batch/create_video/plan", { method: "POST", body: fd });
  currentPlan = data;
  el("planJson").value = JSON.stringify(data.plan || {}, null, 2);
  setMsg("planMsg", `已生成计划：${data.plan_id}（条目 ${((data.plan || {}).items || []).length}）`, true);
}

async function doRun() {
  if (!currentPlan || !currentPlan.plan_id) throw new Error("请先生成参数预览");
  const plan = tryParseJson(el("planJson").value);
  const payload = {
    plan_id: currentPlan.plan_id,
    plan,
  };
  const data = await api("/api/batch/create_video/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const tid = data.id;
  el("runResult").innerHTML = `任务已创建：<a href="/index.html#task_${tid}">${tid}</a>`;
  setMsg("runMsg", "已开始执行，请到首页任务列表查看进度", true);
}

function bindActions() {
  el("btnPlan").addEventListener("click", async () => {
    setMsg("planMsg", "");
    try {
      await doPlan();
    } catch (err) {
      setMsg("planMsg", err.detail || err.message || String(err), false);
    }
  });

  el("btnRun").addEventListener("click", async () => {
    setMsg("runMsg", "");
    try {
      await doRun();
    } catch (err) {
      setMsg("runMsg", err.detail || err.message || String(err), false);
    }
  });

  el("btnLogout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.href = "/login.html";
  });

  el("btnBackHome").addEventListener("click", () => {
    location.href = "/index.html";
  });

  document.querySelectorAll("[data-scroll]").forEach((node) => {
    node.addEventListener("click", () => {
      const target = document.getElementById(node.dataset.scroll);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadMe();
  } catch {
    location.href = "/login.html";
    return;
  }
  bindActions();
});
