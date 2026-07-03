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

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] || ch));
}

function formatTime(ts) {
  if (!ts) return "-";
  return new Date(Number(ts) * 1000).toLocaleString();
}

function statusPill(status) {
  const s = String(status || "").trim() || "unknown";
  const labels = { success: "已完成", failed: "失败", queued: "排队中", running: "生成中" };
  return `<span class="pill ${escapeHtml(s)}">${escapeHtml(labels[s] || s)}</span>`;
}

const appState = {
  activePage: "generate",
  me: null,
  selectedFiles: [],
  eventSource: null,
};

const pageLabels = {
  generate: "素材生成",
  tasks: "生成记录",
  "persona-dashboard": "人设数据看板",
  account: "账号与额度",
};

function normalizePage(value) {
  const key = String(value || "").replace(/^#/, "").replace(/^app-/, "").trim();
  return pageLabels[key] ? key : "generate";
}

function setActivePage(page, updateHash = true) {
  const next = normalizePage(page);
  appState.activePage = next;
  document.querySelectorAll("[data-page]").forEach((node) => {
    const active = String(node.dataset.page || "") === next;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll("[data-page-view]").forEach((node) => {
    const active = String(node.dataset.pageView || "") === next;
    node.classList.toggle("is-active", active);
    node.style.display = active ? "" : "none";
    node.setAttribute("aria-hidden", active ? "false" : "true");
  });
  const label = pageLabels[next] || "素材生成";
  if (el("currentPageLabel")) el("currentPageLabel").textContent = label;
  document.title = `${label} - Web 素材生成平台`;
  if (updateHash) location.hash = `app-${next}`;
  if (next === "tasks") loadTasks();
}

function fileKind(file) {
  const name = String((file && file.name) || "").toLowerCase();
  if (/\.(png|jpg|jpeg|webp|bmp|gif)$/.test(name)) return "image";
  if (/\.(mp4|mov|avi|mkv|webm)$/.test(name)) return "video";
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/.test(name)) return "audio";
  if (name.endsWith(".zip")) return "zip";
  return "file";
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function addFiles(files) {
  const incoming = Array.from(files || []);
  if (!incoming.length) return;
  const existing = new Set(appState.selectedFiles.map((f) => `${f.name}:${f.size}:${f.lastModified}`));
  incoming.forEach((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!existing.has(key)) {
      appState.selectedFiles.push(file);
      existing.add(key);
    }
  });
  renderSelectedFiles();
}

function renderSelectedFiles() {
  const list = el("chatFileList");
  const summary = el("chatFileSummary");
  if (!list || !summary) return;
  const files = appState.selectedFiles;
  summary.textContent = files.length ? `已选择 ${files.length} 个文件` : "未选择文件";
  list.innerHTML = files.map((file, index) => `
    <div class="file-item">
      <div>
        <strong>${escapeHtml(file.name)}</strong>
        <div class="small">${escapeHtml(fileKind(file))} · ${escapeHtml(formatBytes(file.size))}</div>
      </div>
      <button class="ghost" type="button" data-remove-file="${index}">移除</button>
    </div>
  `).join("");
}

function addProgressLine(kind, text) {
  const host = el("chatMessages");
  if (!host) return;
  const row = document.createElement("div");
  row.className = "chat-event";
  row.innerHTML = `<div class="chat-event-pill ${escapeHtml(kind || "info")}">${escapeHtml(text || "")}</div>`;
  host.appendChild(row);
  host.scrollTop = host.scrollHeight;
}

function watchTask(taskId) {
  if (appState.eventSource) appState.eventSource.close();
  appState.eventSource = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`, { withCredentials: true });
  appState.eventSource.onmessage = (event) => {
    let payload = {};
    try { payload = JSON.parse(event.data || "{}"); } catch {}
    const kind = String(payload.kind || payload.status || "progress");
    const message = String(payload.message || payload.detail || kind);
    addProgressLine(kind, message);
    if (kind === "success" || kind === "failed") {
      appState.eventSource.close();
      appState.eventSource = null;
      loadTasks();
    }
  };
  appState.eventSource.onerror = () => {
    if (appState.eventSource) appState.eventSource.close();
    appState.eventSource = null;
  };
}

async function loadMe() {
  try {
    const me = await api("/api/me");
    appState.me = me;
    ["meName", "pageMeName"].forEach((id) => { if (el(id)) el(id).textContent = me.username || "-"; });
    ["meBalance", "pageMeBalance"].forEach((id) => { if (el(id)) el(id).textContent = String(me.balance_cents || 0); });
    if (el("btnGoAdmin")) el("btnGoAdmin").style.display = me.is_admin ? "" : "none";
    return me;
  } catch {
    location.href = "/login.html";
    return null;
  }
}

async function submitImageTask() {
  const images = appState.selectedFiles.filter((file) => fileKind(file) === "image");
  if (!images.length) {
    setMsg("chatMsg", "请至少上传 1 张参考图", false);
    return;
  }
  const modeNode = el("imageGenerateMode");
  const mode = String((modeNode && modeNode.value) || "single_reference");
  if (mode === "dual_reference" && images.length < 2) {
    setMsg("chatMsg", "双图参考模式需要上传 2 张参考图", false);
    return;
  }
  const prompt = String((el("chatInput") && el("chatInput").value) || "").trim()
    || String((el("assetStyleHint") && el("assetStyleHint").value) || "").trim()
    || String((el("assetName") && el("assetName").value) || "").trim();
  if (!prompt) {
    setMsg("chatMsg", "请填写生成描述", false);
    return;
  }
  const params = {
    mode,
    prompt,
    message: prompt,
    image_generate_provider: "closed_model_api",
  };
  const fd = new FormData();
  fd.append("task_type", "image_generate");
  fd.append("params_json", JSON.stringify(params));
  appState.selectedFiles.forEach((file) => fd.append("files", file, file.name));
  setMsg("chatMsg", "任务已提交，正在创建...", true);
  addProgressLine("queued", "任务已提交");
  const resp = await api("/api/tasks/submit", { method: "POST", body: fd });
  watchTask(resp.id);
  loadTasks();
}

async function loadTasks() {
  const host = el("taskList");
  if (!host) return;
  try {
    const data = await api("/api/tasks");
    const rows = Array.isArray(data.tasks) ? data.tasks : Array.isArray(data) ? data : [];
    host.innerHTML = rows.map((task) => `
      <article class="task-card">
        <div class="task-card-head">
          <div>
            <div class="task-card-title">${escapeHtml(task.workflow_name || task.type || "生成任务")}</div>
            <div class="small">${escapeHtml(formatTime(task.created_at))}</div>
          </div>
          ${statusPill(task.status)}
        </div>
        ${task.error ? `<div class="msg err">${escapeHtml(task.error)}</div>` : ""}
        <div class="task-inline-actions">
          ${task.has_download ? `<button class="blue task-action-btn" type="button" data-download-task="${escapeHtml(task.id)}">下载结果</button>` : ""}
          ${task.status === "failed" ? `<button class="primary task-action-btn" type="button" data-retry-task="${escapeHtml(task.id)}">重试</button>` : ""}
          <button class="ghost task-action-btn" type="button" data-delete-task="${escapeHtml(task.id)}">删除</button>
        </div>
      </article>
    `).join("");
    const empty = el("taskEmpty");
    if (empty) empty.style.display = rows.length ? "none" : "";
  } catch (err) {
    host.innerHTML = `<div class="msg err">${escapeHtml(err.detail || err.message || "加载失败")}</div>`;
  }
}

async function changePassword() {
  const oldPassword = String((el("accOldPassword") && el("accOldPassword").value) || "");
  const newPassword = String((el("accNewPassword") && el("accNewPassword").value) || "");
  await api("/api/account/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  });
  setMsg("accountMsg", "密码已更新", true);
}

function bindEvents() {
  document.querySelectorAll("[data-page]").forEach((node) => {
    node.addEventListener("click", () => setActivePage(node.dataset.page || "generate"));
  });
  window.addEventListener("hashchange", () => setActivePage(location.hash, false));
  if (el("btnGoAdmin")) el("btnGoAdmin").addEventListener("click", () => { location.href = "/admin.html"; });
  if (el("btnLogout")) el("btnLogout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" }).catch(() => null);
    location.href = "/login.html";
  });
  ["primaryImageInput", "secondaryImageInput", "cameraVideoInput", "audioInput", "batchZipInput", "chatFiles"].forEach((id) => {
    const node = el(id);
    if (node) node.addEventListener("change", () => addFiles(node.files));
  });
  if (el("chatFileList")) el("chatFileList").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-remove-file]");
    if (!btn) return;
    appState.selectedFiles.splice(Number(btn.dataset.removeFile), 1);
    renderSelectedFiles();
  });
  if (el("btnClearFiles")) el("btnClearFiles").addEventListener("click", () => {
    appState.selectedFiles = [];
    renderSelectedFiles();
  });
  if (el("btnSendChat")) el("btnSendChat").addEventListener("click", () => {
    submitImageTask().catch((err) => setMsg("chatMsg", err.detail || err.message || "提交失败", false));
  });
  document.addEventListener("click", async (event) => {
    const download = event.target.closest("[data-download-task]");
    if (download) {
      location.href = `/api/tasks/${encodeURIComponent(download.dataset.downloadTask)}/download`;
      return;
    }
    const retry = event.target.closest("[data-retry-task]");
    if (retry) {
      const resp = await api(`/api/tasks/${encodeURIComponent(retry.dataset.retryTask)}/retry`, { method: "POST" });
      watchTask(resp.id || retry.dataset.retryTask);
      loadTasks();
      return;
    }
    const del = event.target.closest("[data-delete-task]");
    if (del && confirm("确认删除这条记录？")) {
      await api(`/api/tasks/${encodeURIComponent(del.dataset.deleteTask)}`, { method: "DELETE" });
      loadTasks();
    }
  });
  if (el("btnTaskRefresh")) el("btnTaskRefresh").addEventListener("click", loadTasks);
  if (el("btnChangePassword")) el("btnChangePassword").addEventListener("click", () => {
    changePassword().catch((err) => setMsg("accountMsg", err.detail || err.message || "修改失败", false));
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  renderSelectedFiles();
  await loadMe();
  setActivePage(location.hash || "generate", false);
  loadTasks();
});
