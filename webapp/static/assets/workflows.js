function el(id) {
  return document.getElementById(id);
}

function val(id, fallback = "") {
  const node = el(id);
  if (!node) return fallback;
  return node.value || fallback;
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

function formatTime(ts) {
  if (!ts) return "-";
  return new Date(Number(ts) * 1000).toLocaleString();
}

function statusPill(status) {
  const s = String(status || "");
  if (s === "success") return `<span class="pill success">${s}</span>`;
  if (s === "failed") return `<span class="pill failed">${s}</span>`;
  return `<span class="pill running">${s}</span>`;
}

function switchTaskForm(value) {
  const mapping = {
    create_video: "formCreateVideo",
    replace_model: "formReplaceModel",
    replace_product: "formReplaceProduct",
    replace_productANDmodel: "formReplaceBoth",
  };
  Object.values(mapping).forEach((id) => {
    const node = el(id);
    if (node) node.style.display = "none";
  });
  const active = mapping[value] || "formCreateVideo";
  const activeNode = el(active);
  if (activeNode) activeNode.style.display = "block";
}

async function loadMe() {
  const me = await api("/api/auth/me");
  el("meName").textContent = me.username;
  el("meBalance").textContent = String(me.balance_cents || 0);
  const adminBtn = el("btnGoAdmin");
  if (me.is_admin) {
    adminBtn.style.display = "inline-block";
  } else {
    adminBtn.style.display = "none";
  }
}

async function loadTasks() {
  const list = await api("/api/tasks?limit=120");
  const tasks = list.items || [];
  const tbody = el("taskBody");
  tbody.innerHTML = "";
  tasks.forEach((t) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${t.id}</td>
      <td>${t.type}</td>
      <td>${statusPill(t.status)}</td>
      <td>${t.cost_cents}</td>
      <td>${formatTime(t.created_at)}</td>
      <td>
        <button class="ghost" data-act="detail" data-id="${t.id}">详情</button>
        <button class="blue" data-act="download" data-id="${t.id}">下载</button>
        <button class="ghost" data-act="delete_task" data-id="${t.id}">删除</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function createVideoTask() {
  const fd = new FormData();
  fd.append("duration_seconds", el("cvDuration").value || "15");
  fd.append("product_name", el("cvProductName").value || "商品");
  fd.append("style_hint", el("cvStyleHint").value || "自然口播，真实电商场景");
  fd.append("speech_text", el("cvSpeechText").value || "");
  fd.append("prompt_text", el("cvPromptText").value || "");
  fd.append("use_ai_copy", el("cvUseAiCopy").checked ? "1" : "0");

  const model = el("cvModelImage").files && el("cvModelImage").files[0];
  const product = el("cvProductImage").files && el("cvProductImage").files[0];
  const camera = el("cvCameraVideo").files && el("cvCameraVideo").files[0];
  if (model) fd.append("model_image", model);
  if (product) fd.append("product_image", product);
  if (camera) fd.append("camera_video_file", camera);

  const resp = await api("/api/tasks/create_video", { method: "POST", body: fd });
  return resp.id;
}

async function replaceModelTask() {
  const fd = new FormData();
  const mode = val("rmMode", "original");
  fd.append("mode", mode);
  fd.append("prompt", val("rmPrompt", ""));
  fd.append("duration_seconds", val("rmDuration", mode === "slice" ? "5" : "10"));
  fd.append("width", val("rmWidth", mode === "original" ? "576" : "1280"));
  fd.append("height", val("rmHeight", mode === "original" ? "1024" : "720"));
  fd.append("frame", val("rmFrame", "30"));
  fd.append("start_seconds", val("rmStartSeconds", "0"));
  const videoNode = el("rmVideo");
  const imageNode = el("rmImage");
  const video = videoNode && videoNode.files && videoNode.files[0];
  const image = imageNode && imageNode.files && imageNode.files[0];
  if (video) fd.append("video_file", video);
  if (image) fd.append("image_file", image);
  const resp = await api("/api/tasks/replace_model", { method: "POST", body: fd });
  return resp.id;
}

async function replaceProductTask() {
  const fd = new FormData();
  fd.append("product_name", el("rpProductName").value || "商品");
  fd.append("prompt_text", el("rpPromptText").value || "");
  fd.append("duration_seconds", el("rpDuration").value || "10");
  const video = el("rpVideo").files && el("rpVideo").files[0];
  const image = el("rpImage").files && el("rpImage").files[0];
  if (video) fd.append("video_file", video);
  if (image) fd.append("image_file", image);
  const resp = await api("/api/tasks/replace_product", { method: "POST", body: fd });
  return resp.id;
}

async function replaceBothTask() {
  const fd = new FormData();
  fd.append("match_mode", el("rbMatchMode").value || "cycle");
  fd.append("fixed_index", el("rbFixedIndex").value || "1");
  fd.append("auto_rename", el("rbAutoRename").checked ? "1" : "0");
  fd.append("model_params_json", el("rbModelParams").value || "");
  fd.append("product_params_json", el("rbProductParams").value || "");
  const modelZip = el("rbModelZip").files && el("rbModelZip").files[0];
  const productZip = el("rbProductZip").files && el("rbProductZip").files[0];
  const videoZip = el("rbVideoZip").files && el("rbVideoZip").files[0];
  if (modelZip) fd.append("model_zip", modelZip);
  if (productZip) fd.append("product_zip", productZip);
  if (videoZip) fd.append("video_zip", videoZip);
  const resp = await api("/api/tasks/replace_productANDmodel", { method: "POST", body: fd });
  return resp.id;
}

function bindActions() {
  el("taskTypeSelect").addEventListener("change", (e) => {
    switchTaskForm(String(e.target.value || "create_video"));
  });

  el("btnCreateVideo").addEventListener("click", async () => {
    setMsg("createVideoMsg", "", true);
    try {
      const id = await createVideoTask();
      setMsg("createVideoMsg", `已创建任务：${id}`, true);
      await loadTasks();
      await loadMe();
    } catch (err) {
      setMsg("createVideoMsg", err.detail || err.message || String(err), false);
    }
  });

  el("btnReplaceModel").addEventListener("click", async () => {
    setMsg("replaceModelMsg", "", true);
    try {
      const id = await replaceModelTask();
      setMsg("replaceModelMsg", `已创建任务：${id}`, true);
      await loadTasks();
      await loadMe();
    } catch (err) {
      setMsg("replaceModelMsg", err.detail || err.message || String(err), false);
    }
  });

  el("btnReplaceProduct").addEventListener("click", async () => {
    setMsg("replaceProductMsg", "", true);
    try {
      const id = await replaceProductTask();
      setMsg("replaceProductMsg", `已创建任务：${id}`, true);
      await loadTasks();
      await loadMe();
    } catch (err) {
      setMsg("replaceProductMsg", err.detail || err.message || String(err), false);
    }
  });

  el("btnReplaceBoth").addEventListener("click", async () => {
    setMsg("replaceBothMsg", "", true);
    try {
      const id = await replaceBothTask();
      setMsg("replaceBothMsg", `已创建任务：${id}`, true);
      await loadTasks();
      await loadMe();
    } catch (err) {
      setMsg("replaceBothMsg", err.detail || err.message || String(err), false);
    }
  });

  document.addEventListener("click", async (e) => {
    const btn = e.target;
    if (!btn || !btn.dataset) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if (!act || !id) return;
    if (act === "download") {
      window.open(`/api/tasks/${id}/download`, "_blank");
      return;
    }
    if (act === "detail") {
      const detail = await api(`/api/tasks/${id}`);
      alert(JSON.stringify(detail, null, 2));
      return;
    }
    if (act === "delete_task") {
      if (!confirm(`确认删除任务 ${id} 吗？`)) return;
      await api(`/api/tasks/${id}`, { method: "DELETE" });
      await loadTasks();
    }
  });

  document.querySelectorAll("[data-scroll]").forEach((node) => {
    node.addEventListener("click", () => {
      const target = document.getElementById(node.dataset.scroll);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  el("btnLogout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.href = "/login.html";
  });

  el("btnGoAdmin").addEventListener("click", () => {
    location.href = "/admin.html";
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadMe();
  } catch {
    location.href = "/login.html";
    return;
  }
  switchTaskForm("create_video");
  bindActions();
  await loadTasks();
  setInterval(async () => {
    try {
      await loadTasks();
      await loadMe();
    } catch {
      // ignore polling failures
    }
  }, 8000);
});
