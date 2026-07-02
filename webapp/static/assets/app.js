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

const userTaskState = {
  rows: [],
  inspectText: "",
  recentImageTasks: [],
};
const appState = {
  activePage: "generate",
  generatedSceneTaskId: "",
  generatedSceneImagePath: "",
  recentRailOpen: false,
  personaDashboard: null,
  personaDashboardSelectedId: "__overview__",
  personaDashboardPostPage: 1,
  personaDashboardPageSize: Number(localStorage.getItem("personaDashboardPageSize") || 10) || 10,
  personaDashboardAccountPlatform: localStorage.getItem("personaDashboardAccountPlatform") || "threads",
  personaDashboardTabPage: 1,
  personaDashboardPostModalKey: "",
};
const APP_PAGES = new Set(["generate", "tasks", "persona-dashboard", "account"]);
const APP_PAGE_LABELS = {
  generate: "素材生成",
  tasks: "生成记录",
  "persona-dashboard": "人设数据看板",
  account: "账号与额度",
};
const APP_PAGE_ALIASES = {
  generateCard: "generate",
  taskCard: "tasks",
  personaDashboardCard: "persona-dashboard",
  accountCard: "account",
};

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] || ch));
}

function normalizeAppPage(value) {
  const raw = String(value || "").replace(/^#/, "").trim();
  if (!raw) return "generate";
  if (APP_PAGE_ALIASES[raw]) return APP_PAGE_ALIASES[raw];
  if (raw.startsWith("task_")) return "tasks";
  const mapped = raw.replace(/^app-/, "");
  return APP_PAGES.has(mapped) ? mapped : "generate";
}

function readAppPageFromHash() {
  return normalizeAppPage(location.hash || "");
}

function setActiveAppPage(page, updateHash = true) {
  const nextPage = normalizeAppPage(page);
  appState.activePage = nextPage;
  const pageLabel = APP_PAGE_LABELS[nextPage] || "素材生成";
  document.querySelectorAll("[data-page]").forEach((node) => {
    const active = String(node.dataset.page || "") === nextPage;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll("[data-page-view]").forEach((node) => {
    const active = String(node.dataset.pageView || "") === nextPage;
    node.classList.toggle("is-active", active);
    node.style.display = active ? "" : "none";
    node.setAttribute("aria-hidden", active ? "false" : "true");
  });
  if (el("currentPageLabel")) el("currentPageLabel").textContent = pageLabel;
  document.title = `${pageLabel} - 电商带货视频生成平台`;
  const targetHash = `app-${nextPage}`;
  if (updateHash && String(location.hash || "").replace(/^#/, "") !== targetHash) {
    location.hash = targetHash;
  }
  if (nextPage === "persona-dashboard" && !appState.personaDashboard) {
    loadPersonaDashboard();
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value == null ? {} : value, null, 2);
  } catch {
    return String(value == null ? "" : value);
  }
}

function formatTime(ts) {
  if (!ts) return "-";
  return new Date(Number(ts) * 1000).toLocaleString();
}

function statusPill(status) {
  const s = String(status || "").trim() || "unknown";
  const labels = { success: "已完成", failed: "失败", queued: "排队中", running: "生成中" };
  if (s === "success") return `<span class="pill success">${escapeHtml(labels[s])}</span>`;
  if (s === "failed") return `<span class="pill failed">${escapeHtml(labels[s])}</span>`;
  if (s === "queued") return `<span class="pill queued">${escapeHtml(labels[s])}</span>`;
  return `<span class="pill running">${escapeHtml(labels[s] || s)}</span>`;
}

function setRecentRailOpen(open) {
  appState.recentRailOpen = Boolean(open);
  const rail = el("recentSideRail");
  const toggle = el("recentSideToggle");
  const meta = el("recentSideToggleMeta");
  if (rail) rail.dataset.open = appState.recentRailOpen ? "true" : "false";
  if (toggle) toggle.setAttribute("aria-expanded", appState.recentRailOpen ? "true" : "false");
  if (meta) meta.textContent = appState.recentRailOpen ? "点击收起" : `已收起 · ${Math.min(userTaskState.recentImageTasks.length || 0, 9)} 条`;
}

function setProgressStage(stage, statusText = "", metaText = "") {
  const normalized = String(stage || "").trim().toLowerCase();
  const statusNode = el("progressStatusText");
  const metaNode = el("progressMetaText");
  if (statusNode) statusNode.textContent = statusText || "等待提交";
  if (metaNode) metaNode.textContent = metaText || "暂无进行中的生成";
  document.querySelectorAll("#progressStageStrip .progress-stage-chip").forEach((node) => {
    const nodeStage = String(node.dataset.stage || "").trim().toLowerCase();
    const orderedStages = ["queued", "uploading", "processing", "finished"];
    const currentIndex = orderedStages.indexOf(normalized);
    const nodeIndex = orderedStages.indexOf(nodeStage);
    node.classList.toggle("is-active", normalized ? nodeStage === normalized : false);
    node.classList.toggle("is-done", currentIndex >= 0 && nodeIndex >= 0 && nodeIndex < currentIndex);
    node.classList.toggle("is-failed", normalized === "failed" && nodeStage === "finished");
  });
}

function formatProgressStatusMeta(detail) {
  const text = String(detail || "").trim();
  if (!text) return "";
  const parts = text.split(/\s*\|\s*/).map((item) => String(item || "").trim()).filter(Boolean);
  return parts.slice(0, 2).map((item) => publicMessage(item)).join(" · ");
}

function addChatBubble(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `chat-bubble ${role === "user" ? "user" : "assistant"}`;
  wrap.innerHTML = `<div>${String(text || "").replace(/\n/g, "<br>")}</div>`;
  el("chatMessages").appendChild(wrap);
  el("chatMessages").scrollTop = el("chatMessages").scrollHeight;
}

function eventKindLabel(kind) {
  const value = String(kind || "info").trim().toLowerCase();
  if (value === "success") return "成功";
  if (value === "failed") return "失败";
  if (value === "running") return "运行中";
  if (value === "queued") return "排队中";
  if (value === "progress") return "进度";
  if (value === "log") return "进度";
  return "提示";
}

function renderEventDetailHtml(detail) {
  const text = String(detail || "").trim();
  if (!text) return "";
  const parts = text.split(/\s*\|\s*/).filter((item) => item && item.trim());
  return parts.map((part) => {
    const item = String(part || "").trim();
    if (/^https?:\/\//i.test(item)) {
      const safeUrl = escapeHtml(item);
      return `<a class="chat-event-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
    }
    return `<div class="chat-event-detail-item">${escapeHtml(publicMessage(item))}</div>`;
  }).join("");
}

function addEventPill(kind, text, detail = "") {
  const row = document.createElement("div");
  row.className = "chat-event";
  const card = document.createElement("div");
  card.className = `chat-event-pill ${String(kind || "info")}`;
  const detailHtml = renderEventDetailHtml(detail);
  card.innerHTML = `
    <div class="chat-event-head">
      <span class="chat-event-badge ${escapeHtml(String(kind || "info"))}">${eventKindLabel(kind)}</span>
      <div class="chat-event-title">${escapeHtml(publicMessage(text) || "生成消息")}</div>
    </div>
    ${detailHtml ? `<div class="chat-event-detail">${detailHtml}</div>` : ""}
  `;
  row.appendChild(card);
  el("chatMessages").appendChild(row);
  el("chatMessages").scrollTop = el("chatMessages").scrollHeight;
  const statusLabel = kind === "success"
    ? "生成完成"
    : kind === "failed"
      ? "生成失败"
      : kind === "queued"
        ? "正在排队"
        : kind === "running"
          ? "开始生成"
          : kind === "progress"
            ? "处理中"
            : kind === "log"
              ? "处理中"
              : "等待提交";
  setProgressStage(
    kind === "success" ? "finished" : kind === "failed" ? "failed" : "processing",
    statusLabel,
    formatProgressStatusMeta(detail) || publicMessage(text)
  );
}

let selectedFiles = [];
let batchEnabled = false;
let previewUrlByFileKey = new Map();
let nextClientFileId = 1;
let paramsByTaskType = {
  commerce_video: {
    product_name: "商品",
    style_hint: "自然口播，真实电商场景",
    speech_text: "",
    prompt_text: "",
    nano_prompt: "电商口播视频场景截图风格：真实人物在室内/直播间展示商品，手持商品或放在手掌上讲解；写实摄影、柔和补光、干净背景；9:16；画面不要文字/水印/海报排版。",
    emotion: "happy",
    language: "Chinese",
    model_choice: "1.7B",
    speaker: "Ryan",
    instance_type: "default",
    use_personal_queue: false,
    duration_mode: "manual",
    duration_seconds: 15,
    use_ai_copy: true,
  },
  image_generate: {
    mode: "product_only",
    image_generate_provider: "remote_comfy",
    prompt: "生成电商商品展示图，画面干净自然，无文字。",
  },
  replace_model: { mode: "original", prompt: "", duration_seconds: 10, width: 576, height: 1024, frame: 30, start_seconds: 0 },
  replace_product: { product_name: "商品", prompt_text: "", duration_seconds: 15, frame_rate: 30, width: 576, height: 1024 },
  replace_productANDmodel: {
    match_mode: "cycle",
    fixed_index: 1,
    auto_rename: true,
    model_params: { prompt: "", width: 576, height: 1024, frame: 30 },
    product_params: { product_name: "商品", prompt_text: "", width: 576, height: 1024, frame_rate: 30 },
  },
};

function fileSignature(file) {
  return [file.name || "", file.size || 0, file.lastModified || 0, file.type || ""].join("::");
}

function fileKey(file) {
  if (!file) return "";
  if (!file.__clientFileKey) {
    file.__clientFileKey = `${fileSignature(file)}::${nextClientFileId++}`;
  }
  return String(file.__clientFileKey || "");
}

function cleanupPreviewUrls(validKeys) {
  const keep = validKeys ? new Set(validKeys) : null;
  Array.from(previewUrlByFileKey.keys()).forEach((k) => {
    if (keep && keep.has(k)) return;
    const url = previewUrlByFileKey.get(k);
    if (url) URL.revokeObjectURL(url);
    previewUrlByFileKey.delete(k);
  });
}

function fileKind(file) {
  const n = String((file && file.name) || "").toLowerCase();
  if (n.endsWith(".zip")) return "zip";
  if (/\.(png|jpg|jpeg|webp|bmp|gif)$/.test(n)) return "image";
  if (/\.(mp4|mov|avi|mkv|webm)$/.test(n)) return "video";
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/.test(n)) return "audio";
  return "file";
}

function fileExtLabel(file) {
  const name = String((file && file.name) || "").trim();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "FILE";
  const ext = name.slice(dot + 1).toUpperCase();
  return ext && ext.length <= 6 ? ext : "FILE";
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function mergeFiles(files) {
  const incoming = Array.from(files || []);
  if (!incoming.length) {
    setMsg("chatMsg", "未识别到可添加的文件（可拖拽到输入框，或点“上传”选择）", false);
    return 0;
  }
  const allowDuplicateSignatures = batchEnabled || getTaskType() === "replace_productANDmodel";
  const existing = new Set(selectedFiles.map((f) => fileSignature(f)));
  let added = 0;
  incoming.forEach((file) => {
    const sign = fileSignature(file);
    if (!allowDuplicateSignatures && existing.has(sign)) return;
    selectedFiles.push(file);
    existing.add(sign);
    added += 1;
  });
  renderSelectedFiles();
  renderSubmitChecklist();
  setMsg("chatMsg", `已添加 ${added} 个文件`, true);
  return added;
}

function extractDroppedFiles(dataTransfer) {
  const dt = dataTransfer;
  if (!dt) return [];
  const items = Array.from(dt.items || []);
  if (items.length) {
    const out = [];
    items.forEach((it) => {
      if (!it) return;
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    });
    if (out.length) return out;
  }
  return Array.from(dt.files || []);
}

function isProbablyFileDrop(dataTransfer) {
  const dt = dataTransfer;
  if (!dt) return false;
  try {
    const types = Array.from(dt.types || []);
    if (types.includes("Files")) return true;
    if (types.some((t) => String(t || "").toLowerCase().includes("file"))) return true;
  } catch {
    // ignore
  }
  try {
    if (dt.files && dt.files.length) return true;
  } catch {
    // ignore
  }
  try {
    const items = Array.from(dt.items || []);
    return items.some((it) => it && it.kind === "file");
  } catch {
    return false;
  }
}

const DRAG_DEBUG = (() => {
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get("debug_drag") === "1") return true;
  } catch {
    // ignore
  }
  try {
    return localStorage.getItem("debug_drag") === "1";
  } catch {
    return false;
  }
})();

function dragDebugLog(label, e, extra = {}) {
  if (!DRAG_DEBUG) return;
  const dt = e && e.dataTransfer;
  let types = [];
  let filesLen = 0;
  let itemsLen = 0;
  try {
    types = Array.from((dt && dt.types) || []);
  } catch {
    // ignore
  }
  try {
    filesLen = Number((dt && dt.files && dt.files.length) || 0);
  } catch {
    filesLen = 0;
  }
  try {
    itemsLen = Number((dt && dt.items && dt.items.length) || 0);
  } catch {
    itemsLen = 0;
  }
  console.log("[drag]", label, { types, filesLen, itemsLen, target: e && e.target && e.target.id, ...extra });
}

function removeFile(key) {
  cleanupPreviewUrls(selectedFiles.filter((f) => fileKey(f) !== key).map((f) => fileKey(f)));
  selectedFiles = selectedFiles.filter((f) => fileKey(f) !== key);
  renderSelectedFiles();
  renderSubmitChecklist();
}

function clearFiles() {
  cleanupPreviewUrls(null);
  selectedFiles = [];
  const fileInput = el("chatFiles");
  if (fileInput) fileInput.value = "";
  renderSelectedFiles();
  renderSubmitChecklist();
  setMsg("chatMsg", "已清空文件", true);
}

function normalizeCommerceFileRoles() {
  const taskType = getTaskType();
  if (!["commerce_video", "image_generate"].includes(taskType)) return;
  if (batchEnabled && taskType === "commerce_video") return;
  const byRole = {};
  selectedFiles.forEach((file) => {
    const role = String(file.__assetSlot || "");
    if (role && !byRole[role]) byRole[role] = file;
  });
  selectedFiles.forEach((file) => {
    const kind = fileKind(file);
    if (kind === "image" && !file.__assetSlot) {
      if (!byRole.model) {
        file.__assetSlot = "model";
        byRole.model = file;
      } else if (!byRole.product) {
        file.__assetSlot = "product";
        byRole.product = file;
      }
    }
    if (kind === "video" && !file.__assetSlot && !byRole.camera) {
      file.__assetSlot = "camera";
      byRole.camera = file;
    }
    if (kind === "audio" && !file.__assetSlot && !byRole.audio) {
      file.__assetSlot = "audio";
      byRole.audio = file;
    }
  });
  const order = { model: 1, product: 2, camera: 3, audio: 4 };
  selectedFiles.sort((a, b) => {
    const ao = order[String(a.__assetSlot || "")] || 50;
    const bo = order[String(b.__assetSlot || "")] || 50;
    if (ao !== bo) return ao - bo;
    return fileSignature(a).localeCompare(fileSignature(b));
  });
}

function fileForSlot(slot) {
  return selectedFiles.find((file) => String(file.__assetSlot || "") === slot) || null;
}

function setSlotFile(slot, file) {
  if (!file) return;
  const kind = fileKind(file);
  if ((slot === "model" || slot === "product") && kind !== "image") {
    setMsg("chatMsg", "模特图和商品图只支持图片文件", false);
    return;
  }
  if (slot === "camera" && kind !== "video") {
    setMsg("chatMsg", "运镜素材只支持视频文件", false);
    return;
  }
  if (slot === "audio" && kind !== "audio") {
    setMsg("chatMsg", "口播素材只支持音频文件", false);
    return;
  }
  selectedFiles = selectedFiles.filter((item) => String(item.__assetSlot || "") !== slot);
  file.__assetSlot = slot;
  selectedFiles.push(file);
  normalizeCommerceFileRoles();
  renderSelectedFiles();
  renderSubmitChecklist();
  setMsg("chatMsg", "素材已更新", true);
}

function addZipFiles(files) {
  Array.from(files || []).forEach((file) => {
    if (fileKind(file) !== "zip") return;
    file.__assetSlot = "zip";
    selectedFiles.push(file);
  });
  renderSelectedFiles();
  renderSubmitChecklist();
}

function slotPreviewHtml(slot, title) {
  const file = fileForSlot(slot);
  if (!file) return "";
  const kind = fileKind(file);
  if (kind === "image") {
    const k = fileKey(file);
    let url = previewUrlByFileKey.get(k);
    if (!url) {
      url = URL.createObjectURL(file);
      previewUrlByFileKey.set(k, url);
    }
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(title)}预览" />`;
  }
  return `<span class="slot-file-name">${escapeHtml(file.name || title)}</span>`;
}

function renderUploadSlots() {
  const slots = [
    { slot: "model", node: "modelSlot", preview: "modelSlotPreview", label: "模特图" },
    { slot: "product", node: "productSlot", preview: "productSlotPreview", label: "商品图" },
  ];
  slots.forEach((item) => {
    const host = el(item.node);
    const preview = el(item.preview);
    const file = fileForSlot(item.slot);
    if (host) host.classList.toggle("filled", Boolean(file));
    if (preview) preview.innerHTML = slotPreviewHtml(item.slot, item.label);
  });
  const productName = el("commerceProductName");
  if (productName && !String(productName.value || "").trim()) {
    const params = _firstCommonParam("commerce_video");
    productName.value = params.product_name || "";
  }
  const styleHint = el("commerceStyleHint");
  if (styleHint && !String(styleHint.value || "").trim()) {
    const params = _firstCommonParam("commerce_video");
    styleHint.value = params.style_hint || "";
  }
}

function renderSelectedFiles() {
  const summary = el("chatFileSummary");
  const list = el("chatFileList");
  if (!summary || !list) return;

  list.innerHTML = "";
  normalizeCommerceFileRoles();
  if (!selectedFiles.length) {
    cleanupPreviewUrls(null);
    summary.textContent = "未选择文件";
    renderUploadSlots();
    updateUploadHint();
    return;
  }

  cleanupPreviewUrls(selectedFiles.map((f) => fileKey(f)));
  const totalBytes = selectedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
  summary.textContent = `已选 ${selectedFiles.length} 个文件，合计 ${formatBytes(totalBytes)}（可重复选择，自动追加）`;

  selectedFiles.forEach((file) => {
    const row = document.createElement("div");
    row.className = "file-item file-card";

    const thumb = document.createElement("div");
    thumb.className = "file-thumb";
    const kind = fileKind(file);
    if (kind === "image") {
      const k = fileKey(file);
      let url = previewUrlByFileKey.get(k);
      if (!url) {
        url = URL.createObjectURL(file);
        previewUrlByFileKey.set(k, url);
      }
      const img = document.createElement("img");
      img.src = url;
      img.alt = file.name || "image";
      img.loading = "lazy";
      thumb.appendChild(img);
    } else {
      const badge = document.createElement("div");
      badge.className = `file-thumb-badge kind-${kind}`;
      badge.textContent = kind === "zip" ? "ZIP" : kind === "video" ? "VID" : kind === "audio" ? "AUD" : fileExtLabel(file);
      thumb.appendChild(badge);
    }

    const size = document.createElement("div");
    size.className = "file-item-meta";
    size.textContent = formatBytes(file.size || 0);

    const title = document.createElement("div");
    title.className = "file-item-name";
    title.textContent = file.name || "未命名文件";
    title.title = file.name || "未命名文件";

    const removeBtn = document.createElement("button");
    removeBtn.className = "ghost file-item-remove";
    removeBtn.type = "button";
    removeBtn.textContent = "×";
    removeBtn.dataset.fileKey = fileKey(file);

    row.appendChild(thumb);
    row.appendChild(title);
    row.appendChild(size);
    row.appendChild(removeBtn);
    list.appendChild(row);
  });
  renderUploadSlots();
  updateUploadHint();
}

function _countSelectedKinds() {
  const items = selectedFiles || [];
  const counts = { image: 0, video: 0, zip: 0, audio: 0 };
  items.forEach((f) => {
    const kind = fileKind(f);
    if (counts[kind] != null) counts[kind] += 1;
  });
  return counts;
}

function updateUploadHint() {
  const node = el("chatUploadHint");
  if (!node) return;
  const taskType = getTaskType();
  const c = _countSelectedKinds();
  const picked = `已选：图${c.image} 视频${c.video} 音频${c.audio} ZIP${c.zip}`;
  let need = "";
  if (taskType === "commerce_video") {
    if (batchEnabled) {
      need = "批量模式：上传 ZIP 素材包，每条素材需包含模特图和商品图。";
    } else if (appState.generatedSceneImagePath) {
      need = "快速模式：已选场景图，只需上传 1 张模特图；可选运镜视频或口播音频。";
    } else {
      need = "单条模式：请分别上传模特图和商品图，可选运镜视频或口播音频。";
    }
  } else if (taskType === "image_generate") {
    need = "图片生成：当前使用 ComfyUI 工作流，可上传 1 张商品图，或先模特图后商品图。";
  } else if (taskType === "replace_model") {
    if (batchEnabled) {
      need = "批量：只上传 ZIP（可多个）。每条需 1 个被替换视频 + 1 张模特图片；可单ZIP多文件夹或 被替换视频ZIP+模特图片ZIP自动配对。";
    } else {
      need = "单条：需 1 个被替换视频 + 1 张模特图片。";
    }
  } else if (taskType === "replace_product") {
    if (batchEnabled) {
      need = "批量：只上传 ZIP（可多个）。每条需 1 个被替换视频 + 1 张商品图片；可单ZIP多文件夹或 被替换视频ZIP+模特图片ZIP自动配对。";
    } else {
      need = "单条：需 1 个被替换视频 + 1 商品张图片。";
    }
  } else if (taskType === "replace_productANDmodel") {
    need =
      "可直接上传模特图、商品图和原视频，系统会自动识别素材；批量场景可上传压缩包。请填写商品名称。";
  }
  node.textContent = `提示：${need}（${picked}）`;
  renderSubmitChecklist();
  const btn = el("btnSendChat");
  if (btn && taskType === "commerce_video") {
    btn.disabled = !batchEnabled && (appState.generatedSceneImagePath ? c.image < 1 : c.image < 2);
  } else if (btn && taskType === "image_generate") {
    btn.disabled = c.image < 1;
  }
}

async function loadMe() {
  const me = await api("/api/auth/me");
  el("meName").textContent = me.username;
  el("meBalance").textContent = String(me.balance_cents || 0);
  if (el("pageMeName")) el("pageMeName").textContent = me.username || "";
  if (el("pageMeBalance")) el("pageMeBalance").textContent = String(me.balance_cents || 0);
  if (el("accCurrentUsername")) el("accCurrentUsername").value = me.username || "";
  const adminBtn = el("btnGoAdmin");
  if (me.is_admin) {
    adminBtn.style.display = "inline-flex";
  } else {
    adminBtn.style.display = "none";
  }
}

function ledgerTypeLabel(type) {
  const t = String(type || "");
  if (t === "recharge") return "额度分配";
  if (t === "charge") return "生成扣费";
  if (t === "refund") return "退回额度";
  return t || "流水";
}

async function loadLedger() {
  const host = el("ledgerList");
  if (!host) return;
  host.innerHTML = `<div class="task-empty task-empty-inline">正在加载消费记录...</div>`;
  try {
    const rows = (await api("/api/ledger?limit=30")).items || [];
    if (!rows.length) {
      host.innerHTML = `<div class="task-empty task-empty-inline">暂无消费记录</div>`;
      return;
    }
    host.innerHTML = rows.map((row) => {
      const amount = Number(row.amount_cents || 0);
      const amountText = `${amount > 0 ? "+" : ""}${amount} 分`;
      return `
        <article class="ledger-item">
          <div>
            <div class="ledger-title">${escapeHtml(ledgerTypeLabel(row.type))}</div>
            <div class="small">${escapeHtml(formatTime(row.created_at))}${row.ref_task_id ? ` · 生成编号：${escapeHtml(row.ref_task_id)}` : ""}</div>
          </div>
          <div class="ledger-amount ${amount < 0 ? "negative" : "positive"}">${escapeHtml(amountText)}</div>
        </article>
      `;
    }).join("");
  } catch (err) {
    host.innerHTML = `<div class="task-empty task-empty-inline">消费记录加载失败：${escapeHtml(publicMessage(err.detail || err.message || String(err)))}</div>`;
  }
}

function syncTaskTypeTabs() {
  const taskType = getTaskType();
  const videoTab = el("taskTypeModeVideo");
  const imageTab = el("taskTypeModeImage");
  const videoBrief = el("modeBriefVideo");
  const imageBrief = el("modeBriefImage");
  if (videoTab) {
    videoTab.classList.toggle("is-active", taskType === "commerce_video");
    videoTab.setAttribute("aria-pressed", taskType === "commerce_video" ? "true" : "false");
  }
  if (imageTab) {
    imageTab.classList.toggle("is-active", taskType === "image_generate");
    imageTab.setAttribute("aria-pressed", taskType === "image_generate" ? "true" : "false");
  }
  if (videoBrief) videoBrief.classList.toggle("is-active", taskType === "commerce_video");
  if (imageBrief) imageBrief.classList.toggle("is-active", taskType === "image_generate");
}

function renderSubmitChecklist() {
  const host = el("submitChecklistItems");
  if (!host) return;
  const taskType = getTaskType();
  const files = selectedFiles.slice();
  const names = files.map((file) => String((file && file.name) || "").trim()).filter(Boolean);
  const imageNames = names.filter((name) => /\.(png|jpg|jpeg|webp|bmp|gif)$/i.test(name));
  const videoNames = names.filter((name) => /\.(mp4|mov|avi|mkv|webm)$/i.test(name));
  const audioNames = names.filter((name) => /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(name));
  const zipNames = names.filter((name) => /\.zip$/i.test(name));
  const productName = String((el("commerceProductName") && el("commerceProductName").value) || "").trim();
  const styleHint = String((el("commerceStyleHint") && el("commerceStyleHint").value) || "").trim();
  const scriptText = String((el("chatInput") && el("chatInput").value) || "").trim();
  const imageMode = String((el("imageGenerateMode") && el("imageGenerateMode").value) || "product_only").trim() || "product_only";
  const usingScene = Boolean(appState.generatedSceneImagePath);
  const checklist = [];
  if (taskType === "image_generate") {
    const productReady = imageNames.length >= 1;
    const modelReady = imageMode === "product_only" ? true : imageNames.length >= 2;
    checklist.push({ ready: productReady, label: productReady ? `商品图已就位（${Math.max(imageNames.length - (imageMode === "product_only" ? 0 : 1), 1)} 张可用）` : "请先上传商品图" });
    checklist.push({ ready: modelReady, label: imageMode === "product_only" ? "当前模式无需模特图" : (modelReady ? "模特图与商品图已齐全" : "双图模式还缺少模特图或第二张图片") });
    checklist.push({ ready: Boolean(productName || styleHint || scriptText), label: productName || styleHint || scriptText ? "文案/风格已补充，可直接开始生成" : "可直接生成，也可补充商品名称、风格或提示词" });
    checklist.push({ ready: true, label: zipNames.length ? `已附带 ZIP 批量素材（${zipNames.length} 个）` : "当前按单次图片生成准备" });
  } else {
    const modelReady = usingScene ? imageNames.length >= 1 : imageNames.length >= 2;
    const sceneReady = usingScene || imageNames.length >= 2;
    checklist.push({ ready: modelReady, label: usingScene ? (modelReady ? "模特图已就位，可与已选场景图合成视频" : "已复用场景图，请再上传 1 张模特图") : (modelReady ? "模特图与商品图已齐全" : "请先上传模特图和商品图") });
    checklist.push({ ready: sceneReady, label: usingScene ? "已复用最近生成图片作为场景图" : (sceneReady ? "商品图已就位，可直接生成视频" : "还缺少商品图") });
    checklist.push({ ready: Boolean(scriptText || productName || styleHint), label: scriptText || productName || styleHint ? "口播文案 / 风格说明已补充" : "可留空直接生成，也可补充口播文案与画面风格" });
    checklist.push({ ready: true, label: videoNames.length || audioNames.length ? `已附加参考素材：${videoNames.length ? `运镜视频 ${videoNames.length} 个` : ""}${videoNames.length && audioNames.length ? "，" : ""}${audioNames.length ? `口播音频 ${audioNames.length} 个` : ""}` : "未附加运镜视频或口播音频，系统将按基础模式生成" });
  }
  host.innerHTML = checklist.map((item) => `
    <div class="submit-check-item${item.ready ? " is-ready" : " is-pending"}">
      <span class="submit-check-icon">${item.ready ? "✓" : "·"}</span>
      <span>${escapeHtml(item.label)}</span>
    </div>
  `).join("");
}

function updateGeneratePageCopy() {
  const taskType = getTaskType();
  const heroKicker = el("modeHeroKicker");
  const heroCard = el("modeHeroCard");
  const briefVideoMeta = el("modeBriefVideo");
  const briefImageMeta = el("modeBriefImage");
  const uploadStageTitle = el("uploadStageTitle");
  const uploadStageMeta = el("uploadStageMeta");
  const submitStageTitle = el("submitStageTitle");
  const submitStageMeta = el("submitStageMeta");
  const workspaceTitle = el("generateWorkspaceTitle");
  const settingsDisclosure = el("settingsDisclosure");
  const settingsDisclosureSummary = el("settingsDisclosureSummary");
  const imageModeWrap = el("imageGenerateModeWrap");
  const title = el("generatePageTitle");
  const hint = el("generatorActionHint");
  const button = el("btnSendChat");
  if (hint) {
    hint.textContent = isImage
      ? "准备好图片素材后，点击主按钮开始生成图片。"
      : (isQuickVideo ? "已选中场景图，上传 1 张模特图后即可开始生成视频。" : "模特图和商品图准备完成后，点击主按钮开始生成视频。");
  }
  if (button) {
    button.textContent = isImage ? "开始生成图片" : "开始生成视频";
  }
  if (workspaceTitle) workspaceTitle.textContent = isImage ? "图片生成工作区" : "视频生成工作区";
  if (briefVideoMeta) {
    let meta = briefVideoMeta.querySelector(".mode-brief-meta");
    if (!meta) {
      meta = document.createElement("div");
      meta.className = "mode-brief-meta";
      briefVideoMeta.appendChild(meta);
    }
    meta.textContent = isQuickVideo
      ? "已复用最近图片时，只需再上传 1 张模特图即可继续生成视频。"
      : "默认需要模特图 + 商品图，也支持复用最近图片继续生成视频。";
  }
  if (briefImageMeta) {
    let meta = briefImageMeta.querySelector(".mode-brief-meta");
    if (!meta) {
      meta = document.createElement("div");
      meta.className = "mode-brief-meta";
      briefImageMeta.appendChild(meta);
    }
    meta.textContent = "支持仅商品图，或模特图 + 商品图双图生成，当前走 ComfyUI 工作流。";
  }
  if (uploadStageTitle) uploadStageTitle.textContent = isImage ? "上传生成素材" : "上传视频素材";
  if (uploadStageMeta) {
    uploadStageMeta.textContent = isImage
      ? "根据模式上传商品图，或同时上传模特图和商品图。"
      : (isQuickVideo ? "当前已复用场景图，只需补充 1 张模特图。" : "先上传模特图，再上传商品图，可选运镜视频或口播音频。");
  }
  if (submitStageTitle) submitStageTitle.textContent = isImage ? "生成前检查" : "提交前检查";
  if (submitStageMeta) {
    submitStageMeta.textContent = isImage
      ? "确认图片素材、提示词和当前模式后开始生成。"
      : "确认素材、文案和上传状态后开始生成。";
  }
  if (settingsDisclosureSummary && settingsDisclosure) {
    settingsDisclosureSummary.textContent = settingsDisclosure.open ? "收起设置" : "展开设置";
  }
  if (imageModeWrap) imageModeWrap.style.display = isImage ? "grid" : "none";
  const recentSection = el("recentImageSection");
  const recentSideRail = el("recentSideRail");
  if (recentSection) recentSection.style.display = isImage ? "" : "none";
  if (recentSideRail) recentSideRail.style.display = isImage ? "block" : "none";
  if (recentSection) {
    recentSection.classList.toggle("recent-image-stage-active-source", Boolean(appState.generatedSceneTaskId) && !isImage);
  }
  updateImageModeUI();
  updateGenerateSteps();
  renderSubmitChecklist();
  syncTaskTypeTabs();
}

function updateGenerateSteps() {
  const taskType = getTaskType();
  const step1 = el("generateStep1");
  const step2 = el("generateStep2");
  const step3 = el("generateStep3");
  if (!step1 || !step2 || !step3) return;
  if (taskType === "image_generate") {
    const mode = String((el("imageGenerateMode") && el("imageGenerateMode").value) || "product_only").trim() || "product_only";
    if (mode === "product_only") {
      step1.innerHTML = "<span>1</span> 上传商品图";
      step2.innerHTML = "<span>2</span> 设置提示词";
      step3.innerHTML = "<span>3</span> 生成图片";
      return;
    }
    step1.innerHTML = "<span>1</span> 上传模特图";
    step2.innerHTML = "<span>2</span> 上传商品图";
    step3.innerHTML = "<span>3</span> 生成图片";
    return;
  }
  step1.innerHTML = "<span>1</span> 上传模特图";
  step2.innerHTML = "<span>2</span> 上传商品图";
  step3.innerHTML = "<span>3</span> 生成并下载";
}

function updateImageModeUI() {
  const taskType = getTaskType();
  const modeNode = el("imageGenerateMode");
  const mode = String((modeNode && modeNode.value) || "product_only").trim() || "product_only";
  const imageModeHint = el("imageModeHint");
  const modelSlot = el("modelSlot");
  const productSlot = el("productSlot");
  const modelSlotHint = el("modelSlotHint");
  const productSlotHint = el("productSlotHint");
  const isImageMode = taskType === "image_generate";
  const isProductOnly = isImageMode && mode === "product_only";
  const isModelProduct = isImageMode && mode === "model_product";
  const isQuickVideoMode = taskType === "commerce_video" && Boolean(appState.generatedSceneImagePath);
  if (imageModeHint) {
    imageModeHint.style.display = isImageMode ? "block" : "none";
    imageModeHint.textContent = isProductOnly
      ? "当前为仅商品图模式：只需上传商品图，模特图会自动弱化。"
      : "当前为模特图 + 商品图模式：请同时上传模特图和商品图。";
  }
  if (modelSlot) {
    modelSlot.classList.toggle("mode-optional", isProductOnly);
    modelSlot.classList.toggle("mode-required", isModelProduct || (!isImageMode && !appState.generatedSceneImagePath));
  }
  if (productSlot) {
    productSlot.classList.toggle("mode-optional", false);
    productSlot.classList.toggle("mode-required", isImageMode || (!isImageMode && !appState.generatedSceneImagePath));
  }
  if (modelSlotHint) {
    if (isImageMode) {
      modelSlotHint.textContent = isProductOnly ? "当前模式下可不上传模特图。" : "双图模式下必须上传模特图。";
    } else if (isQuickVideoMode) {
      modelSlotHint.textContent = "快速模式下必须上传 1 张模特图。";
    } else {
      modelSlotHint.textContent = "真人或模特展示图，建议竖图、主体清晰";
    }
  }
  if (productSlotHint) {
    if (isImageMode) {
      productSlotHint.textContent = isProductOnly ? "当前模式下必须上传商品图。" : "双图模式下必须上传商品图。";
    } else if (isQuickVideoMode) {
      productSlotHint.textContent = "当前已复用场景图，无需重复上传商品图。";
    } else {
      productSlotHint.textContent = "白底图、场景图或商品实拍均可";
    }
  }
}

function renderRecentImageTasks() {
  const host = el("recentImageList");
  if (!host) return;
  const rows = Array.isArray(userTaskState.recentImageTasks) ? userTaskState.recentImageTasks : [];
  if (!rows.length) {
    setRecentRailOpen(false);
    host.innerHTML = `
      <div class="task-empty task-empty-inline recent-image-empty">
        <div class="task-empty-title">还没有图片结果</div>
        <div class="small">上传商品图并点击上方主按钮后，最新生成图片会显示在这里。</div>
      </div>`;
    return;
  }
  setRecentRailOpen(rows.length > 0 && appState.recentRailOpen);
  host.innerHTML = rows.map((task, index) => {
    const output = task && task.output && typeof task.output === "object" ? task.output : {};
    const input = task && task.input && typeof task.input === "object" ? task.input : {};
    const scenePath = String(output.scene_image_path || output.image_path || "").trim();
    const mode = String(input.mode || output.mode || "product_only").trim() || "product_only";
    const modeLabel = mode === "model_product" ? "模特图 + 商品图" : "仅商品图";
    const isSuccess = String(task.status || "") === "success";
    const isFailed = String(task.status || "") === "failed";
    const isSelected = String(task.id || "") === String(appState.generatedSceneTaskId || "");
    const imageHint = task.has_download
      ? "图片已生成，可直接下载或继续生成视频。"
      : (isFailed ? `失败：${escapeHtml(publicMessage(task.error || output.error || "生成失败"))}` : "结果处理中");
    const primaryAction = scenePath && isSuccess
      ? `<button class="primary task-action-btn" type="button" data-act="continue_video" data-id="${escapeHtml(task.id)}" data-scene="${escapeHtml(scenePath)}">继续生成视频</button>`
      : (task.has_download ? `<button class="primary task-action-btn" type="button" data-act="download" data-id="${escapeHtml(task.id)}">下载图片</button>` : "");
    const secondaryAction = scenePath && isSuccess && task.has_download
      ? `<button class="ghost task-action-btn" type="button" data-act="download" data-id="${escapeHtml(task.id)}">仅下载图片</button>`
      : "";
    return `
      <article class="task-card recent-image-card task-card-status-${escapeHtml(String(task.status || "unknown"))}${isSelected ? " recent-image-card-selected" : ""}">
        <div class="recent-image-rank">最近成果 ${index + 1}</div>
        <div class="recent-image-card-media">${scenePath ? `<img class="recent-image-thumb-img" src="/api/tasks/${encodeURIComponent(String(task.id || ""))}/download" alt="${escapeHtml(scenePath.split(/[/\\]/).pop() || "图片结果")}" />` : `<div class="recent-image-thumb-placeholder">图片结果</div>`}</div>
        <div class="recent-image-card-body">
          <div class="task-card-title-row">
            <div class="task-card-title">${escapeHtml(taskTypeLabel(task.type))}</div>
            <span class="recent-image-mode">${escapeHtml(modeLabel)}</span>
            ${statusPill(task.status)}
          </div>
          <div class="task-card-subtitle">生成编号：${escapeHtml(String(task.id || "-"))}</div>
          <div class="recent-image-summary">${imageHint}</div>
          <div class="recent-image-hero${isFailed ? " is-failed" : ""}${isSuccess ? " is-success" : ""}">
            <div class="recent-image-hero-label">${isSuccess ? "当前可执行" : isFailed ? "当前状态" : "当前进度"}</div>
            <div class="recent-image-hero-value">${isSuccess ? (isSelected ? "已选为视频场景图" : "可一键继续生成视频") : isFailed ? "生成失败，可到记录区重试" : "等待生成完成后可下载或继续生成视频"}</div>
          </div>
          <div class="task-chip-row recent-image-chip-row">
            <span class="meta-chip">创建时间：${escapeHtml(formatTime(task.created_at))}</span>
            <span class="meta-chip">额度消耗：${escapeHtml(String(task.cost_cents || 0))} 分</span>
            ${scenePath ? `<span class="meta-chip">结果文件：已生成</span>` : `<span class="meta-chip">结果文件：处理中</span>`}
          </div>
          <div class="task-card-actions recent-image-actions">
            ${primaryAction}
            ${secondaryAction}
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function formatDashboardNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(Math.round(n));
}

function formatDashboardDate(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toLocaleString();
  return text;
}

function dashboardEntries(value) {
  return Object.entries(value || {})
    .map(([label, count]) => ({ label, value: Number(count || 0) }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);
}

function getPersonaDashboardRangeDays() {
  const range = String((el("personaDashboardRange") && el("personaDashboardRange").value) || "all").trim();
  const days = Number(range || 0);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

function filterPersonaDashboardTrend(rows) {
  const days = getPersonaDashboardRangeDays();
  if (!days) return rows || [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return (rows || []).filter((row) => {
    const date = new Date(row.date || "").getTime();
    return Number.isFinite(date) && date >= cutoff;
  });
}

function buildVisiblePersonaSummary(visiblePersonas, fallbackSummary = {}) {
  const padSet = new Set();
  const summary = {
    persona_count: visiblePersonas.length,
    post_count: 0,
    published_count: 0,
    image_count: 0,
    bound_pad_count: 0,
    total_interactions: 0,
    recent_views: 0,
    post_views: 0,
    hot_score: 0,
  };
  visiblePersonas.forEach((persona) => {
    const counts = persona.counts || {};
    const hot = persona.hot || {};
    summary.post_count += Number(counts.posts || 0);
    summary.published_count += Number(counts.published || 0);
    summary.image_count += Number(counts.images || 0);
    summary.recent_views += Number(hot.recent_views || 0);
    summary.post_views += Number(hot.post_views || 0);
    summary.hot_score += Number(hot.hot_score || 0);
    summary.total_interactions += Number(hot.likes || 0) + Number(hot.comments || 0) + Number(hot.shares || 0) + Number(hot.reposts || 0);
    if (persona.bound_pad_code) padSet.add(String(persona.bound_pad_code));
  });
  summary.bound_pad_count = padSet.size;
  if (!visiblePersonas.length && Number(fallbackSummary.persona_count || 0) === 0) return { ...fallbackSummary, ...summary };
  return summary;
}

function renderBarChart(hostId, rows, opts = {}) {
  const host = el(hostId);
  if (!host) return;
  const items = (rows || []).filter((row) => Number(row.value || 0) > 0).slice(0, opts.limit || 12);
  if (!items.length) {
    host.innerHTML = `<div class="persona-chart-empty">暂无可展示数据</div>`;
    return;
  }
  const max = Math.max(...items.map((row) => Number(row.value || 0)), 1);
  host.innerHTML = `
    <div class="persona-bar-list">
      ${items.map((row, index) => {
        const pct = Math.max(3, Math.round((Number(row.value || 0) / max) * 100));
        return `
          <div class="persona-bar-row">
            <div class="persona-bar-label"><span>${index + 1}</span>${escapeHtml(row.label || row.name || "-")}</div>
            <div class="persona-bar-track"><div class="persona-bar-fill" style="width:${pct}%"></div></div>
            <div class="persona-bar-value">${escapeHtml(formatDashboardNumber(row.value))}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderDonutChart(hostId, entries) {
  const host = el(hostId);
  if (!host) return;
  const rows = dashboardEntries(entries);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (!total) {
    host.innerHTML = `<div class="persona-chart-empty">暂无可展示数据</div>`;
    return;
  }
  const colors = ["#2563eb", "#f59e0b", "#16a34a", "#dc2626", "#7c3aed", "#0f766e"];
  let cursor = 0;
  const segments = rows.map((row, index) => {
    const start = cursor;
    const size = (row.value / total) * 100;
    cursor += size;
    return `${colors[index % colors.length]} ${start}% ${cursor}%`;
  }).join(", ");
  host.innerHTML = `
    <div class="persona-donut-wrap">
      <div class="persona-donut" style="background: conic-gradient(${segments})">
        <div><strong>${formatDashboardNumber(total)}</strong><span>总计</span></div>
      </div>
      <div class="persona-donut-legend">
        ${rows.map((row, index) => `
          <div><span style="background:${colors[index % colors.length]}"></span>${escapeHtml(row.label)}<b>${escapeHtml(formatDashboardNumber(row.value))}</b></div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderTrendChart(hostId, rows) {
  const host = el(hostId);
  if (!host) return;
  const items = (rows || []).slice(-30);
  if (!items.length) {
    host.innerHTML = `<div class="persona-chart-empty">暂无走势数据</div>`;
    return;
  }
  const width = 720;
  const height = 220;
  const pad = 28;
  const series = [
    { key: "published", label: "发布", color: "#2563eb" },
    { key: "post_views", label: "帖子浏览", color: "#f59e0b" },
    { key: "likes", label: "点赞", color: "#16a34a" },
  ];
  const max = Math.max(1, ...items.flatMap((row) => series.map((s) => Number(row[s.key] || 0))));
  const x = (index) => pad + (items.length === 1 ? 0 : (index / (items.length - 1)) * (width - pad * 2));
  const y = (value) => height - pad - (Number(value || 0) / max) * (height - pad * 2);
  const pathFor = (key) => items.map((row, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(row[key]).toFixed(1)}`).join(" ");
  host.innerHTML = `
    <svg class="persona-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="流量走势图">
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="persona-axis" />
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" class="persona-axis" />
      ${series.map((s) => `<path d="${pathFor(s.key)}" fill="none" stroke="${s.color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />`).join("")}
      ${items.map((row, index) => `<text x="${x(index)}" y="${height - 6}" text-anchor="middle">${escapeHtml(String(row.date || "").slice(5))}</text>`).join("")}
    </svg>
    <div class="persona-line-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("")}</div>
  `;
}

function personaMatchesFilters(persona) {
  const search = String((el("personaDashboardSearch") && el("personaDashboardSearch").value) || "").trim().toLowerCase();
  const platform = String((el("personaDashboardPlatform") && el("personaDashboardPlatform").value) || "").trim().toLowerCase();
  const pad = String((el("personaDashboardPad") && el("personaDashboardPad").value) || "").trim();
  const range = String((el("personaDashboardRange") && el("personaDashboardRange").value) || "all").trim();
  const haystack = [
    persona.name,
    persona.content,
    persona.bound_pad_code,
    persona.bound_pad_name,
    persona.owner_bot_name,
  ].join(" ").toLowerCase();
  if (search && !haystack.includes(search)) return false;
  if (pad && String(persona.bound_pad_code || "") !== pad) return false;
  if (platform) {
    const platforms = (persona.hot_platforms || []).map((item) => String(item.platform || "").toLowerCase());
    const platformPosts = Object.keys((persona.counts && persona.counts.platform_posts) || {}).map((item) => item.toLowerCase());
    if (!platforms.includes(platform) && !platformPosts.includes(platform)) return false;
  }
  if (range !== "all") {
    const days = Number(range || 0);
    const updated = new Date(persona.updated_at || persona.created_at || 0).getTime();
    if (Number.isFinite(days) && days > 0 && Number.isFinite(updated)) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      if (updated < cutoff) return false;
    }
  }
  return true;
}

function renderPersonaDashboardSummary(data, visiblePersonas) {
  const host = el("personaDashboardSummary");
  if (!host) return;
  const globalSummary = data.summary || {};
  const summary = buildVisiblePersonaSummary(visiblePersonas, globalSummary);
  const cards = [
    { label: "人设总数", value: summary.persona_count, hint: `全部 ${globalSummary.persona_count || 0}` },
    { label: "已生成帖子", value: summary.post_count, hint: "当前筛选归档帖子" },
    { label: "已发布", value: summary.published_count, hint: "当前筛选发布记录" },
    { label: "素材库图片", value: summary.image_count, hint: "当前筛选图片素材" },
    { label: "绑定设备", value: summary.bound_pad_count, hint: "当前筛选设备数" },
    { label: "总互动量", value: summary.total_interactions, hint: "当前筛选赞评转分享" },
    { label: "账号主页浏览", value: summary.recent_views, hint: "账号主页级浏览" },
    { label: "逐帖浏览合计", value: summary.post_views, hint: "逐帖浏览，不与主页浏览合并" },
    { label: "筛选热度", value: summary.hot_score, hint: "逐帖浏览 + 点赞 + 评论 + 分享 + 转发" },
  ];
  host.innerHTML = cards.map((card) => `
    <div class="kpi persona-kpi">
      <div class="label">${escapeHtml(card.label)}</div>
      <div class="num">${escapeHtml(formatDashboardNumber(card.value))}</div>
      <div class="small">${escapeHtml(card.hint)}</div>
    </div>
  `).join("");
}

function renderPersonaCard(persona) {
  const hot = personaDashboardFilteredHot(persona);
  const counts = persona.counts || {};
  const rows = persona.post_metrics || [];
  const pageSize = Math.max(5, Math.min(100, Number(appState.personaDashboardPageSize || 10)));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  appState.personaDashboardPostPage = Math.max(1, Math.min(pageCount, Number(appState.personaDashboardPostPage || 1)));
  const start = (appState.personaDashboardPostPage - 1) * pageSize;
  const platforms = (persona.hot_platforms || []).map((item) => `
    <div class="persona-platform-row">
      <strong>${escapeHtml(item.platform || "-")}</strong>
      <span>主页浏览 ${escapeHtml(formatDashboardNumber(item.recent_views))}</span>
      <span>帖子浏览 ${escapeHtml(formatDashboardNumber(item.post_views))}</span>
      <span>赞 ${escapeHtml(formatDashboardNumber(item.likes))}</span>
      <span>评 ${escapeHtml(formatDashboardNumber(item.comments))}</span>
      <span>${item.complete ? "完整" : "部分/未知"}</span>
    </div>
  `).join("");
  const postRows = rows.slice(start, start + pageSize).map((row) => `
    <tr>
      <td class="persona-post-platform">${escapeHtml(row.platform || "-")}</td>
      <td class="persona-post-source">
        <div>${escapeHtml(String(row.content || row.source_url || "-").slice(0, 120))}</div>
      </td>
      <td class="persona-post-number">${escapeHtml(formatDashboardNumber(row.like_count))}</td>
      <td class="persona-post-number">${escapeHtml(formatDashboardNumber(row.comment_count))}</td>
      <td class="persona-post-number">${escapeHtml(formatDashboardNumber(row.share_count || row.repost_count))}</td>
      <td class="persona-post-number">${escapeHtml(formatDashboardNumber(row.view_count))}</td>
      <td class="persona-post-actions">
        <button class="ghost" type="button" data-post-view="${escapeHtml(row.post_key || "")}">查看</button>
        <button class="ghost persona-post-delete" type="button" data-post-delete="${escapeHtml(row.post_key || "")}">删除</button>
      </td>
    </tr>
  `).join("");
  return `
    <article class="persona-detail-card">
      <div class="persona-detail-head">
        <div>
          <h3>${escapeHtml(persona.name || "未命名人设")}</h3>
          <div class="small">设备：${escapeHtml(persona.bound_pad_name || persona.bound_pad_code || "未绑定")} · 机器人：${escapeHtml(persona.owner_bot_name || "-")}</div>
        </div>
        <div class="persona-score">
          <span>热度</span>
          <strong>${escapeHtml(formatDashboardNumber(hot.hot_score))}</strong>
        </div>
      </div>
      <div class="persona-detail-grid">
        <div><span>帖子</span><strong>${escapeHtml(formatDashboardNumber(counts.posts))}</strong></div>
        <div><span>发布</span><strong>${escapeHtml(formatDashboardNumber(counts.published))}</strong></div>
        <div><span>素材</span><strong>${escapeHtml(formatDashboardNumber(counts.images))}</strong></div>
        <div><span>互动</span><strong>${escapeHtml(formatDashboardNumber(Number(hot.likes || 0) + Number(hot.comments || 0) + Number(hot.shares || 0) + Number(hot.reposts || 0)))}</strong></div>
        <div><span>主页浏览</span><strong>${escapeHtml(formatDashboardNumber(hot.recent_views))}</strong></div>
        <div><span>帖子浏览</span><strong>${escapeHtml(formatDashboardNumber(hot.post_views))}</strong></div>
      </div>
      <div class="persona-content-preview">${escapeHtml(persona.content || "暂无人设描述")}</div>
      <div class="persona-platform-list">${platforms || `<div class="small">暂无平台热点指标</div>`}</div>
      <div class="persona-table-wrap">
        <div class="persona-table-toolbar">
          <strong>发送推文指标</strong>
          <span>第 ${escapeHtml(String(appState.personaDashboardPostPage))} / ${escapeHtml(String(pageCount))} 页 · 共 ${escapeHtml(String(rows.length))} 条</span>
        </div>
        <table class="persona-post-table">
          <thead><tr><th>平台</th><th>推文内容 / 来源</th><th>点赞</th><th>评论</th><th>转发/分享</th><th>逐帖浏览</th><th>操作</th></tr></thead>
          <tbody>${postRows || `<tr><td colspan="7">暂无发送推文指标</td></tr>`}</tbody>
        </table>
      </div>
      <div class="persona-pager">
        <button class="ghost" type="button" id="personaPostPrev" ${appState.personaDashboardPostPage <= 1 ? "disabled" : ""}>上一页</button>
        <span>每页 ${escapeHtml(String(pageSize))} 条</span>
        <button class="ghost" type="button" id="personaPostNext" ${appState.personaDashboardPostPage >= pageCount ? "disabled" : ""}>下一页</button>
      </div>
      ${renderPersonaPostModal(persona)}
    </article>
  `;
}

function personaDashboardKey(persona, index = 0) {
  return String((persona && (persona.id || persona.name || persona.bound_pad_code)) || `persona-${index}`);
}

function findPersonaDashboardPostRow(persona, postKey) {
  const key = String(postKey || "");
  return (filteredPersonaPostRows(persona) || []).find((row) => String(row.post_key || "") === key) || null;
}

function renderPersonaPostModal(persona) {
  const row = appState.personaDashboardPostModalKey ? findPersonaDashboardPostRow(persona, appState.personaDashboardPostModalKey) : null;
  if (!row) return "";
  const details = row.details ? JSON.stringify(row.details, null, 2) : "";
  return `
    <div class="persona-post-modal" role="dialog" aria-modal="true" aria-label="推文详情">
      <div class="persona-post-modal-card">
        <div class="persona-post-modal-head">
          <div>
            <strong>推文详情</strong>
            <span>${escapeHtml(row.platform || "-")} · ${escapeHtml(row.published_at || row.captured_at || "无时间")}</span>
          </div>
          <button class="ghost" type="button" id="personaPostModalClose">关闭</button>
        </div>
        <div class="persona-post-modal-grid">
          <div><span>点赞</span><strong>${escapeHtml(formatDashboardNumber(row.like_count))}</strong></div>
          <div><span>评论</span><strong>${escapeHtml(formatDashboardNumber(row.comment_count))}</strong></div>
          <div><span>转发/分享</span><strong>${escapeHtml(formatDashboardNumber(row.share_count || row.repost_count))}</strong></div>
          <div><span>逐帖浏览</span><strong>${escapeHtml(formatDashboardNumber(row.view_count))}</strong></div>
        </div>
        <div class="persona-post-full-content">${escapeHtml(row.full_content || row.content || "暂无内容")}</div>
        ${row.source_url ? `<a class="persona-post-source-link" href="${escapeHtml(row.source_url)}" target="_blank" rel="noreferrer">打开原始链接</a>` : ""}
        <pre class="persona-post-raw">${escapeHtml(details || "暂无更多结构化信息")}</pre>
      </div>
    </div>
  `;
}

function renderPersonaTabs(visiblePersonas, selectedPersona) {
  const tabs = el("personaDashboardTabs");
  if (!tabs) return;
  const tabPageSize = 10;
  const tabPageCount = Math.max(1, Math.ceil(visiblePersonas.length / tabPageSize));
  appState.personaDashboardTabPage = Math.max(1, Math.min(tabPageCount, Number(appState.personaDashboardTabPage || 1)));
  const tabStart = (appState.personaDashboardTabPage - 1) * tabPageSize;
  const tabPersonas = visiblePersonas.slice(tabStart, tabStart + tabPageSize);
  tabs.innerHTML = `
    <div class="persona-tab-rail-head">
      <strong>分栏</strong>
      <span>${escapeHtml(String(visiblePersonas.length))} 人设</span>
    </div>
    <div class="persona-tab-list">
      <div class="persona-tab-section persona-tab-section-system">
      <button class="persona-tab ${appState.personaDashboardSelectedId === "__overview__" ? "is-active" : ""}" type="button" data-persona-id="__overview__" aria-current="${appState.personaDashboardSelectedId === "__overview__" ? "true" : "false"}">
        <span class="persona-tab-index">总</span>
        <span class="persona-tab-main"><strong>总览首页</strong><span>全部图表与指标</span></span>
        <span class="persona-tab-metrics"><b>${escapeHtml(formatDashboardNumber((appState.personaDashboard.summary || {}).persona_count))}</b><span>人设</span></span>
      </button>
      </div>
      <div class="persona-tab-section persona-tab-section-personas">
      ${tabPersonas.map((persona, pageIndex) => {
        const index = tabStart + pageIndex;
        const hot = persona.hot || {};
        const counts = persona.counts || {};
        const key = personaDashboardKey(persona, index);
        const active = selectedPersona && personaDashboardKey(selectedPersona, index) === key;
        return `
          <button class="persona-tab ${active ? "is-active" : ""}" type="button" data-persona-id="${escapeHtml(key)}" aria-current="${active ? "true" : "false"}">
            <span class="persona-tab-index">${index + 1}</span>
            <span class="persona-tab-main">
              <strong>${escapeHtml(persona.name || "未命名人设")}</strong>
              <span>${escapeHtml(persona.bound_pad_name || persona.bound_pad_code || "未绑定设备")}</span>
            </span>
            <span class="persona-tab-metrics">
              <b>${escapeHtml(formatDashboardNumber(hot.hot_score))}</b>
              <span>${escapeHtml(formatDashboardNumber(counts.published))} 发布</span>
            </span>
          </button>
        `;
      }).join("")}
      ${visiblePersonas.length > tabPageSize ? `
        <div class="persona-tab-pager">
          <button class="ghost" type="button" id="personaTabPrev" ${appState.personaDashboardTabPage <= 1 ? "disabled" : ""}>上一页</button>
          <span>第 ${escapeHtml(String(appState.personaDashboardTabPage))} / ${escapeHtml(String(tabPageCount))} 页</span>
          <button class="ghost" type="button" id="personaTabNext" ${appState.personaDashboardTabPage >= tabPageCount ? "disabled" : ""}>下一页</button>
        </div>
      ` : ""}
      </div>
      <div class="persona-tab-section persona-tab-section-system persona-tab-section-bottom">
      <button class="persona-tab persona-tab-settings ${appState.personaDashboardSelectedId === "__settings__" ? "is-active" : ""}" type="button" data-persona-id="__settings__" aria-current="${appState.personaDashboardSelectedId === "__settings__" ? "true" : "false"}">
        <span class="persona-tab-index">设</span>
        <span class="persona-tab-main"><strong>设置</strong><span>分页与显示数量</span></span>
        <span class="persona-tab-metrics"><b>${escapeHtml(String(appState.personaDashboardPageSize))}</b><span>每页</span></span>
      </button>
      </div>
    </div>
  `;
  tabs.querySelectorAll("[data-persona-id]").forEach((node) => {
    node.addEventListener("click", () => {
      appState.personaDashboardSelectedId = String(node.getAttribute("data-persona-id") || "");
      appState.personaDashboardPostPage = 1;
      renderPersonaDashboard();
    });
  });
  const tabPrev = el("personaTabPrev");
  const tabNext = el("personaTabNext");
  if (tabPrev) tabPrev.addEventListener("click", () => { appState.personaDashboardTabPage -= 1; renderPersonaDashboard(); });
  if (tabNext) tabNext.addEventListener("click", () => { appState.personaDashboardTabPage += 1; renderPersonaDashboard(); });
}

function renderPersonaSettings() {
  const settings = el("personaDashboardSettings");
  if (!settings) return;
  settings.innerHTML = `
    <div class="persona-settings-card">
      <div>
        <h3>设置</h3>
        <div class="small">调整单个人设推文表的分页数量。</div>
      </div>
      <label for="personaPageSizeInput">每页推文数量</label>
      <div class="persona-settings-row">
        <input id="personaPageSizeInput" type="number" min="5" max="100" step="5" value="${escapeHtml(String(appState.personaDashboardPageSize))}" />
        <button class="primary" type="button" id="personaPageSizeApply">应用</button>
      </div>
      <div class="small">可设置 5 到 100 条。数值越大，单页表格越长。</div>
    </div>
  `;
  const apply = el("personaPageSizeApply");
  if (apply) {
    apply.addEventListener("click", () => {
      const input = el("personaPageSizeInput");
      const next = Math.max(5, Math.min(100, Number(input && input.value) || 10));
      appState.personaDashboardPageSize = next;
      appState.personaDashboardPostPage = 1;
      localStorage.setItem("personaDashboardPageSize", String(next));
      renderPersonaDashboard();
    });
  }
}

function renderPersonaDashboard() {
  const data = appState.personaDashboard;
  const list = el("personaDashboardList");
  const empty = el("personaDashboardEmpty");
  const meta = el("personaDashboardMeta");
  const overview = el("personaOverviewPane");
  const settings = el("personaDashboardSettings");
  if (!data || !list || !empty) return;
  const visible = (data.personas || []).filter(personaMatchesFilters);
  let selected = visible.find((persona, index) => personaDashboardKey(persona, index) === String(appState.personaDashboardSelectedId || ""));
  if (!["__overview__", "__settings__"].includes(appState.personaDashboardSelectedId) && !selected && visible.length) {
    selected = visible[0];
    appState.personaDashboardSelectedId = personaDashboardKey(selected, 0);
  }
  renderPersonaDashboardSummary(data, visible);
  renderBarChart("personaHotRankChart", visible.map((item) => ({ label: item.name, value: item.hot && item.hot.hot_score })));
  renderDonutChart("personaPlatformChart", data.charts && data.charts.platform_distribution);
  renderDonutChart("personaCoverageChart", data.charts && data.charts.hot_coverage);
  renderTrendChart("personaTrendChart", filterPersonaDashboardTrend(data.charts && data.charts.trend));
  renderDonutChart("personaEngagementChart", data.charts && data.charts.engagement_mix);
  renderDonutChart("personaTaskStatusChart", data.charts && data.charts.task_status_distribution);
  renderPersonaTabs(visible, selected);
  renderPersonaSettings();
  const mode = appState.personaDashboardSelectedId;
  if (overview) overview.style.display = mode === "__overview__" ? "grid" : "none";
  if (settings) settings.style.display = mode === "__settings__" ? "grid" : "none";
  list.style.display = selected && mode !== "__overview__" && mode !== "__settings__" ? "grid" : "none";
  if (meta) meta.textContent = selected ? `当前显示 ${visible.length} / ${(data.personas || []).length} 个人设 · 已选：${selected.name || "未命名人设"}` : `当前显示 ${visible.length} / ${(data.personas || []).length} 个人设`;
  empty.style.display = visible.length ? "none" : "block";
  list.innerHTML = selected ? renderPersonaCard(selected) : "";
  const prev = el("personaPostPrev");
  const next = el("personaPostNext");
  if (prev) prev.addEventListener("click", () => { appState.personaDashboardPostPage -= 1; renderPersonaDashboard(); });
  if (next) next.addEventListener("click", () => { appState.personaDashboardPostPage += 1; renderPersonaDashboard(); });
}

function syncPersonaPadFilter(data) {
  const select = el("personaDashboardPad");
  if (!select) return;
  const current = select.value;
  const pads = Array.from(new Set((data.personas || []).map((item) => String(item.bound_pad_code || "").trim()).filter(Boolean))).sort();
  select.innerHTML = `<option value="">全部设备</option>${pads.map((pad) => `<option value="${escapeHtml(pad)}">${escapeHtml(pad)}</option>`).join("")}`;
  if (pads.includes(current)) select.value = current;
}

async function loadPersonaDashboard() {
  const msg = el("personaDashboardMsg");
  if (msg) {
    msg.textContent = "正在加载人设数据...";
    msg.className = "msg ok";
  }
  try {
    const data = await api("/api/persona_dashboard/overview");
    appState.personaDashboard = data;
    syncPersonaPadFilter(data);
    if (el("personaDashboardUpdated")) {
      const latest = data.summary && data.summary.latest_data_at;
      el("personaDashboardUpdated").textContent = `缓存读取：${formatDashboardDate(data.updated_at)} · 最近数据：${formatDashboardDate(latest)}`;
    }
    if (msg) msg.textContent = "";
    renderPersonaDashboard();
  } catch (err) {
    if (msg) {
      msg.textContent = publicMessage(err.detail || err.message || String(err));
      msg.className = "msg err";
    }
  }
}

let personaDashboardRefreshTaskId = "";

const PERSONA_DASHBOARD_LABELS = {
  likes: "点赞",
  comments: "评论",
  shares: "分享",
  reposts: "转发",
  complete: "完整数据",
  partial_or_unknown: "部分/未知",
  none: "暂无数据",
  queued: "排队中",
  running: "运行中",
  done: "已完成",
  success: "成功",
  failed: "失败",
  cancelled: "已取消",
  pending: "待处理",
};

function personaDashboardLabel(value) {
  const key = String(value || "").trim();
  return PERSONA_DASHBOARD_LABELS[key] || key || "-";
}

function formatDashboardNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(Math.round(n));
}

function dashboardEntries(value) {
  return Object.entries(value || {})
    .map(([label, count]) => ({ label: personaDashboardLabel(label), value: Number(count || 0) }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);
}

function personaDashboardDateInRange(value) {
  const days = getPersonaDashboardRangeDays();
  if (!days) return true;
  const ts = new Date(value || 0).getTime();
  if (!Number.isFinite(ts)) return false;
  return ts >= Date.now() - days * 24 * 60 * 60 * 1000;
}

function filterPersonaDashboardTrend(rows) {
  return (rows || []).filter((row) => personaDashboardDateInRange(row.date));
}

function personaDashboardPlatformFilter() {
  return String((el("personaDashboardPlatform") && el("personaDashboardPlatform").value) || "").trim().toLowerCase();
}

function personaDashboardPostRows(persona) {
  const platform = personaDashboardPlatformFilter();
  return (persona.post_metrics || []).filter((row) => {
    if (platform && String(row.platform || "").toLowerCase() !== platform) return false;
    return personaDashboardDateInRange(row.published_at || row.captured_at);
  });
}

function personaDashboardFilteredHot(persona) {
  const platform = personaDashboardPlatformFilter();
  const base = persona.hot || {};
  if (!platform) return base;
  const rows = (persona.hot_platforms || []).filter((item) => String(item.platform || "").toLowerCase() === platform);
  if (!rows.length) return {
    likes: 0,
    comments: 0,
    shares: 0,
    reposts: 0,
    recent_views: 0,
    post_views: 0,
    hot_score: 0,
  };
  return rows.reduce((sum, row) => {
    sum.likes += Number(row.likes || 0);
    sum.comments += Number(row.comments || 0);
    sum.shares += Number(row.shares || 0);
    sum.reposts += Number(row.reposts || 0);
    sum.recent_views += Number(row.recent_views || 0);
    sum.post_views += Number(row.post_views || 0);
    sum.hot_score += Number(row.likes || 0) + Number(row.comments || 0) + Number(row.shares || 0) + Number(row.reposts || 0) + Number(row.post_views || 0);
    return sum;
  }, { likes: 0, comments: 0, shares: 0, reposts: 0, recent_views: 0, post_views: 0, hot_score: 0 });
}

function buildVisiblePersonaSummary(visiblePersonas) {
  const padSet = new Set();
  const summary = {
    persona_count: visiblePersonas.length,
    post_count: 0,
    published_count: 0,
    image_count: 0,
    bound_pad_count: 0,
    total_interactions: 0,
    recent_views: 0,
    post_views: 0,
    hot_score: 0,
  };
  visiblePersonas.forEach((persona) => {
    const counts = persona.counts || {};
    const hot = personaDashboardFilteredHot(persona);
    summary.post_count += Number(counts.posts || 0);
    summary.published_count += Number(counts.published || 0);
    summary.image_count += Number(counts.images || 0);
    summary.recent_views += Number(hot.recent_views || 0);
    summary.post_views += Number(hot.post_views || 0);
    summary.hot_score += Number(hot.hot_score || 0);
    summary.total_interactions += Number(hot.likes || 0) + Number(hot.comments || 0) + Number(hot.shares || 0) + Number(hot.reposts || 0);
    if (persona.bound_pad_code) padSet.add(String(persona.bound_pad_code));
  });
  summary.bound_pad_count = padSet.size;
  return summary;
}

function buildPersonaDashboardCharts(visiblePersonas, data) {
  const platformDistribution = {};
  const engagement = { likes: 0, comments: 0, shares: 0, reposts: 0 };
  const taskStatus = {};
  const coverage = { complete: 0, partial_or_unknown: 0, none: 0 };
  visiblePersonas.forEach((persona) => {
    const hot = personaDashboardFilteredHot(persona);
    Object.keys(engagement).forEach((key) => { engagement[key] += Number(hot[key] || 0); });
    (persona.hot_platforms || []).forEach((item) => {
      const platform = String(item.platform || "").trim();
      if (platform) platformDistribution[platform] = (platformDistribution[platform] || 0) + 1;
    });
    Object.keys((persona.counts && persona.counts.platform_posts) || {}).forEach((platform) => {
      const count = Number(persona.counts.platform_posts[platform] || 0);
      if (count > 0) platformDistribution[platform] = (platformDistribution[platform] || 0) + count;
    });
    const platforms = persona.hot_platforms || [];
    if (!platforms.length) coverage.none += 1;
    else if (platforms.some((item) => item.complete)) coverage.complete += 1;
    else coverage.partial_or_unknown += 1;
    Object.entries((persona.queue && persona.queue.by_status) || {}).forEach(([status, count]) => {
      taskStatus[status] = (taskStatus[status] || 0) + Number(count || 0);
    });
  });
  return {
    platform_distribution: platformDistribution,
    engagement_mix: engagement,
    task_status_distribution: taskStatus,
    hot_coverage: coverage,
    trend: filterPersonaDashboardTrend(data.charts && data.charts.trend),
  };
}

function renderBarChart(hostId, rows, opts = {}) {
  const host = el(hostId);
  if (!host) return;
  const items = (rows || []).filter((row) => Number(row.value || 0) > 0).slice(0, opts.limit || 12);
  if (!items.length) {
    host.innerHTML = `<div class="persona-chart-empty">暂无可展示数据</div>`;
    return;
  }
  const max = Math.max(...items.map((row) => Number(row.value || 0)), 1);
  host.innerHTML = `
    <div class="persona-bar-list">
      ${items.map((row, index) => {
        const pct = Math.max(3, Math.round((Number(row.value || 0) / max) * 100));
        return `
          <div class="persona-bar-row">
            <div class="persona-bar-label"><span>${index + 1}</span>${escapeHtml(row.label || row.name || "-")}</div>
            <div class="persona-bar-track"><div class="persona-bar-fill" style="width:${pct}%"></div></div>
            <div class="persona-bar-value">${escapeHtml(formatDashboardNumber(row.value))}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderDonutChart(hostId, entries) {
  const host = el(hostId);
  if (!host) return;
  const rows = dashboardEntries(entries);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (!total) {
    host.innerHTML = `<div class="persona-chart-empty">暂无可展示数据</div>`;
    return;
  }
  const colors = ["#2563eb", "#f59e0b", "#16a34a", "#dc2626", "#7c3aed", "#0f766e"];
  let cursor = 0;
  const segments = rows.map((row, index) => {
    const start = cursor;
    const size = (row.value / total) * 100;
    cursor += size;
    return `${colors[index % colors.length]} ${start}% ${cursor}%`;
  }).join(", ");
  host.innerHTML = `
    <div class="persona-donut-wrap">
      <div class="persona-donut" style="background: conic-gradient(${segments})">
        <div><strong>${formatDashboardNumber(total)}</strong><span>总计</span></div>
      </div>
      <div class="persona-donut-legend">
        ${rows.map((row, index) => `
          <div><span style="background:${colors[index % colors.length]}"></span>${escapeHtml(row.label)}<b>${escapeHtml(formatDashboardNumber(row.value))}</b></div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderTrendChart(hostId, rows) {
  const host = el(hostId);
  if (!host) return;
  const items = (rows || []).slice(-30);
  if (!items.length) {
    host.innerHTML = `<div class="persona-chart-empty">暂无走势数据</div>`;
    return;
  }
  const width = 720;
  const height = 220;
  const pad = 28;
  const series = [
    { key: "published", label: "发布", color: "#2563eb" },
    { key: "post_views", label: "帖子浏览", color: "#f59e0b" },
    { key: "likes", label: "点赞", color: "#16a34a" },
  ];
  const max = Math.max(1, ...items.flatMap((row) => series.map((s) => Number(row[s.key] || 0))));
  const x = (index) => pad + (items.length === 1 ? 0 : (index / (items.length - 1)) * (width - pad * 2));
  const y = (value) => height - pad - (Number(value || 0) / max) * (height - pad * 2);
  const pathFor = (key) => items.map((row, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(row[key]).toFixed(1)}`).join(" ");
  host.innerHTML = `
    <svg class="persona-line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="流量走势图">
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="persona-axis" />
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" class="persona-axis" />
      ${series.map((s) => `<path d="${pathFor(s.key)}" fill="none" stroke="${s.color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />`).join("")}
      ${items.map((row, index) => `<text x="${x(index)}" y="${height - 6}" text-anchor="middle">${escapeHtml(String(row.date || "").slice(5))}</text>`).join("")}
    </svg>
    <div class="persona-line-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join("")}</div>
  `;
}

function personaMatchesFilters(persona) {
  const search = String((el("personaDashboardSearch") && el("personaDashboardSearch").value) || "").trim().toLowerCase();
  const platform = personaDashboardPlatformFilter();
  const pad = String((el("personaDashboardPad") && el("personaDashboardPad").value) || "").trim();
  const haystack = [persona.name, persona.content, persona.bound_pad_code, persona.bound_pad_name, persona.owner_bot_name, persona.threads_account && persona.threads_account.handle].join(" ").toLowerCase();
  if (search && !haystack.includes(search)) return false;
  if (pad && String(persona.bound_pad_code || "") !== pad) return false;
  if (platform) {
    const platforms = (persona.hot_platforms || []).map((item) => String(item.platform || "").toLowerCase());
    const platformPosts = Object.keys((persona.counts && persona.counts.platform_posts) || {}).map((item) => item.toLowerCase());
    if (!platforms.includes(platform) && !platformPosts.includes(platform)) return false;
  }
  return personaDashboardDateInRange(persona.updated_at || persona.created_at);
}

function renderPersonaDashboardSummary(data, visiblePersonas) {
  const host = el("personaDashboardSummary");
  if (!host) return;
  const globalSummary = data.summary || {};
  const summary = buildVisiblePersonaSummary(visiblePersonas);
  const cards = [
    { label: "人设总数", value: summary.persona_count, hint: `全部 ${globalSummary.persona_count || 0}` },
    { label: "已生成帖子", value: summary.post_count, hint: "当前筛选归档帖子" },
    { label: "已发布", value: summary.published_count, hint: "当前筛选发布记录" },
    { label: "素材库图片", value: summary.image_count, hint: "当前筛选图片素材" },
    { label: "绑定设备", value: summary.bound_pad_count, hint: "当前筛选设备数" },
    { label: "总互动量", value: summary.total_interactions, hint: "点赞、评论、转发、分享" },
    { label: "账号主页浏览", value: summary.recent_views, hint: "账号主页级浏览" },
    { label: "逐帖浏览合计", value: summary.post_views, hint: "逐帖浏览，不与主页浏览合并" },
    { label: "筛选热度", value: summary.hot_score, hint: "当前列表合计" },
  ];
  host.innerHTML = cards.map((card) => `
    <div class="kpi persona-kpi">
      <div class="label">${escapeHtml(card.label)}</div>
      <div class="num">${escapeHtml(formatDashboardNumber(card.value))}</div>
      <div class="small">${escapeHtml(card.hint)}</div>
    </div>
  `).join("");
}

function renderPersonaCard(persona) {
  const hot = persona.hot || {};
  const counts = persona.counts || {};
  const rows = personaDashboardPostRows(persona);
  const pageSize = Math.max(5, Math.min(100, Number(appState.personaDashboardPageSize || 10)));
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  appState.personaDashboardPostPage = Math.max(1, Math.min(pageCount, Number(appState.personaDashboardPostPage || 1)));
  const start = (appState.personaDashboardPostPage - 1) * pageSize;
  const threads = persona.threads_account || {};
  const accountPlatform = String(appState.personaDashboardAccountPlatform || "threads").toLowerCase();
  const isThreadsPlatform = accountPlatform === "threads";
  const warnings = (persona.warnings || []).map((item) => `<div class="persona-warning-item">${escapeHtml(item)}</div>`).join("");
  const platforms = (persona.hot_platforms || []).map((item) => `
    <div class="persona-platform-row">
      <strong>${escapeHtml(item.platform || "-")}</strong>
      <span>账号主页浏览 ${escapeHtml(formatDashboardNumber(item.recent_views))}</span>
      <span>逐帖浏览 ${escapeHtml(formatDashboardNumber(item.post_views))}</span>
      <span>赞 ${escapeHtml(formatDashboardNumber(item.likes))}</span>
      <span>评 ${escapeHtml(formatDashboardNumber(item.comments))}</span>
      <span>${item.complete ? "完整" : "部分/未知"}</span>
    </div>
  `).join("");
  const postRows = rows.slice(start, start + pageSize).map((row) => `
    <tr>
      <td class="persona-post-platform">${escapeHtml(row.platform || "-")}</td>
      <td class="persona-post-source">
        <div>${escapeHtml(String(row.content || row.source_url || "-").slice(0, 120))}</div>
      </td>
      <td class="persona-post-number">${escapeHtml(formatDashboardNumber(row.like_count))}</td>
      <td class="persona-post-number">${escapeHtml(formatDashboardNumber(row.comment_count))}</td>
      <td class="persona-post-number">${escapeHtml(formatDashboardNumber(row.share_count || row.repost_count))}</td>
      <td class="persona-post-number">${escapeHtml(formatDashboardNumber(row.view_count))}</td>
      <td class="persona-post-actions">
        <button class="ghost" type="button" data-post-view="${escapeHtml(row.post_key || "")}">查看</button>
        <button class="ghost persona-post-delete" type="button" data-post-delete="${escapeHtml(row.post_key || "")}">删除</button>
      </td>
    </tr>
  `).join("");
  return `
    <article class="persona-detail-card">
      <div class="persona-detail-head">
        <div>
          <h3>${escapeHtml(persona.name || "未命名人设")}</h3>
          <div class="small">设备：${escapeHtml(persona.bound_pad_name || persona.bound_pad_code || "未绑定")} · 机器人：${escapeHtml(persona.owner_bot_name || "-")}</div>
        </div>
        <div class="persona-account-compact">
          <div class="persona-account-title">
            <label for="personaAccountPlatform">账号平台</label>
            <span>${isThreadsPlatform ? "绑定后可刷新该账号热点" : "当前仅展示平台切换"}</span>
          </div>
          <div class="persona-account-grid">
            <select id="personaAccountPlatform">
              <option value="threads" ${isThreadsPlatform ? "selected" : ""}>Threads</option>
              <option value="telegram" ${accountPlatform === "telegram" ? "selected" : ""}>Telegram</option>
            </select>
            <input id="personaThreadsInput" type="text" value="${isThreadsPlatform ? escapeHtml(threads.handle || "") : ""}" placeholder="${isThreadsPlatform ? "username" : "暂未接入 Telegram 绑定"}" ${isThreadsPlatform ? "" : "disabled"} />
          </div>
          <div class="persona-account-actions">
            <button class="ghost" type="button" id="personaBindThreadsBtn" ${isThreadsPlatform ? "" : "disabled"}>保存</button>
            <button class="ghost persona-unbind-btn" type="button" id="personaUnbindThreadsBtn" ${isThreadsPlatform && threads.handle ? "" : "disabled"}>解绑</button>
            <button class="primary" type="button" id="personaRefreshCurrentBtn">刷新当前人设</button>
            <button class="primary persona-hot-refresh-btn" type="button" id="personaRefreshBoundHotBtn" ${isThreadsPlatform && threads.handle ? "" : "disabled"}>刷新绑定账号热点</button>
          </div>
        </div>
        <div class="persona-score">
          <span>热度</span>
          <strong>${escapeHtml(formatDashboardNumber(hot.hot_score))}</strong>
          <small>${escapeHtml(persona.hot_score_formula || "热度 = 逐帖浏览 + 点赞 + 评论 + 分享 + 转发")}</small>
        </div>
      </div>
      ${warnings ? `<div class="persona-warning-list">${warnings}</div>` : ""}
      <div class="persona-bind-hint">
        <span>${isThreadsPlatform ? "没有绑定时无法抓取该人设账号热点；刷新会使用服务器端已保存的浏览器授权。" : "Telegram 账号绑定和热点抓取暂未接入；切回 Threads 可保存、解绑和刷新热点。"}</span>
      </div>
      <div class="persona-detail-grid">
        <div><span>帖子</span><strong>${escapeHtml(formatDashboardNumber(counts.posts))}</strong></div>
        <div><span>发布</span><strong>${escapeHtml(formatDashboardNumber(counts.published))}</strong></div>
        <div><span>素材</span><strong>${escapeHtml(formatDashboardNumber(counts.images))}</strong></div>
        <div><span>互动</span><strong>${escapeHtml(formatDashboardNumber(Number(hot.likes || 0) + Number(hot.comments || 0) + Number(hot.shares || 0) + Number(hot.reposts || 0)))}</strong></div>
        <div><span>账号主页浏览</span><strong>${escapeHtml(formatDashboardNumber(hot.recent_views))}</strong></div>
        <div><span>逐帖浏览</span><strong>${escapeHtml(formatDashboardNumber(hot.post_views))}</strong></div>
      </div>
      <div class="persona-content-preview">${escapeHtml(persona.content || "暂无人设描述")}</div>
      <div class="persona-platform-list">${platforms || `<div class="small">暂无平台热点指标</div>`}</div>
      <div class="persona-table-wrap">
        <div class="persona-table-toolbar">
          <strong>发送推文指标</strong>
          <span>第 ${escapeHtml(String(appState.personaDashboardPostPage))} / ${escapeHtml(String(pageCount))} 页 · 共 ${escapeHtml(String(rows.length))} 条</span>
        </div>
        <table class="persona-post-table">
          <thead><tr><th>平台</th><th>推文内容 / 来源</th><th>点赞</th><th>评论</th><th>转发/分享</th><th>逐帖浏览</th><th>操作</th></tr></thead>
          <tbody>${postRows || `<tr><td colspan="7">暂无发送推文指标</td></tr>`}</tbody>
        </table>
      </div>
      <div class="persona-pager">
        <button class="ghost" type="button" id="personaPostPrev" ${appState.personaDashboardPostPage <= 1 ? "disabled" : ""}>上一页</button>
        <span>每页 ${escapeHtml(String(pageSize))} 条</span>
        <button class="ghost" type="button" id="personaPostNext" ${appState.personaDashboardPostPage >= pageCount ? "disabled" : ""}>下一页</button>
      </div>
      ${renderPersonaPostModal(persona)}
    </article>
  `;
}

function renderPersonaSettings() {
  const settings = el("personaDashboardSettings");
  if (!settings) return;
  settings.innerHTML = `
    <div class="persona-settings-card">
      <div>
        <h3>设置</h3>
        <div class="small">调整单个人设推文表的分页数量，并可手动刷新全部已绑定账号。</div>
      </div>
      <label for="personaPageSizeInput">每页推文数量</label>
      <div class="persona-settings-row">
        <input id="personaPageSizeInput" type="number" min="5" max="100" step="5" value="${escapeHtml(String(appState.personaDashboardPageSize))}" />
        <button class="primary" type="button" id="personaPageSizeApply">应用</button>
      </div>
      <div class="persona-settings-row persona-settings-row-left">
        <button class="primary" type="button" id="personaRefreshAllBtn">全量刷新全部已绑定人设</button>
        <span class="small">无绑定的人设会跳过并在结果里提示。</span>
      </div>
      <div class="small">可设置 5 到 100 条。刷新过程中可留在页面查看任务状态。</div>
    </div>
  `;
  const apply = el("personaPageSizeApply");
  if (apply) {
    apply.addEventListener("click", () => {
      const input = el("personaPageSizeInput");
      const next = Math.max(5, Math.min(100, Number(input && input.value) || 10));
      appState.personaDashboardPageSize = next;
      appState.personaDashboardPostPage = 1;
      localStorage.setItem("personaDashboardPageSize", String(next));
      renderPersonaDashboard();
    });
  }
  const refreshAll = el("personaRefreshAllBtn");
  if (refreshAll) refreshAll.addEventListener("click", () => startPersonaDashboardRefresh(""));
}

function renderPersonaDashboard() {
  const data = appState.personaDashboard;
  const list = el("personaDashboardList");
  const empty = el("personaDashboardEmpty");
  const meta = el("personaDashboardMeta");
  const overview = el("personaOverviewPane");
  const settings = el("personaDashboardSettings");
  if (!data || !list || !empty) return;
  const visible = (data.personas || []).filter(personaMatchesFilters);
  let selected = visible.find((persona, index) => personaDashboardKey(persona, index) === String(appState.personaDashboardSelectedId || ""));
  if (!["__overview__", "__settings__"].includes(appState.personaDashboardSelectedId) && !selected && visible.length) {
    selected = visible[0];
    appState.personaDashboardSelectedId = personaDashboardKey(selected, 0);
  }
  const charts = buildPersonaDashboardCharts(visible, data);
  renderPersonaDashboardSummary(data, visible);
  renderBarChart("personaHotRankChart", visible.map((item) => ({ label: item.name, value: item.hot && item.hot.hot_score })));
  renderDonutChart("personaPlatformChart", charts.platform_distribution);
  renderDonutChart("personaCoverageChart", charts.hot_coverage);
  renderTrendChart("personaTrendChart", charts.trend);
  renderDonutChart("personaEngagementChart", charts.engagement_mix);
  renderDonutChart("personaTaskStatusChart", charts.task_status_distribution);
  renderPersonaTabs(visible, selected);
  renderPersonaSettings();
  const mode = appState.personaDashboardSelectedId;
  if (overview) overview.style.display = mode === "__overview__" ? "grid" : "none";
  if (settings) settings.style.display = mode === "__settings__" ? "grid" : "none";
  list.style.display = selected && mode !== "__overview__" && mode !== "__settings__" ? "grid" : "none";
  if (meta) meta.textContent = selected ? `当前显示 ${visible.length} / ${(data.personas || []).length} 个人设 · 已选：${selected.name || "未命名人设"}` : `当前显示 ${visible.length} / ${(data.personas || []).length} 个人设`;
  empty.style.display = visible.length ? "none" : "block";
  list.innerHTML = selected ? renderPersonaCard(selected) : "";
  const prev = el("personaPostPrev");
  const next = el("personaPostNext");
  const bind = el("personaBindThreadsBtn");
  const unbind = el("personaUnbindThreadsBtn");
  const accountPlatform = el("personaAccountPlatform");
  const refreshCurrent = el("personaRefreshCurrentBtn");
  const refreshBoundHot = el("personaRefreshBoundHotBtn");
  const modalClose = el("personaPostModalClose");
  if (prev) prev.addEventListener("click", () => { appState.personaDashboardPostPage -= 1; renderPersonaDashboard(); });
  if (next) next.addEventListener("click", () => { appState.personaDashboardPostPage += 1; renderPersonaDashboard(); });
  if (bind && selected) bind.addEventListener("click", () => bindPersonaDashboardThreads(selected));
  if (unbind && selected) unbind.addEventListener("click", () => unbindPersonaDashboardThreads(selected));
  if (accountPlatform) {
    accountPlatform.addEventListener("change", () => {
      appState.personaDashboardAccountPlatform = String(accountPlatform.value || "threads");
      localStorage.setItem("personaDashboardAccountPlatform", appState.personaDashboardAccountPlatform);
      renderPersonaDashboard();
    });
  }
  if (refreshCurrent && selected) refreshCurrent.addEventListener("click", () => startPersonaDashboardRefresh(selected.id, "已请求刷新当前人设..."));
  if (refreshBoundHot && selected) refreshBoundHot.addEventListener("click", () => startPersonaDashboardRefresh(selected.id, "已请求刷新该绑定账号的全量热点信息..."));
  if (modalClose) modalClose.addEventListener("click", () => { appState.personaDashboardPostModalKey = ""; renderPersonaDashboard(); });
  list.querySelectorAll("[data-post-view]").forEach((node) => {
    node.addEventListener("click", () => {
      appState.personaDashboardPostModalKey = String(node.getAttribute("data-post-view") || "");
      renderPersonaDashboard();
    });
  });
  list.querySelectorAll("[data-post-delete]").forEach((node) => {
    node.addEventListener("click", () => {
      const postKey = String(node.getAttribute("data-post-delete") || "");
      if (selected && postKey) deletePersonaDashboardPost(selected, postKey);
    });
  });
}

function syncPersonaPadFilter(data) {
  const select = el("personaDashboardPad");
  if (!select) return;
  const current = select.value;
  const pads = Array.from(new Set((data.personas || []).map((item) => String(item.bound_pad_code || "").trim()).filter(Boolean))).sort();
  select.innerHTML = `<option value="">全部设备</option>${pads.map((pad) => `<option value="${escapeHtml(pad)}">${escapeHtml(pad)}</option>`).join("")}`;
  if (pads.includes(current)) select.value = current;
}

function setPersonaDashboardMessage(text, ok = true) {
  const msg = el("personaDashboardMsg");
  if (!msg) return;
  msg.textContent = text || "";
  msg.className = text ? `msg ${ok ? "ok" : "err"}` : "msg";
}

async function loadPersonaDashboard() {
  setPersonaDashboardMessage("正在加载人设数据...", true);
  try {
    const data = await api("/api/persona_dashboard/overview");
    appState.personaDashboard = data;
    syncPersonaPadFilter(data);
    if (el("personaDashboardUpdated")) {
      const latest = data.summary && data.summary.latest_data_at;
      el("personaDashboardUpdated").textContent = `缓存读取：${formatDashboardDate(data.updated_at)} · 最近数据：${formatDashboardDate(latest)}`;
    }
    setPersonaDashboardMessage("", true);
    renderPersonaDashboard();
  } catch (err) {
    setPersonaDashboardMessage(publicMessage(err.detail || err.message || String(err)), false);
  }
}

async function bindPersonaDashboardThreads(persona) {
  const input = el("personaThreadsInput");
  try {
    setPersonaDashboardMessage("正在保存 Threads 绑定...", true);
    await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/threads_binding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: input ? input.value : "" }),
    });
    setPersonaDashboardMessage("绑定已保存。可以点击刷新当前人设抓取数据。", true);
    await loadPersonaDashboard();
  } catch (err) {
    setPersonaDashboardMessage(publicMessage(err.detail || err.message || String(err)), false);
  }
}

async function unbindPersonaDashboardThreads(persona) {
  try {
    setPersonaDashboardMessage("正在解除 Threads 绑定...", true);
    await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/threads_binding`, {
      method: "DELETE",
    });
    setPersonaDashboardMessage("账号绑定已解除，旧账号热点缓存已清理。", true);
    await loadPersonaDashboard();
  } catch (err) {
    setPersonaDashboardMessage(publicMessage(err.detail || err.message || String(err)), false);
  }
}

async function deletePersonaDashboardPost(persona, postKey) {
  const ok = window.confirm("确认删除这条推文记录？删除后会立即从当前看板缓存中移除。");
  if (!ok) return;
  try {
    setPersonaDashboardMessage("正在删除推文记录...", true);
    await api(`/api/persona_dashboard/personas/${encodeURIComponent(persona.id)}/posts/${encodeURIComponent(postKey)}`, {
      method: "DELETE",
    });
    appState.personaDashboardPostModalKey = "";
    setPersonaDashboardMessage("推文记录已删除，正在刷新看板...", true);
    await loadPersonaDashboard();
  } catch (err) {
    setPersonaDashboardMessage(publicMessage(err.detail || err.message || String(err)), false);
  }
}

async function startPersonaDashboardRefresh(archiveId, message) {
  try {
    setPersonaDashboardMessage(message || (archiveId ? "已请求刷新当前人设..." : "已请求全量刷新..."), true);
    const task = await api("/api/persona_dashboard/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archive_id: archiveId || "" }),
    });
    personaDashboardRefreshTaskId = task.id;
    pollPersonaDashboardRefresh(task.id);
  } catch (err) {
    setPersonaDashboardMessage(publicMessage(err.detail || err.message || String(err)), false);
  }
}

async function pollPersonaDashboardRefresh(taskId) {
  if (!taskId || taskId !== personaDashboardRefreshTaskId) return;
  try {
    const task = await api(`/api/persona_dashboard/refresh/${encodeURIComponent(taskId)}`);
    const progress = Number(task.progress || 0);
    const step = task.step ? `步骤：${task.step} · ` : "";
    const elapsed = task.elapsed_seconds ? ` · 已执行 ${task.elapsed_seconds} 秒` : "";
    setPersonaDashboardMessage(`刷新任务：${personaDashboardLabel(task.status)} · ${step}进度 ${progress}%${elapsed}。${task.message || ""}`, task.status !== "failed");
    if (["queued", "running"].includes(String(task.status))) {
      window.setTimeout(() => pollPersonaDashboardRefresh(taskId), 2500);
      return;
    }
    personaDashboardRefreshTaskId = "";
    await loadPersonaDashboard();
    setPersonaDashboardMessage(task.status === "failed" ? `刷新失败：${task.message || "请检查浏览器授权或账号绑定。"}` : "刷新完成，数据已重新读取。", task.status !== "failed");
  } catch (err) {
    personaDashboardRefreshTaskId = "";
    setPersonaDashboardMessage(publicMessage(err.detail || err.message || String(err)), false);
  }
}

async function loadTasks() {
  const list = await api("/api/tasks?limit=120");
  const tasks = list.items || [];
  userTaskState.rows = tasks;
  const imageTasks = tasks.filter((task) => String(task.type || "") === "image_generate").slice(0, 8);
  userTaskState.recentImageTasks = await Promise.all(
    imageTasks.map(async (task) => {
      try {
        return await api(`/api/tasks/${task.id}`);
      } catch {
        return task;
      }
    })
  );
  syncTaskFilterOptions(
    "taskStatusFilter",
    Array.from(new Set(tasks.map((task) => String(task.status || "").trim()).filter(Boolean))).sort(),
    "全部状态",
  );
  renderTasks();
  renderRecentImageTasks();
  if (el("taskLastUpdated")) el("taskLastUpdated").textContent = `最近刷新：${new Date().toLocaleTimeString()}`;
}

function taskTypeLabel(taskType) {
  return TASK_LABELS[String(taskType || "").trim()] || String(taskType || "-");
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function publicMessage(text) {
  let value = oneLine(text);
  if (!value) return "";
  if (/Gemini|Nano|API\s*Key|Key\/Host|api_key|gemini_|nano_/i.test(value)) {
    value = value
      .replace(/启用\s*AI\s*分析需先在后台配置\s*Gemini\s*Key\/Host/gi, "智能分析服务未配置，请联系运营管理员")
      .replace(/缺少\s*Gemini\s*(API\s*)?Key/gi, "智能分析服务未配置，请联系运营管理员")
      .replace(/缺少\s*Nano(?:\s*Banana)?\s*(API\s*)?Key/gi, "图片生成服务未配置，请联系运营管理员")
      .replace(/Gemini/gi, "智能分析服务")
      .replace(/Nano Banana|Nano/gi, "图片生成服务")
      .replace(/API\s*Key/gi, "服务密钥")
      .replace(/\bKey\/Host\b/gi, "配置项")
      .replace(/\bKey\b/gi, "服务密钥")
      .replace(/\bHost\b/gi, "服务地址")
      .replace(/api_key|gemini_|nano_/gi, "配置项");
  }
  return value
    .replace(/任务已进入队列/g, "生成已进入队列")
    .replace(/任务开始执行/g, "开始生成")
    .replace(/任务处理中/g, "生成处理中")
    .replace(/任务失败/g, "生成失败")
    .replace(/任务结束/g, "生成完成")
    .replace(/任务/g, "生成");
}

function syncTaskFilterOptions(id, values, defaultLabel) {
  const node = el(id);
  if (!node) return;
  const current = String(node.value || "");
  node.innerHTML = [`<option value="">${escapeHtml(defaultLabel)}</option>`]
    .concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`))
    .join("");
  node.value = values.includes(current) ? current : "";
}

function getTaskFilters() {
  return {
    search: String((el("taskSearch") && el("taskSearch").value) || "").trim().toLowerCase(),
    status: String((el("taskStatusFilter") && el("taskStatusFilter").value) || "").trim(),
    type: String((el("taskTypeQuickFilter") && el("taskTypeQuickFilter").value) || "").trim(),
  };
}

function taskSearchText(task) {
  return [
    task && task.id,
    task && task.type,
    taskTypeLabel(task && task.type),
    task && task.status,
    task && task.error,
  ].map((value) => oneLine(value)).join(" ").toLowerCase();
}

function filterTasks(rows) {
  const filters = getTaskFilters();
  return rows.filter((task) => {
    if (filters.search && !taskSearchText(task).includes(filters.search)) return false;
    if (filters.status && String(task.status || "") !== filters.status) return false;
    if (filters.type && String(task.type || "") !== filters.type) return false;
    return true;
  });
}

function renderTaskSummary(allRows, visibleRows) {
  const host = el("taskSummary");
  if (!host) return;
  const runningCount = visibleRows.filter((task) => ["running", "queued"].includes(String(task.status || ""))).length;
  const successCount = visibleRows.filter((task) => String(task.status || "") === "success").length;
  const failedCount = visibleRows.filter((task) => String(task.status || "") === "failed").length;
  const totalCost = visibleRows.reduce((sum, task) => sum + Number(task.cost_cents || 0), 0);
  const cards = [
    { label: "当前显示", value: visibleRows.length, hint: `全部记录 ${allRows.length}` },
    { label: "运行中 / 排队", value: runningCount, hint: "实时状态" },
    { label: "已成功", value: successCount, hint: `失败 ${failedCount}` },
    { label: "累计消耗", value: totalCost, hint: "单位：分" },
  ];
  host.innerHTML = cards.map((card) => `
    <div class="kpi task-kpi">
      <div class="label">${escapeHtml(card.label)}</div>
      <div class="num">${escapeHtml(String(card.value))}</div>
      <div class="small">${escapeHtml(card.hint)}</div>
    </div>
  `).join("");
}

function taskActionButtons(task) {
  const status = String(task.status || "").trim();
  const taskType = String(task.type || "").trim();
  const buttons = [];
  if (status === "success") {
    buttons.push(`<button class="blue task-action-btn" type="button" data-act="download" data-id="${escapeHtml(task.id)}">下载结果</button>`);
  }
  if (status === "failed") {
    buttons.push(`<button class="primary task-action-btn" type="button" data-act="retry" data-id="${escapeHtml(task.id)}">重试</button>`);
    if (taskType === "commerce_video") {
      buttons.push(`<button class="ghost task-action-btn" type="button" data-act="retry_resume" data-id="${escapeHtml(task.id)}">断点重试</button>`);
    }
  }
  buttons.push(`<button class="ghost task-action-btn" type="button" data-act="detail" data-id="${escapeHtml(task.id)}">详情</button>`);
  buttons.push(`<button class="ghost task-action-btn" type="button" data-act="delete_task" data-id="${escapeHtml(task.id)}">删除</button>`);
  return buttons.join("");
}

function renderTaskCard(task) {
  const status = String(task.status || "").trim() || "unknown";
  const errorText = publicMessage(task.error || "");
  const shortErrorText = errorText ? oneLine(errorText).slice(0, 56) : "";
  const output = task && task.output && typeof task.output === "object" ? task.output : {};
  const input = task && task.input && typeof task.input === "object" ? task.input : {};
  const scenePath = String(output.scene_image_path || output.image_path || "").trim();
  const mode = String(input.mode || output.mode || "product_only").trim() || "product_only";
  const modeLabel = mode === "model_product" ? "模特图 + 商品图" : "仅商品图";
  const taskType = String(task.type || "").trim();
  const isImageTask = taskType === "image_generate";
  const isSuccess = status === "success";
  const isFailed = status === "failed";
  const resultSummary = isImageTask
    ? (isSuccess ? "图片已生成，可下载或继续生成视频" : isFailed ? "图片生成失败，可重新发起" : "图片生成处理中")
    : (isSuccess ? "视频已生成，可直接下载" : isFailed ? "视频生成失败，可重新发起" : "视频生成处理中");
  const heroLabel = isSuccess
    ? (isImageTask ? "本条记录已完成，可直接取用成果" : "视频已完成，可直接下载" )
    : (isFailed ? "本条记录执行失败，需要处理" : "本条记录仍在处理中");
  const failureSummary = isFailed ? (shortErrorText || "生成失败，可查看详情继续排查") : "";
  const heroTone = isSuccess ? " is-success" : isFailed ? " is-failed" : " is-running";
  return `
    <article class="task-card task-card-status-${escapeHtml(status)}${isImageTask ? " task-card-image-result" : ""}">
      <div class="task-card-head">
        <div class="task-card-main">
          <div class="task-card-title-row">
            <div class="task-card-title">${escapeHtml(taskTypeLabel(task.type))}</div>
            ${isImageTask ? `<span class="recent-image-mode">${escapeHtml(modeLabel)}</span>` : ""}
            ${statusPill(task.status)}
          </div>
          <div class="task-card-subtitle">生成编号：${escapeHtml(String(task.id || "-"))}</div>
        </div>
        <div class="task-card-actions">
          ${taskActionButtons(task)}
          ${isImageTask && scenePath && isSuccess ? `<button class="primary task-action-btn" type="button" data-act="continue_video" data-id="${escapeHtml(task.id)}" data-scene="${escapeHtml(scenePath)}">继续生成视频</button>` : ""}
        </div>
      </div>
      ${isImageTask && scenePath ? `<div class="task-card-preview-row"><div class="recent-image-thumb recent-image-thumb-history"><img class="recent-image-thumb-img" src="/api/tasks/${encodeURIComponent(String(task.id || ""))}/download" alt="${escapeHtml(scenePath.split(/[/\\]/).pop() || "图片结果")}" /></div></div>` : ""}
      <div class="task-chip-row">
        <span class="meta-chip">创建时间：${escapeHtml(formatTime(task.created_at))}</span>
        <span class="meta-chip">额度消耗：${escapeHtml(String(task.cost_cents || 0))} 分</span>
        <span class="meta-chip">结果文件：${escapeHtml(task.has_download ? "可下载" : isSuccess ? "结果待确认" : isFailed ? "未生成" : "生成中")}</span>
      </div>
      <div class="task-record-hero${heroTone}">
        <div class="task-record-hero-label">记录判断</div>
        <div class="task-record-hero-value">${escapeHtml(heroLabel)}</div>
        ${failureSummary ? `<div class="task-record-failure-brief">失败原因：${escapeHtml(failureSummary)}</div>` : ""}
      </div>
      <div class="task-card-grid">
        <div class="task-card-item task-card-item-wide">
          <div class="task-card-label">结果摘要</div>
          <div class="task-card-value">${escapeHtml(resultSummary)}</div>
        </div>
        <div class="task-card-item">
          <div class="task-card-label">状态更新时间</div>
          <div class="task-card-value">${escapeHtml(formatTime(task.updated_at || task.created_at))}</div>
        </div>
        <div class="task-card-item">
          <div class="task-card-label">优先动作</div>
          <div class="task-card-value">${escapeHtml(isSuccess ? (isImageTask ? "下载图片 / 继续生成视频" : "下载视频结果") : isFailed ? "重试或查看详情定位失败原因" : "等待生成完成后再处理")}</div>
        </div>
      </div>
      ${errorText ? `<div class="task-card-alert">生成失败：${escapeHtml(errorText)}</div>` : ""}
    </article>
  `;
}

function renderTasks() {
  const allRows = Array.isArray(userTaskState.rows) ? userTaskState.rows : [];
  const visibleRows = filterTasks(allRows);
  const list = el("taskList");
  const empty = el("taskEmpty");
  const meta = el("taskMetaLine");
  if (!list || !empty || !meta) return;
  renderTaskSummary(allRows, visibleRows);
  meta.textContent = visibleRows.length === allRows.length
    ? `共 ${allRows.length} 条生成记录，按创建时间倒序展示，可直接下载结果或继续生成。`
    : `当前筛选结果 ${visibleRows.length} / ${allRows.length} 条，可继续下载、重试或查看详情。`;
  empty.style.display = visibleRows.length ? "none" : "block";
  list.innerHTML = visibleRows.map((task) => renderTaskCard(task)).join("");
}

function buildTaskDetailText(detail) {
  const logs = Array.isArray(detail.logs) ? detail.logs : [];
  const lines = [
    `生成编号：${detail.id || "-"}`,
    `类型：${taskTypeLabel(detail.type)}`,
    `状态：${detail.status || "-"}`,
    `额度消耗(分)：${detail.cost_cents || 0}`,
    `创建时间：${formatTime(detail.created_at)}`,
    `更新时间：${formatTime(detail.updated_at)}`,
    `错误：${publicMessage(detail.error) || "-"}`,
    `最近分析：${publicMessage(detail.analysis_summary) || "-"}`,
    "",
    "处理记录：",
  ];
  logs.forEach((it) => {
    lines.push(`[${formatTime(it.created_at)}] [${it.kind}] ${publicMessage(it.message || "-")}`);
  });
  if (!logs.length) lines.push("暂无处理记录");
  return lines.join("\n");
}

function inspectItem(label, value) {
  return `
    <div class="inspect-item">
      <div class="inspect-label">${escapeHtml(label)}</div>
      <div class="inspect-value">${escapeHtml(value || "-")}</div>
    </div>
  `;
}

function inspectItemHtml(label, html) {
  return `
    <div class="inspect-item">
      <div class="inspect-label">${escapeHtml(label)}</div>
      <div class="inspect-value">${html || "-"}</div>
    </div>
  `;
}

function buildTaskDetailHtml(detail) {
  const batchText = Number(detail && detail.total_count) > 0
    ? `成功 ${detail.success_count || 0}/${detail.total_count || 0}，失败 ${detail.failed_count || 0}`
    : "单条生成";
  const firstError = publicMessage((detail && detail.first_error) || (detail && detail.error) || "");
  const canAnalyzeError = String((detail && detail.status) || "") === "failed" && Boolean(detail && detail.error_analysis_available);
  const logs = Array.isArray(detail && detail.logs) ? detail.logs : [];
  const logsHtml = logs.length
    ? logs.map((it) => {
      return `
        <article class="inspect-log-item">
          <div class="inspect-log-meta">
            <span>${escapeHtml(formatTime(it.created_at))}</span>
            <span>${escapeHtml(it.kind || "-")}</span>
          </div>
          <div class="inspect-log-text">${escapeHtml(publicMessage(it.message || "-"))}</div>
        </article>
      `;
    }).join("")
    : `<div class="task-empty task-empty-inline">暂无处理记录</div>`;
  return `
    <div class="inspect-stack">
      <div class="inspect-grid">
        ${inspectItem("生成编号", detail.id)}
        ${inspectItem("类型", taskTypeLabel(detail.type))}
        ${inspectItemHtml("状态", statusPill(detail.status))}
        ${inspectItem("批量结果", batchText)}
        ${inspectItem("额度消耗(分)", detail.cost_cents || 0)}
        ${inspectItem("创建时间", formatTime(detail.created_at))}
        ${inspectItem("更新时间", formatTime(detail.updated_at))}
        ${inspectItem("结果下载", detail.has_download ? "可下载" : "暂无结果文件")}
        ${inspectItem("错误", publicMessage(detail.error) || "-")}
      </div>
      ${firstError ? `<div class="inspect-note inspect-note-bad">错误：${escapeHtml(firstError)}</div>` : ""}
      ${detail.analysis_summary ? `<div class="inspect-note">最近分析：${escapeHtml(publicMessage(detail.analysis_summary))}</div>` : ""}
      ${canAnalyzeError ? `<div class="row" style="margin-top:4px"><button class="primary" type="button" data-act="analyze_error" data-id="${escapeHtml(detail.id)}">错误分析</button></div>` : ""}
      <div class="inspect-section">
        <div class="inspect-section-title">处理记录</div>
        <div class="inspect-log-list">${logsHtml}</div>
      </div>
    </div>
  `;
}

function openTaskInspectModal({ title, subtitle, html, rawText }) {
  const modal = el("taskInspectModal");
  if (!modal) return;
  el("taskInspectTitle").textContent = title || "生成详情";
  el("taskInspectSub").textContent = subtitle || "-";
  el("taskInspectBody").innerHTML = html || "";
  userTaskState.inspectText = rawText || "";
  modal.style.display = "grid";
  modal.setAttribute("aria-hidden", "false");
}

function closeTaskInspectModal() {
  const modal = el("taskInspectModal");
  if (!modal) return;
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
  userTaskState.inspectText = "";
}

async function copyTaskInspectText() {
  if (!userTaskState.inspectText) return;
  await navigator.clipboard.writeText(userTaskState.inspectText);
  setMsg("chatMsg", "已复制生成详情", true);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const TASK_LABELS = {
  commerce_video: "带货视频生成",
  image_generate: "图片生成",
  replace_model: "模特替换",
  replace_product: "商品替换",
  replace_productANDmodel: "模特+商品联合替换",
};

let paramStateByTaskType = {
  commerce_video: { batch: [], common: [], cycle_on_shortage: true },
  image_generate: { batch: [], common: [], cycle_on_shortage: true },
  replace_model: { batch: [], common: [], cycle_on_shortage: true },
  replace_product: { batch: [], common: [], cycle_on_shortage: true },
  replace_productANDmodel: { batch: [], common: [], cycle_on_shortage: true },
};

function getTaskType() {
  return String(el("chatTaskType").value || "commerce_video");
}

function buildParams(taskType, message) {
  const base = paramsByTaskType[taskType] ? JSON.parse(JSON.stringify(paramsByTaskType[taskType])) : {};
  const msg = String(message || "").trim();
  base.message = msg;
  return base;
}

function _guessKindByName(name) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".zip")) return "zip";
  if (/\.(png|jpg|jpeg|webp|bmp|gif)$/.test(n)) return "image";
  if (/\.(mp4|mov|avi|mkv|webm)$/.test(n)) return "video";
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/.test(n)) return "audio";
  return "file";
}

function estimateBatchGroups(taskType) {
  const items = selectedFiles || [];
  const counts = { image: 0, video: 0, zip: 0, audio: 0 };
  items.forEach((f) => {
    const kind = _guessKindByName(f && f.name);
    if (counts[kind] != null) counts[kind] += 1;
  });
  if (taskType === "commerce_video") {
    if (counts.zip >= 1) return 0;
    return Math.max(Math.floor(counts.image / 2), 0);
  }
  if (taskType === "replace_model") {
    return Math.max(Math.min(counts.video, counts.image), 0);
  }
  if (taskType === "replace_product") {
    return Math.max(Math.min(counts.video, counts.image), 0);
  }
  if (taskType === "replace_productANDmodel") {
    const mixedGroups = counts.video > 0 ? Math.min(counts.video, Math.floor(counts.image / 2)) : 0;
    const zipOnlyGroups = counts.zip >= 3 ? 1 : 0;
    const zipPlusVideoGroups = counts.zip >= 2 && counts.video >= 1 ? counts.video : 0;
    return Math.max(mixedGroups, zipOnlyGroups, zipPlusVideoGroups, 0);
  }
  return 0;
}

function formatBatchSummary(data) {
  const source = data && typeof data === "object" ? data : {};
  const success = Number(source.success_count || 0);
  const total = Number(source.total_count || 0);
  const failed = Number(source.failed_count || 0);
  const error = publicMessage(source.first_error || source.error || "");
  const parts = [];
  if (total > 0) parts.push(`成功 ${success}/${total}`);
  if (failed > 0) parts.push(`失败 ${failed}`);
  if (error) parts.push(error);
  return parts.join(" | ");
}

function formatProgressMeta(data) {
  const source = data && typeof data === "object" ? data : {};
  const parts = [];
  const jobIndex = Number(source.job_index || source.item_index || 0);
  const jobTotal = Number(source.job_total || source.total_count || 0);
  const jobProgress = source.job_progress != null ? Number(source.job_progress) : null;
  const overall = source.progress != null ? Number(source.progress) : null;
  const itemId = String(source.item_id || "").trim();
  const step = String(source.step || "").trim();
  if (jobIndex > 0 && jobTotal > 0) parts.push(`第 ${jobIndex}/${jobTotal} 条`);
  if (itemId) parts.push(`ID ${itemId}`);
  if (jobProgress != null && Number.isFinite(jobProgress)) parts.push(`当前 ${jobProgress.toFixed(1)}%`);
  if (overall != null && Number.isFinite(overall)) parts.push(`总进度 ${overall.toFixed(1)}%`);
  if (step) parts.push(`步骤 ${step}`);
  return parts.join(" | ");
}

function updateParamButtonLabel() {
  const btn = el("btnBatchParams");
  if (!btn) return;
  btn.textContent = "参数";
  updateUploadHint();
}

function openParamModal() {
  const modal = el("paramModal");
  if (!modal) return;
  updateParamButtonLabel();

  el("paramModalTitle").textContent = `参数设置：${TASK_LABELS[getTaskType()] || getTaskType()}`;
  el("paramModalSub").textContent = batchEnabled ? "批量参数 / 通用参数" : "通用参数";
  el("paramModalWarn").style.display = "none";
  el("paramModalHint").textContent = "";

  modal.style.display = "grid";
  modal.setAttribute("aria-hidden", "false");
  renderParamModal();
}

function closeParamModal() {
  const modal = el("paramModal");
  if (!modal) return;
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
  el("paramModalWarn").style.display = "none";
}

function defaultParam(taskType) {
  const base = paramsByTaskType[taskType] ? JSON.parse(JSON.stringify(paramsByTaskType[taskType])) : {};
  return base;
}

function normalizeReplaceModelParam(paramObj) {
  const obj = paramObj && typeof paramObj === "object" ? paramObj : {};
  const mode = String(obj.mode || "original");
  obj.mode = ["original", "primary", "slice", "motion_transfer"].includes(mode) ? mode : "original";
  if (!String(obj.prompt || "").trim()) obj.prompt = "";
  if (!(Number(obj.duration_seconds) > 0)) obj.duration_seconds = obj.mode === "slice" ? 5 : 10;
  if (!(Number(obj.width) > 0)) obj.width = obj.mode === "original" ? 576 : 1280;
  if (!(Number(obj.height) > 0)) obj.height = obj.mode === "original" ? 1024 : 720;
  if (!(Number(obj.frame) > 0)) obj.frame = 30;
  if (!(Number(obj.start_seconds) >= 0)) obj.start_seconds = 0;
  return obj;
}

function normalizeReplaceProductAndModelParam(paramObj) {
  const obj = paramObj && typeof paramObj === "object" ? paramObj : {};
  if (!obj.model_params || typeof obj.model_params !== "object") obj.model_params = {};
  if (!obj.product_params || typeof obj.product_params !== "object") obj.product_params = {};
  if (!String(obj.match_mode || "").trim()) obj.match_mode = "cycle";
  if (obj.fixed_index == null || Number(obj.fixed_index || 0) <= 0) obj.fixed_index = 1;
  if (obj.auto_rename == null) obj.auto_rename = true;
  if (!String(obj.model_params.prompt || "").trim()) obj.model_params.prompt = "";
  if (!String(obj.product_params.product_name || "").trim()) obj.product_params.product_name = "商品";
  if (!String(obj.product_params.prompt_text || "").trim()) obj.product_params.prompt_text = "";
  if (!(Number(obj.model_params.width) > 0)) obj.model_params.width = 576;
  if (!(Number(obj.model_params.height) > 0)) obj.model_params.height = 1024;
  if (!(Number(obj.model_params.frame) > 0)) obj.model_params.frame = 30;
  if (!(Number(obj.product_params.width) > 0)) obj.product_params.width = 576;
  if (!(Number(obj.product_params.height) > 0)) obj.product_params.height = 1024;
  if (!(Number(obj.product_params.frame_rate) > 0)) obj.product_params.frame_rate = 30;
  return obj;
}

function fieldBlock(labelText, inputEl) {
  const wrap = document.createElement("div");
  const lab = document.createElement("label");
  lab.textContent = labelText;
  wrap.appendChild(lab);
  wrap.appendChild(inputEl);
  return wrap;
}

function createTextInput(value, onChange) {
  const input = document.createElement("input");
  input.value = String(value == null ? "" : value);
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

function createNumberInput(value, onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value == null ? "" : value);
  input.addEventListener("input", () => onChange(Number(input.value || 0)));
  return input;
}

function createTextArea(value, onChange) {
  const input = document.createElement("textarea");
  input.value = String(value == null ? "" : value);
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

function createSelect(value, options, onChange) {
  const sel = document.createElement("select");
  (options || []).forEach((opt) => {
    const o = document.createElement("option");
    o.value = String(opt.value);
    o.textContent = String(opt.label);
    sel.appendChild(o);
  });
  sel.value = String(value == null ? "" : value);
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function createCheckbox(checked, onChange) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = Boolean(checked);
  input.addEventListener("change", () => onChange(Boolean(input.checked)));
  return input;
}

function renderParamItem(taskType, scope, idx, paramObj) {
  const box = document.createElement("div");
  box.className = "param-item";

  const state = paramStateByTaskType[taskType] || { batch: [], common: [], cycle_on_shortage: true };
  const arr = scope === "batch" ? state.batch : state.common;

  const head = document.createElement("div");
  head.className = "param-item-head";
  const title = document.createElement("div");
  title.className = "param-item-title";
  title.textContent = `${scope === "batch" ? "批量" : "通用"}参数 #${idx + 1}`;
  const rm = document.createElement("button");
  rm.type = "button";
  rm.className = "ghost param-remove";
  rm.textContent = "移除";
  const isLastCommon = scope === "common" && idx === 0 && (arr || []).length <= 1;
  if (isLastCommon) {
    rm.disabled = true;
    rm.style.display = "none";
  }
  rm.addEventListener("click", () => {
    if (scope === "common" && idx === 0 && (arr || []).length <= 1) {
      arr[0] = defaultParam(taskType);
      el("paramModalHint").textContent = "通用参数至少保留 1 条，已重置为默认值。";
      renderParamModal();
      return;
    }
    arr.splice(idx, 1);
    renderParamModal();
  });
  head.appendChild(title);
  head.appendChild(rm);
  box.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "param-row";

  if (taskType === "commerce_video") {
    grid.appendChild(fieldBlock("商品名称", createTextInput(paramObj.product_name || "", (v) => (paramObj.product_name = v))));
    grid.appendChild(fieldBlock("风格提示", createTextInput(paramObj.style_hint || "", (v) => (paramObj.style_hint = v))));
    grid.appendChild(fieldBlock("时长模式", createSelect(paramObj.duration_mode || "manual", [{ value: "manual", label: "手动" }, { value: "audio", label: "跟随音频" }], (v) => { paramObj.duration_mode = v; renderParamModal(); })));
    if (String(paramObj.duration_mode || "manual") === "manual") {
      grid.appendChild(fieldBlock("视频时长(秒)", createNumberInput(paramObj.duration_seconds || 15, (v) => (paramObj.duration_seconds = v))));
    } else {
      grid.appendChild(fieldBlock("视频时长(秒)", createTextInput("自动", () => {})));
    }
    grid.appendChild(fieldBlock("语言", createSelect(paramObj.language || "Chinese", [{ value: "Auto", label: "Auto" }, { value: "Chinese", label: "Chinese" }, { value: "English", label: "English" }, { value: "Japanese", label: "Japanese" }, { value: "Korean", label: "Korean" }, { value: "French", label: "French" }, { value: "German", label: "German" }, { value: "Spanish", label: "Spanish" }, { value: "Portuguese", label: "Portuguese" }, { value: "Russian", label: "Russian" }, { value: "Italian", label: "Italian" }], (v) => (paramObj.language = v))));
    grid.appendChild(fieldBlock("音色", createSelect(paramObj.speaker || "Ryan", [{ value: "Aiden", label: "Aiden" }, { value: "Dylan", label: "Dylan" }, { value: "Eric", label: "Eric" }, { value: "Ono_anna", label: "Ono_anna" }, { value: "Ryan", label: "Ryan" }, { value: "Serena", label: "Serena" }, { value: "Sohee", label: "Sohee" }, { value: "Uncle_fu", label: "Uncle_fu" }, { value: "Vivian", label: "Vivian" }, { value: "zhenzhen", label: "zhenzhen" }], (v) => (paramObj.speaker = v))));
    grid.appendChild(fieldBlock("情绪", createTextInput(paramObj.emotion || "happy", (v) => (paramObj.emotion = v))));
    grid.appendChild(fieldBlock("TTS模型", createSelect(paramObj.model_choice || "1.7B", [{ value: "0.6B", label: "0.6B" }, { value: "1.7B", label: "1.7B" }], (v) => (paramObj.model_choice = v))));
    grid.appendChild(fieldBlock("队列类型", createTextInput(paramObj.instance_type || "default", (v) => (paramObj.instance_type = v))));
    const q = document.createElement("label");
    q.className = "switch";
    const qcb = createCheckbox(Boolean(paramObj.use_personal_queue), (v) => (paramObj.use_personal_queue = v));
    q.appendChild(qcb);
    q.appendChild(document.createTextNode("使用个人队列"));
    grid.appendChild(fieldBlock("队列", q));
    const useAi = document.createElement("label");
    useAi.className = "switch";
    const cb = createCheckbox(Boolean(paramObj.use_ai_copy), (v) => (paramObj.use_ai_copy = v));
    useAi.appendChild(cb);
    useAi.appendChild(document.createTextNode("使用AI生成口播/提示词"));
    grid.appendChild(fieldBlock("AI 文案", useAi));
    const speech = createTextArea(paramObj.speech_text || "", (v) => (paramObj.speech_text = v));
    speech.style.height = "74px";
    const prompt = createTextArea(paramObj.prompt_text || "", (v) => (paramObj.prompt_text = v));
    prompt.style.height = "74px";
    const nano = createTextArea(paramObj.nano_prompt || "", (v) => (paramObj.nano_prompt = v));
    nano.style.height = "74px";
    const row = document.createElement("div");
    row.className = "param-row one";
    row.appendChild(fieldBlock("口播文案（可空，上传音频可不填）", speech));
    row.appendChild(fieldBlock("视频提示词（可空）", prompt));
    row.appendChild(fieldBlock("场景图提示词（可选）", nano));
    box.appendChild(grid);
    box.appendChild(row);
    return box;
  }

  if (taskType === "replace_model") {
    normalizeReplaceModelParam(paramObj);
    const mode = String(paramObj.mode || "original");
    const modeDesc = document.createElement("div");
    modeDesc.className = "small";
    const modeTips = {
      original: "基础模式：支持提示词、时长、宽高和帧率。",
      primary: "快速模式：只填写输出宽高。",
      slice: "片段替换：填写动作描述、生成时长和起始秒数。",
      motion_transfer: "动作迁移：用于保留动作并迁移画面主体。",
    };
    modeDesc.textContent = modeTips[mode] || modeTips.original;
    box.appendChild(modeDesc);
    grid.appendChild(
      fieldBlock(
        "模式",
        createSelect(
          mode,
          [
            { value: "original", label: "基础模式" },
            { value: "primary", label: "快速模式" },
            { value: "slice", label: "片段替换" },
            { value: "motion_transfer", label: "动作迁移" },
          ],
          (v) => {
            paramObj.mode = v;
            normalizeReplaceModelParam(paramObj);
            renderParamModal();
          }
        )
      )
    );
    if (mode === "original") {
      grid.appendChild(fieldBlock("提示词", createTextInput(paramObj.prompt || "", (v) => (paramObj.prompt = v))));
      grid.appendChild(fieldBlock("时长(秒)", createNumberInput(paramObj.duration_seconds || 10, (v) => (paramObj.duration_seconds = v))));
      grid.appendChild(fieldBlock("宽度", createNumberInput(paramObj.width || 576, (v) => (paramObj.width = v))));
      grid.appendChild(fieldBlock("高度", createNumberInput(paramObj.height || 1024, (v) => (paramObj.height = v))));
      grid.appendChild(fieldBlock("帧率", createNumberInput(paramObj.frame || 30, (v) => (paramObj.frame = v))));
    } else if (mode === "slice") {
      grid.appendChild(fieldBlock("动作描述", createTextInput(paramObj.prompt || "", (v) => (paramObj.prompt = v))));
      grid.appendChild(fieldBlock("生成时长(秒)", createNumberInput(paramObj.duration_seconds || 5, (v) => (paramObj.duration_seconds = v))));
      grid.appendChild(fieldBlock("起始秒数", createNumberInput(paramObj.start_seconds || 0, (v) => (paramObj.start_seconds = v))));
    } else {
      grid.appendChild(fieldBlock("宽度", createNumberInput(paramObj.width || 1280, (v) => (paramObj.width = v))));
      grid.appendChild(fieldBlock("高度", createNumberInput(paramObj.height || 720, (v) => (paramObj.height = v))));
    }
    box.appendChild(grid);
    return box;
  }

  if (taskType === "replace_product") {
    grid.appendChild(fieldBlock("商品名称", createTextInput(paramObj.product_name || "", (v) => (paramObj.product_name = v))));
    grid.appendChild(fieldBlock("提示词", createTextInput(paramObj.prompt_text || "", (v) => (paramObj.prompt_text = v))));
    grid.appendChild(fieldBlock("时长(秒)", createNumberInput(paramObj.duration_seconds || 15, (v) => (paramObj.duration_seconds = v))));
    grid.appendChild(fieldBlock("宽度", createNumberInput(paramObj.width || 576, (v) => (paramObj.width = v))));
    grid.appendChild(fieldBlock("高度", createNumberInput(paramObj.height || 1024, (v) => (paramObj.height = v))));
    grid.appendChild(fieldBlock("帧率", createNumberInput(paramObj.frame_rate || 30, (v) => (paramObj.frame_rate = v))));
    box.appendChild(grid);
    return box;
  }

  if (taskType === "replace_productANDmodel") {
    normalizeReplaceProductAndModelParam(paramObj);

    const matchMode = String(paramObj.match_mode || "cycle");
    grid.appendChild(
      fieldBlock(
        "配对模式",
        createSelect(
          matchMode,
          [
            { value: "cycle", label: "循环配对" },
            { value: "repeat_last", label: "不足用最后一张" },
            { value: "repeat_first", label: "不足用第一张" },
            { value: "fixed_index", label: "固定索引" },
          ],
          (v) => {
            paramObj.match_mode = v;
            renderParamModal();
          }
        )
      )
    );
    if (matchMode === "fixed_index") {
      grid.appendChild(fieldBlock("固定索引（从1开始）", createNumberInput(paramObj.fixed_index || 1, (v) => (paramObj.fixed_index = v))));
    } else {
      grid.appendChild(fieldBlock("固定索引（从1开始）", createTextInput("（仅“固定索引”模式生效）", () => {})));
    }
    const autoWrap = document.createElement("label");
    autoWrap.className = "switch";
    const cb = createCheckbox(Boolean(paramObj.auto_rename), (v) => (paramObj.auto_rename = v));
    autoWrap.appendChild(cb);
    autoWrap.appendChild(document.createTextNode("自动重命名"));
    grid.appendChild(fieldBlock("文件名处理", autoWrap));

    const durWrap = document.createElement("label");
    durWrap.className = "switch";
    const durCb = createCheckbox(
      Boolean(paramObj.model_params.use_custom_duration || paramObj.product_params.use_custom_duration),
      (v) => {
        paramObj.model_params.use_custom_duration = v;
        paramObj.product_params.use_custom_duration = v;
        renderParamModal();
      }
    );
    durWrap.appendChild(durCb);
    durWrap.appendChild(document.createTextNode("启用自定义时长（用于分段/截断）"));
    grid.appendChild(fieldBlock("时长控制", durWrap));
    if (Boolean(paramObj.model_params.use_custom_duration || paramObj.product_params.use_custom_duration)) {
      grid.appendChild(
        fieldBlock("目标时长（秒）", createNumberInput(paramObj.model_params.duration_seconds || paramObj.product_params.duration_seconds || 10, (v) => {
          paramObj.model_params.duration_seconds = v;
          paramObj.product_params.duration_seconds = v;
        }))
      );
    } else {
      grid.appendChild(fieldBlock("目标时长（秒）", createTextInput("自动（使用原视频时长）", () => {})));
    }

    grid.appendChild(fieldBlock("模特替换提示词", createTextInput(paramObj.model_params.prompt || "", (v) => (paramObj.model_params.prompt = v))));
    grid.appendChild(fieldBlock("输出宽度", createNumberInput(paramObj.model_params.width || 576, (v) => (paramObj.model_params.width = v))));
    grid.appendChild(fieldBlock("输出高度", createNumberInput(paramObj.model_params.height || 1024, (v) => (paramObj.model_params.height = v))));
    grid.appendChild(fieldBlock("帧率", createNumberInput(paramObj.model_params.frame || 30, (v) => (paramObj.model_params.frame = v))));

    grid.appendChild(fieldBlock("商品名称", createTextInput(paramObj.product_params.product_name || "", (v) => (paramObj.product_params.product_name = v))));
    grid.appendChild(fieldBlock("商品替换提示词", createTextInput(paramObj.product_params.prompt_text || "", (v) => (paramObj.product_params.prompt_text = v))));
    grid.appendChild(fieldBlock("输出宽度", createNumberInput(paramObj.product_params.width || 576, (v) => (paramObj.product_params.width = v))));
    grid.appendChild(fieldBlock("输出高度", createNumberInput(paramObj.product_params.height || 1024, (v) => (paramObj.product_params.height = v))));
    grid.appendChild(fieldBlock("帧率", createNumberInput(paramObj.product_params.frame_rate || 30, (v) => (paramObj.product_params.frame_rate = v))));

    box.appendChild(grid);
    return box;
  }

  box.appendChild(grid);
  return box;
}

function renderParamModal() {
  const taskType = getTaskType();
  const state = paramStateByTaskType[taskType] || { batch: [], common: [], cycle_on_shortage: true };
  paramStateByTaskType[taskType] = state;

  if (!(state.common || []).length) {
    state.common = [defaultParam(taskType)];
  }
  if (taskType === "replace_productANDmodel") {
    state.common = (state.common || []).map((it) => normalizeReplaceProductAndModelParam(it));
    state.batch = (state.batch || []).map((it) => normalizeReplaceProductAndModelParam(it));
  }

  const batchCol = el("batchParamCol");
  const btnAddBatch = el("btnAddBatchParam");
  if (!batchEnabled) {
    if (batchCol) batchCol.style.display = "none";
    if (btnAddBatch) btnAddBatch.style.display = "none";
    el("paramModalSub").textContent = "通用参数";
  } else {
    if (batchCol) batchCol.style.display = "";
    if (btnAddBatch) btnAddBatch.style.display = "";
    el("paramModalSub").textContent = "批量参数 / 通用参数";
  }

  const batchList = el("batchParamList");
  const commonList = el("commonParamList");
  batchList.innerHTML = "";
  commonList.innerHTML = "";

  if (batchEnabled) {
    (state.batch || []).forEach((p, idx) => batchList.appendChild(renderParamItem(taskType, "batch", idx, p)));
  }
  (state.common || []).forEach((p, idx) => commonList.appendChild(renderParamItem(taskType, "common", idx, p)));

  const groups = estimateBatchGroups(taskType);
  const hint = batchEnabled
    ? (groups > 0 ? `检测到约 ${groups} 组素材；批量参数不足时可循环使用。` : "未检测到足够批量素材，仍可先填写参数。")
    : "未开启批量：本次提交将使用“通用参数 #1”。";
  el("paramModalHint").textContent = hint;
}

function _firstCommonParam(taskType) {
  const state = paramStateByTaskType[taskType] || { batch: [], common: [], cycle_on_shortage: true };
  const item = (state.common || [])[0];
  if (item && typeof item === "object") return item;
  return defaultParam(taskType);
}

function applyCommerceQuickSettings() {
  const state = paramStateByTaskType.commerce_video || { batch: [], common: [], cycle_on_shortage: true };
  if (!Array.isArray(state.common) || !state.common.length) state.common = [defaultParam("commerce_video")];
  const params = state.common[0];
  const productName = el("commerceProductName");
  const styleHint = el("commerceStyleHint");
  if (productName && String(productName.value || "").trim()) params.product_name = String(productName.value || "").trim();
  if (styleHint && String(styleHint.value || "").trim()) params.style_hint = String(styleHint.value || "").trim();
  paramStateByTaskType.commerce_video = state;
}

function exportParamsForSubmit(taskType, msgText) {
  const base = defaultParam(taskType);
  const params = Object.assign(base, _firstCommonParam(taskType));
  params.message = String(msgText || "").trim();
  if (taskType === "replace_model") {
    normalizeReplaceModelParam(params);
    if ((params.mode === "original" || params.mode === "slice") && !String(params.prompt || "").trim()) params.prompt = params.message;
  }
  if (taskType === "replace_product") {
    if (!String(params.prompt_text || "").trim()) params.prompt_text = params.message;
  }
  if (taskType === "commerce_video") {
    if (!String(params.prompt_text || "").trim()) params.prompt_text = params.message;
    if (!String(params.speech_text || "").trim()) params.speech_text = params.message;
    if (appState.generatedSceneImagePath) {
      params.scene_image_local_path = appState.generatedSceneImagePath;
      params.resume_from_image_task_id = appState.generatedSceneTaskId || "";
    }
  }
  if (taskType === "image_generate") {
    const modeNode = el("imageGenerateMode");
    params.mode = String((modeNode && modeNode.value) || params.mode || "product_only").trim() || "product_only";
    params.image_generate_provider = "remote_comfy";
    if (!String(params.prompt || "").trim()) params.prompt = params.message;
  }
  if (taskType === "replace_productANDmodel") {
    normalizeReplaceProductAndModelParam(params);
    const mp = params.model_params && typeof params.model_params === "object" ? params.model_params : {};
    const pp = params.product_params && typeof params.product_params === "object" ? params.product_params : {};
    params.model_params = mp;
    params.product_params = pp;
    if (!String(mp.prompt || "").trim()) mp.prompt = params.message;
    if (!String(pp.prompt_text || "").trim()) pp.prompt_text = params.message;
  }

  const state = paramStateByTaskType[taskType] || { batch: [], common: [], cycle_on_shortage: true };
  const groups = estimateBatchGroups(taskType);
  if (batchEnabled) {
    params.batch_mode = true;
    params.batch_groups_estimated = groups;
    params.batch_params = state.batch || [];
    params.common_params = state.common || [];
    params.cycle_params_on_shortage = Boolean(state.cycle_on_shortage);
    params.use_common_params_on_shortage = true;
  }
  return params;
}

function validateBeforeSubmit(taskType, msgText, params) {
  const items = selectedFiles || [];
  const counts = { image: 0, video: 0, zip: 0, audio: 0 };
  items.forEach((f) => {
    const kind = _guessKindByName(f && f.name);
    if (counts[kind] != null) counts[kind] += 1;
  });
  if (taskType === "replace_model") {
    normalizeReplaceModelParam(params);
    if (batchEnabled && counts.zip >= 1) {
      if (counts.image > 0 || counts.video > 0 || counts.audio > 0) return "批量模式请只上传 zip（不要混传图片/视频/音频）";
      return "";
    }
    if (counts.video < 1 || counts.image < 1) return "模特替换需要上传 1 个视频和 1 张图片";
    if (params.mode === "original" || params.mode === "slice") {
      const prompt = String(params.prompt || msgText || "").trim();
      if (!prompt) return params.mode === "slice" ? "片段替换需要填写动作描述" : "模特替换需要提示词（可在输入框描述动作/场景）";
    }
  }
  if (taskType === "replace_product") {
    if (batchEnabled && counts.zip >= 1) {
      if (counts.image > 0 || counts.video > 0 || counts.audio > 0) return "批量模式请只上传 zip（不要混传图片/视频/音频）";
      return "";
    }
    if (counts.video < 1 || counts.image < 1) return "商品替换需要上传 1 个视频和 1 张图片";
    if (!String(params.product_name || "").trim()) return "商品替换需要填写商品名称";
  }
  if (taskType === "replace_productANDmodel") {
    const okLegacyZip = counts.zip >= 3;
    const okZipModelProductPlusVideos = counts.zip >= 2 && counts.video >= 1;
    const okAutoLabelImages = counts.image >= 2 && (counts.video >= 1 || counts.zip >= 1);
    if (!okLegacyZip && !okZipModelProductPlusVideos && !okAutoLabelImages) {
      return "联合替换需：3 个 zip（model/product/video），或 2 个 zip（model+product）+ 1 个视频，或 2+ 张图片（模特+商品可混传）+ 原视频（zip 或视频文件）";
    }
    const pp = params.product_params && typeof params.product_params === "object" ? params.product_params : {};
    if (!String(pp.product_name || "").trim()) return "请填写 product_name（商品名称）";
  }
  if (taskType === "commerce_video") {
    if (batchEnabled && counts.zip >= 1) {
      if (counts.image > 0 || counts.video > 0 || counts.audio > 0) return "zip 批量带货请只上传 zip（不要混传图片/视频/音频）";
      return "";
    }
    if (appState.generatedSceneImagePath) {
      if (counts.image < 1) return "已选择场景图后，带货视频生成仍需要上传 1 张模特图";
    } else if (counts.image < 2) {
      return "带货视频生成需要上传 2 张图片（先模特后商品）";
    }
    if (!Boolean(params.use_ai_copy) && counts.audio < 1) {
      if (!String(params.speech_text || msgText || "").trim()) return "请填写口播文案，或上传音频文件";
    }
  }
  if (taskType === "image_generate") {
    const mode = String(params.mode || "product_only").trim() || "product_only";
    if (mode === "model_product") {
      if (counts.image < 2) return "图片生成（模特+商品）需要上传 2 张图片（先模特后商品）";
    } else if (counts.image < 1) {
      return "图片生成需要上传至少 1 张商品图";
    }
    if (!String(params.prompt || msgText || "").trim()) return "请填写图片生成提示词";
  }
  return "";
}

function renderStageEvent(payload) {
  const raw = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
  const body = raw.data && typeof raw.data === "object" ? raw.data : raw;
  const stage = String(raw.stage || body.stage || "").trim();
  const status = String(raw.state || body.status || "").trim().toLowerCase();
  if (!stage) return false;
  if (stage === "start") {
    setProgressStage("queued", "生成开始", "任务已进入执行流程");
    addEventPill("running", "生成开始");
    return true;
  }
  if (stage === "running") {
    setProgressStage("processing", "开始生成", "系统正在处理素材");
    addEventPill("running", "生成中");
    return true;
  }
  if (stage === "parsing") {
    setProgressStage("uploading", "解析文件中", "正在识别并整理上传素材");
    addEventPill("progress", "解析文件中");
    return true;
  }
  if (stage === "parse_result") {
    setProgressStage("uploading", "解析完成", formatProgressStatusMeta(JSON.stringify(body || {})) || "素材解析完成");
    addEventPill("progress", "解析结果", JSON.stringify(body || {}));
    return true;
  }
  if (stage === "uploading") {
    const meta = formatProgressMeta(body);
    setProgressStage("uploading", payload.message || "上传文件中", formatProgressStatusMeta(meta));
    addEventPill("progress", payload.message || "上传文件中", meta);
    return true;
  }
  if (stage === "upload_result") {
    const urls = Array.isArray(body.urls) ? body.urls.filter((x) => String(x || "").trim()) : [];
    if (status === "failed") {
      setProgressStage("failed", "上传失败", publicMessage(String(body.error || payload.message || "")));
      addEventPill("failed", "上传失败", String(body.error || payload.message || ""));
      return true;
    }
    setProgressStage("processing", "上传成功", urls.length ? `已上传 ${urls.length} 个文件` : "文件已上传，开始生成");
    addEventPill("success", "上传成功", urls.length ? urls.join(" | ") : "");
    return true;
  }
  if (stage === "processing") {
    const detail = [formatProgressMeta(body), formatBatchSummary(body)].filter(Boolean).join(" | ");
    setProgressStage(status === "failed" ? "failed" : "processing", payload.message || "生成处理中", formatProgressStatusMeta(detail));
    addEventPill(status === "failed" ? "failed" : "progress", payload.message || "生成处理中", detail);
    return true;
  }
  if (stage === "finished") {
    const detail = [formatProgressMeta(body), formatBatchSummary(body)].filter(Boolean).join(" | ");
    setProgressStage(status === "success" ? "finished" : "failed", payload.message || (status === "success" ? "生成成功" : "生成失败"), formatProgressStatusMeta(detail));
    addEventPill(
      status === "success" ? "success" : "failed",
      payload.message || (status === "success" ? "生成成功" : "生成失败"),
      detail
    );
    return true;
  }
  return false;
}

function subscribeTaskEvents(taskId) {
  setProgressStage("queued", "已提交任务", `生成编号：${taskId}`);
  const source = new EventSource(`/api/tasks/${taskId}/events`, { withCredentials: true });
  source.addEventListener("queued", (e) => {
    const payload = safeJsonParse(e.data);
    if (!payload) return;
    addEventPill("queued", payload.message || "排队中");
  });
  source.addEventListener("running", (e) => {
    const payload = safeJsonParse(e.data);
    if (!payload) return;
    addEventPill("running", payload.message || "生成中");
  });
  source.addEventListener("log", (e) => {
    const payload = safeJsonParse(e.data);
    if (!payload) return;
    addEventPill("log", payload.message || "");
  });
  source.addEventListener("progress", (e) => {
    const payload = safeJsonParse(e.data);
    if (!payload) return;
    if (renderStageEvent(payload)) return;
    const detail = formatProgressMeta(payload.data || {});
    addEventPill("progress", payload.message || "生成处理中", detail);
  });
  source.addEventListener("done", async (e) => {
    const payload = safeJsonParse(e.data);
    const isSuccess = Boolean(payload && payload.data && payload.data.status === "success");
    if (payload) {
      addEventPill(
        isSuccess ? "success" : "failed",
        payload.message || "生成完成",
        formatBatchSummary(payload.data)
      );
    }
    source.close();
    await loadTasks();
    await loadMe();
    if (isSuccess && getTaskType() === "image_generate") {
      const recentSection = el("recentImageSection");
      if (recentSection) {
        setRecentRailOpen(true);
        recentSection.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  });
  source.onerror = () => {
    source.close();
  };
}

async function submitTask() {
  const taskType = getTaskType();
  const message = el("chatInput").value;
  const files = selectedFiles.slice();
  const msgText = String(message || "").trim();
  if (!msgText && !files.length) throw new Error("请输入需求或上传文件");

  if (taskType === "commerce_video") applyCommerceQuickSettings();
  addChatBubble("user", files.length ? `${msgText || (taskType === "image_generate" ? "生成图片" : "生成带货视频")}
（素材 ${files.length} 个）` : msgText);

  const params = exportParamsForSubmit(taskType, msgText);
  const err = validateBeforeSubmit(taskType, msgText, params);
  if (err) throw new Error(err);
  const fd = new FormData();
  fd.append("task_type", taskType);
  fd.append("params_json", JSON.stringify(params));
  files.forEach((f) => fd.append("files", f));

  const resp = await api("/api/tasks/submit", { method: "POST", body: fd });
  addChatBubble("assistant", `已提交生成\n类型：${taskTypeLabel(resp.task_type)}\n生成编号：${resp.id}`);
  subscribeTaskEvents(resp.id);

  el("chatInput").value = "";
  clearFiles();
  return resp.id;
}

function bindActions() {
  document.addEventListener(
    "dragover",
    (e) => {
      if (!isProbablyFileDrop(e.dataTransfer)) return;
      e.preventDefault();
    },
    { passive: false }
  );
  document.addEventListener(
    "drop",
    (e) => {
      if (!isProbablyFileDrop(e.dataTransfer)) return;
      e.preventDefault();
    },
    { passive: false }
  );

  el("chatBatchToggle").addEventListener("change", (e) => {
    batchEnabled = Boolean(e.target.checked);
    updateParamButtonLabel();
    if (el("paramModal") && el("paramModal").style.display !== "none") renderParamModal();
  });

  el("chatTaskType").addEventListener("change", () => {
    if (getTaskType() !== "commerce_video") {
      appState.generatedSceneTaskId = "";
      appState.generatedSceneImagePath = "";
    }
    updateParamButtonLabel();
    syncTaskTypeTabs();
    updateGeneratePageCopy();
    renderSelectedFiles();
  });
  const videoTab = el("taskTypeModeVideo");
  const imageTab = el("taskTypeModeImage");
  if (videoTab) {
    videoTab.addEventListener("click", () => {
      const select = el("chatTaskType");
      if (!select) return;
      select.value = "commerce_video";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  if (imageTab) {
    imageTab.addEventListener("click", () => {
      const select = el("chatTaskType");
      if (!select) return;
      select.value = "image_generate";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  const imageGenerateMode = el("imageGenerateMode");
  if (imageGenerateMode) {
    imageGenerateMode.addEventListener("change", () => {
      updateImageModeUI();
      updateGenerateSteps();
      updateUploadHint();
    });
  }
  const settingsDisclosure = el("settingsDisclosure");
  const settingsDisclosureSummary = el("settingsDisclosureSummary");
  const recentSideToggle = el("recentSideToggle");
  if (recentSideToggle) {
    recentSideToggle.addEventListener("click", () => {
      const nextOpen = !appState.recentRailOpen;
      setRecentRailOpen(nextOpen);
    });
  }
  if (settingsDisclosure && settingsDisclosureSummary) {
    settingsDisclosure.addEventListener("toggle", () => {
      settingsDisclosureSummary.textContent = settingsDisclosure.open ? "收起设置" : "展开设置";
    });
  }

  el("btnBatchParams").addEventListener("click", () => openParamModal());
  el("btnParamClose").addEventListener("click", () => closeParamModal());
  el("btnParamCancel").addEventListener("click", () => closeParamModal());
  el("paramModal").addEventListener("click", () => {});

  el("btnAddBatchParam").addEventListener("click", () => {
    const taskType = getTaskType();
    const state = paramStateByTaskType[taskType];
    state.batch.push(defaultParam(taskType));
    renderParamModal();
  });
  el("btnAddCommonParam").addEventListener("click", () => {
    const taskType = getTaskType();
    const state = paramStateByTaskType[taskType];
    state.common.push(defaultParam(taskType));
    renderParamModal();
  });

  el("btnWarnCancel").addEventListener("click", () => {
    el("paramModalWarn").style.display = "none";
  });
  el("btnWarnOk").addEventListener("click", () => {
    el("paramModalWarn").style.display = "none";
    closeParamModal();
  });

  el("btnParamSave").addEventListener("click", () => {
    const taskType = getTaskType();
    const state = paramStateByTaskType[taskType];
    if (taskType === "replace_productANDmodel") {
      const common0 = (state.common || [])[0] || {};
      const commonPP = common0.product_params && typeof common0.product_params === "object" ? common0.product_params : {};
      if (!String(commonPP.product_name || "").trim()) {
        el("paramModalHint").textContent = "通用参数 #1 需要填写 product_name（商品名称）";
        return;
      }
      const batchItems = state.batch || [];
      for (let i = 0; i < batchItems.length; i++) {
        const it = batchItems[i] || {};
        const pp = it.product_params && typeof it.product_params === "object" ? it.product_params : {};
        if (!String(pp.product_name || "").trim()) {
          el("paramModalHint").textContent = `批量参数 #${i + 1} 需要填写 product_name（商品名称）`;
          return;
        }
      }
    }
    const groups = estimateBatchGroups(taskType);
    const batchCount = (state.batch || []).length;
    if (batchEnabled && groups > 0 && batchCount > 0 && batchCount < groups) {
      el("paramModalWarnText").textContent = `检测到约 ${groups} 组素材，但仅填写了 ${batchCount} 组批量参数。确认后将使用批量参数覆盖前 ${batchCount} 组，其余将使用“通用参数 #1”补齐。`;
      el("paramModalWarn").style.display = "block";
      return;
    }
    if (batchEnabled && groups > 0 && batchCount === 0) {
      el("paramModalWarnText").textContent = `检测到约 ${groups} 组素材，但未填写批量参数。确认后将对所有组使用“通用参数 #1”。`;
      el("paramModalWarn").style.display = "block";
      return;
    }
    closeParamModal();
  });

  el("chatFiles").addEventListener("change", (e) => {
    const input = e.target;
    mergeFiles(Array.from(input.files || []));
    input.value = "";
    updateUploadHint();
  });

  const slotInputs = [
    ["modelImageInput", "model"],
    ["productImageInput", "product"],
    ["cameraVideoInput", "camera"],
    ["audioInput", "audio"],
  ];
  slotInputs.forEach(([id, slot]) => {
    const node = el(id);
    if (!node) return;
    node.addEventListener("change", (e) => {
      const input = e.target;
      const file = input && input.files && input.files[0];
      if (file) setSlotFile(slot, file);
      input.value = "";
    });
  });
  const batchZipInput = el("batchZipInput");
  if (batchZipInput) {
    batchZipInput.addEventListener("change", (e) => {
      const input = e.target;
      if (input && input.files && input.files.length) {
        batchEnabled = true;
        if (el("chatBatchToggle")) el("chatBatchToggle").checked = true;
        addZipFiles(Array.from(input.files || []));
        updateParamButtonLabel();
      }
      input.value = "";
    });
  }

  const dropzone = el("chatDropzone");
  const chatInput = el("chatInput");

  const onDragEnter = (e) => {
    dragDebugLog("enter", e);
    if (!isProbablyFileDrop(e.dataTransfer)) return;
    e.preventDefault();
    dropzone.classList.add("dragging");
  };
  const onDragOver = (e) => {
    dragDebugLog("over", e);
    if (!isProbablyFileDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.dataTransfer.dropEffect = "copy";
    } catch {
      // ignore
    }
    dropzone.classList.add("dragging");
  };
  const onDragLeave = (e) => {
    dragDebugLog("leave", e);
    const next = e.relatedTarget;
    if (next && dropzone.contains(next)) return;
    dropzone.classList.remove("dragging");
  };
  const onDrop = (e) => {
    dragDebugLog("drop", e);
    if (!isProbablyFileDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove("dragging");
    const dropped = extractDroppedFiles(e.dataTransfer);
    dragDebugLog("drop-files", e, { droppedLen: (dropped || []).length });
    if (dropped && dropped.length) mergeFiles(dropped);
    if (DRAG_DEBUG && (!dropped || !dropped.length)) {
      setMsg("chatMsg", "未识别到可添加的文件（请尝试拖拽后松手，或用“上传”按钮）", false);
    }
  };

  dropzone.addEventListener("dragenter", onDragEnter, true);
  dropzone.addEventListener("dragover", onDragOver, true);
  dropzone.addEventListener("dragleave", onDragLeave, true);
  dropzone.addEventListener("drop", onDrop, true);

  if (chatInput) {
    chatInput.addEventListener("dragenter", onDragEnter, true);
    chatInput.addEventListener("dragover", onDragOver, true);
    chatInput.addEventListener("dragleave", onDragLeave, true);
    chatInput.addEventListener("drop", onDrop, true);
  }

  el("btnClearFiles").addEventListener("click", () => {
    clearFiles();
  });

  el("btnSendChat").addEventListener("click", async () => {
    setMsg("chatMsg", "", true);
    try {
      await submitTask();
      await loadTasks();
      await loadMe();
    } catch (err) {
      const msg = publicMessage(err.detail || err.message || String(err));
      addChatBubble("assistant", `提交失败：${msg}`);
      setMsg("chatMsg", msg, false);
    }
  });

  el("chatInput").addEventListener("keydown", async (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      el("btnSendChat").click();
    }
  });

  if (el("btnTaskRefresh")) {
    el("btnTaskRefresh").addEventListener("click", async () => {
      await loadTasks();
    });
  }
  ["taskSearch", "taskStatusFilter"].forEach((id) => {
    const node = el(id);
    if (!node) return;
    node.addEventListener(id === "taskSearch" ? "input" : "change", () => renderTasks());
  });
  if (el("btnTaskFilterReset")) {
    el("btnTaskFilterReset").addEventListener("click", () => {
      if (el("taskSearch")) el("taskSearch").value = "";
      if (el("taskStatusFilter")) el("taskStatusFilter").value = "";
      renderTasks();
    });
  }
  if (el("btnTaskInspectClose")) {
    el("btnTaskInspectClose").addEventListener("click", () => closeTaskInspectModal());
  }
  if (el("btnTaskInspectDone")) {
    el("btnTaskInspectDone").addEventListener("click", () => closeTaskInspectModal());
  }
  if (el("btnTaskInspectCopy")) {
    el("btnTaskInspectCopy").addEventListener("click", async () => {
      try {
        await copyTaskInspectText();
      } catch (err) {
        setMsg("chatMsg", publicMessage(err.message || String(err)), false);
      }
    });
  }

  if (el("btnLedgerRefresh")) {
    el("btnLedgerRefresh").addEventListener("click", () => loadLedger());
  }
  if (el("btnPersonaDashboardRefresh")) {
    el("btnPersonaDashboardRefresh").addEventListener("click", () => loadPersonaDashboard());
  }
  if (el("btnPersonaDashboardRefreshAll")) {
    el("btnPersonaDashboardRefreshAll").addEventListener("click", () => startPersonaDashboardRefresh(""));
  }
  ["personaDashboardSearch", "personaDashboardPlatform", "personaDashboardPad", "personaDashboardRange"].forEach((id) => {
    const node = el(id);
    if (!node) return;
    node.addEventListener(id === "personaDashboardSearch" ? "input" : "change", () => {
      appState.personaDashboardPostPage = 1;
      appState.personaDashboardTabPage = 1;
      renderPersonaDashboard();
    });
  });
  if (el("btnChangePassword")) {
    el("btnChangePassword").addEventListener("click", async () => {
      setMsg("accountPasswordMsg", "");
      const oldPwd = el("accOldPassword").value || "";
      const newPwd = el("accNewPassword").value || "";
      const newPwd2 = el("accNewPassword2").value || "";
      if (!oldPwd) return setMsg("accountPasswordMsg", "请填写原密码", false);
      if (!newPwd || newPwd.length < 6) return setMsg("accountPasswordMsg", "新密码至少 6 位", false);
      if (newPwd !== newPwd2) return setMsg("accountPasswordMsg", "两次输入的新密码不一致", false);
      try {
        await api("/api/auth/change_password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
        });
        el("accOldPassword").value = "";
        el("accNewPassword").value = "";
        el("accNewPassword2").value = "";
        setMsg("accountPasswordMsg", "密码已修改", true);
      } catch (err) {
        setMsg("accountPasswordMsg", publicMessage(err.detail || String(err)), false);
      }
    });
  }
  if (el("btnChangeUsername")) {
    el("btnChangeUsername").addEventListener("click", async () => {
      setMsg("accountUsernameMsg", "");
      const newUsername = String(el("accNewUsername").value || "").trim();
      const pwd = el("accUsernamePassword").value || "";
      if (!newUsername) return setMsg("accountUsernameMsg", "请填写新用户名", false);
      if (!pwd) return setMsg("accountUsernameMsg", "请填写当前密码用于确认", false);
      try {
        await api("/api/auth/change_username", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd, new_username: newUsername }),
        });
        el("accUsernamePassword").value = "";
        el("accNewUsername").value = "";
        await loadMe();
        setMsg("accountUsernameMsg", "用户名已修改", true);
      } catch (err) {
        setMsg("accountUsernameMsg", publicMessage(err.detail || String(err)), false);
      }
    });
  }
  if (el("taskInspectModal")) {
    el("taskInspectModal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeTaskInspectModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTaskInspectModal();
  });

  document.addEventListener("click", async (e) => {
    const btn = e.target;
    if (!btn || !btn.dataset) return;
    if (btn.dataset.fileKey) {
      removeFile(String(btn.dataset.fileKey || ""));
      return;
    }
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if (!act || !id) return;
    if (act === "continue_video") {
      appState.generatedSceneTaskId = String(id || "");
      appState.generatedSceneImagePath = String(btn.dataset.scene || "").trim();
      if (el("chatTaskType")) el("chatTaskType").value = "commerce_video";
      setActiveAppPage("generate");
      updateParamButtonLabel();
      updateGeneratePageCopy();
      renderSelectedFiles();
      setMsg("chatMsg", "已切换到视频生成，并复用该场景图。请上传 1 张模特图后继续。", true);
      addChatBubble("assistant", `已复用图片结果 ${id}，请上传 1 张模特图后继续生成视频。`);
      const recentSection = el("recentImageSection");
      if (recentSection) {
        setRecentRailOpen(true);
        recentSection.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }
    if (act === "retry") {
      setMsg("chatMsg", "", true);
      try {
        const resp = await api(`/api/tasks/${id}/retry`, { method: "POST" });
        addChatBubble("assistant", `已创建重新生成\n来源生成编号：${id}\n新生成编号：${resp.id}`);
        subscribeTaskEvents(String(resp.id));
        await loadTasks();
        await loadMe();
      } catch (err) {
        const msg = publicMessage(err.detail || err.message || String(err));
        setMsg("chatMsg", msg, false);
      }
      return;
    }
    if (act === "retry_resume") {
      setMsg("chatMsg", "", true);
      try {
        const resp = await api(`/api/tasks/${id}/retry_resume`, { method: "POST" });
        addChatBubble("assistant", `已创建断点重新生成\n来源生成编号：${id}\n新生成编号：${resp.id}`);
        subscribeTaskEvents(String(resp.id));
        await loadTasks();
        await loadMe();
      } catch (err) {
        const msg = publicMessage(err.detail || err.message || String(err));
        setMsg("chatMsg", msg, false);
      }
      return;
    }
    if (act === "detail") {
      const detail = await api(`/api/tasks/${id}`);
      openTaskInspectModal({
        title: "生成详情",
        subtitle: `${taskTypeLabel(detail.type)} · ${detail.id || id}`,
        html: buildTaskDetailHtml(detail),
        rawText: buildTaskDetailText(detail),
      });
      return;
    }
    if (act === "analyze_error") {
      setMsg("chatMsg", "", true);
      try {
        await api(`/api/tasks/${id}/analyze_error`, { method: "POST" });
        const detail = await api(`/api/tasks/${id}`);
        openTaskInspectModal({
          title: "生成详情",
          subtitle: `${taskTypeLabel(detail.type)} · ${detail.id || id}`,
          html: buildTaskDetailHtml(detail),
          rawText: buildTaskDetailText(detail),
        });
        setMsg("chatMsg", "错误分析已生成", true);
        await loadTasks();
      } catch (err) {
        const msg = publicMessage(err.detail || err.message || String(err));
        setMsg("chatMsg", msg, false);
      }
      return;
    }
    if (act === "delete_task") {
      if (!confirm(`确认删除生成记录 ${id} 吗？`)) return;
      await api(`/api/tasks/${id}`, { method: "DELETE" });
      await loadTasks();
    }
  });

  document.querySelectorAll("[data-page]").forEach((node) => {
    node.addEventListener("click", () => {
      setActiveAppPage(node.dataset.page || "generate");
    });
  });

  el("btnLogout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.href = "/login.html";
  });

  el("btnGoAdmin").addEventListener("click", () => {
    location.href = "/admin.html#admin-overview";
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
  setActiveAppPage(readAppPageFromHash(), false);
  renderSelectedFiles();
  updateParamButtonLabel();
  setRecentRailOpen(false);
  updateGeneratePageCopy();
  updateUploadHint();
  await loadTasks();
  await loadLedger();
  addChatBubble("assistant", "准备好后，选择模式、上传素材，再开始生成。");

  setInterval(async () => {
    try {
      await loadTasks();
      await loadMe();
      await loadLedger();
      if (appState.activePage === "persona-dashboard") await loadPersonaDashboard();
    } catch {
      // ignore polling failures
    }
  }, 8000);
});

window.addEventListener("hashchange", () => {
  setActiveAppPage(readAppPageFromHash(), false);
});
