function el(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const node = el(id);
  if (!node) return;
  node.textContent = String(value == null ? "" : value);
}

const ADMIN_PAGE_LABELS = {
  overview: "运营概览",
  users: "客户账号",
  tasks: "生成记录",
  pricing: "额度与计费",
  runtime: "系统配置",
  sentimentCookies: "舆情 Cookie",
  account: "账号设置",
};

const SENSITIVE_RUNTIME_INPUT_IDS = [
  "rtTelegramBotToken",
  "rtLlmApiKeyGpt",
  "rtImageGeminiApiKey",
  "rtNewPersonaRunningHubApiKey",
  "rtMuleRouterApiKey",
];

function normalizeAdminPage(value) {
  const raw = String(value || "").replace(/^#/, "").trim();
  const mapped = ADMIN_PAGE_ALIASES[raw] || raw.replace(/^admin-/, "");
  return ADMIN_PAGES.has(mapped) ? mapped : "overview";
}

function readAdminPageFromHash() {
  return normalizeAdminPage(location.hash || "");
}

function setActiveAdminPage(page, updateHash = true) {
  const nextPage = normalizeAdminPage(page);
  adminState.activePage = nextPage;
  const pageLabel = ADMIN_PAGE_LABELS[nextPage] || "运营概览";
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
  setText("adminCurrentPageLabel", pageLabel);
  document.title = `${pageLabel} - 运营后台 - Web 素材生成平台`;
  const targetHash = `admin-${nextPage}`;
  if (updateHash && String(location.hash || "").replace(/^#/, "") !== targetHash) {
    location.hash = targetHash;
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "include", cache: "no-store", ...opts });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { detail: text || `HTTP ${res.status}` };
  }
  if (res.status === 401) {
    window.location.replace("/admin");
    throw data || { detail: "管理员登录已过期" };
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

function clearAccountMsgs() {
  setMsg("accountUsernameMsg", "");
  setMsg("accountPasswordMsg", "");
}

function getErrorMessage(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  if (typeof err.detail === "string" && err.detail.trim()) return err.detail.trim();
  if (typeof err.message === "string" && err.message.trim()) return err.message.trim();
  return String(err);
}

function formatRuntimeConfigError(action, err) {
  const detail = getErrorMessage(err);
  if (detail.includes("运行配置文件")) return `${action}失败：${detail}`;
  return `${action}运行配置失败：${detail}`;
}

function runtimeConfigResponseToConfig(resp) {
  if (resp && typeof resp.runtime_config === "object" && resp.runtime_config) {
    return resp.runtime_config;
  }
  if (resp && typeof resp === "object") return resp;
  return null;
}

function parseModelList(value) {
  return String(value || "")
    .split(/\s*[,，\n]+\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringifyModelList(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(", ");
}

const RUNTIME_MODEL_DRAFT_KEY = "runtime_model_candidates_draft_v1";
const NEW_PERSONA_RUNNINGHUB_API_PRESETS = {
  "2046514150500524033": {
    kind: "text-to-image",
    endpoint: "/rhart-image-g-2/text-to-image",
    label: "全能图片G-2.0-文生图-低价渠道版",
    detailUrl: "https://www.runninghub.cn/call-api/api-detail/2046514150500524033",
  },
  "2027192837726294017": {
    kind: "text-to-image",
    endpoint: "/rhart-image-n-g31-flash/text-to-image",
    label: "全能图片V2-文生图-低价渠道版",
    detailUrl: "https://www.runninghub.cn/call-api/api-detail/2027192837726294017",
  },
  "2046503667076751361": {
    kind: "image-to-image",
    endpoint: "/rhart-image-g-2/image-to-image",
    label: "全能图片G-2.0-图生图-低价渠道版",
    detailUrl: "https://www.runninghub.cn/call-api/api-detail/2046503667076751361",
  },
  "2027196343409463297": {
    kind: "image-to-image",
    endpoint: "/rhart-image-n-g31-flash/image-to-image",
    label: "全能图片V2-图生图-低价渠道版",
    detailUrl: "https://www.runninghub.cn/call-api/api-detail/2027196343409463297",
  },
};

const RUNNINGHUB_SLOT_FIELDS = {
  persona: {
    kind: "text-to-image",
    selectId: "rtNewPersonaPersonaT2iPreset",
    detailInputId: "rtNewPersonaPersonaT2iDetailUrl",
    endpointInputId: "rtNewPersonaPersonaT2iEndpoint",
    statusId: "rtNewPersonaPersonaT2iStatus",
    successText: "人设图文生图链路已切换并保存。",
  },
  tweet: {
    kind: "image-to-image",
    selectId: "rtNewPersonaTweetI2iPreset",
    detailInputId: "rtNewPersonaTweetI2iDetailUrl",
    endpointInputId: "rtNewPersonaTweetI2iEndpoint",
    statusId: "rtNewPersonaTweetI2iStatus",
    successText: "推文配图图生图链路已切换并保存。",
  },
};

function runningHubPresetOptions(kind) {
  return Object.entries(NEW_PERSONA_RUNNINGHUB_API_PRESETS)
    .filter(([, preset]) => preset.kind === kind);
}

function runningHubPresetIdFromValues(kind, detailUrl, endpoint) {
  const normalizedEndpoint = String(endpoint || "").trim();
  const match = runningHubPresetOptions(kind).find(([, preset]) => preset.endpoint && preset.endpoint === normalizedEndpoint);
  if (match) return match[0];
  const detailId = runningHubDetailId(detailUrl);
  if (detailId && NEW_PERSONA_RUNNINGHUB_API_PRESETS[detailId]?.kind === kind) return detailId;
  return "";
}

function renderRunningHubPresetSelect(slotName) {
  const slot = RUNNINGHUB_SLOT_FIELDS[slotName];
  if (!slot) return;
  const select = el(slot.selectId);
  if (!select) return;
  const detailInput = el(slot.detailInputId);
  const endpointInput = el(slot.endpointInputId);
  const currentId = runningHubPresetIdFromValues(slot.kind, detailInput?.value, endpointInput?.value);
  const options = runningHubPresetOptions(slot.kind);
  const savedDetail = String(detailInput?.value || "").trim();
  const savedEndpoint = String(endpointInput?.value || "").trim();
  const savedCustomOption = !currentId && (savedDetail || savedEndpoint)
    ? `<option value="__custom_saved" selected>当前已保存 API（自定义/未收录）</option>`
    : "";
  select.innerHTML = savedCustomOption + options.map(([id, preset]) => {
    const selected = id === currentId ? " selected" : "";
    return `<option value="${escapeHtml(id)}"${selected}>${escapeHtml(preset.label)}</option>`;
  }).join("");
  if (!currentId && !savedCustomOption && options[0]) {
    select.value = options[0][0];
    applyRunningHubPresetToHidden(slotName, false);
  }
  select.dataset.appliedValue = select.value || "";
  updateRunningHubPresetStatus(slotName);
}

function applyRunningHubPresetToHidden(slotName, updateStatus = true) {
  const slot = RUNNINGHUB_SLOT_FIELDS[slotName];
  if (!slot) return false;
  const select = el(slot.selectId);
  const preset = select ? NEW_PERSONA_RUNNINGHUB_API_PRESETS[select.value] : null;
  if (!preset || preset.kind !== slot.kind || !preset.endpoint) {
    updateRunningHubPresetStatus(slotName, "该 API 暂不可用，未应用。");
    return false;
  }
  const detailInput = el(slot.detailInputId);
  const endpointInput = el(slot.endpointInputId);
  if (detailInput) detailInput.value = preset.detailUrl;
  if (endpointInput) endpointInput.value = preset.endpoint;
  if (updateStatus) updateRunningHubPresetStatus(slotName);
  return true;
}

function updateRunningHubPresetStatus(slotName, overrideText = "") {
  const slot = RUNNINGHUB_SLOT_FIELDS[slotName];
  if (!slot) return;
  const status = el(slot.statusId);
  const select = el(slot.selectId);
  const preset = select ? NEW_PERSONA_RUNNINGHUB_API_PRESETS[select.value] : null;
  if (!status) return;
  if (overrideText) {
    status.textContent = overrideText;
    return;
  }
  if (select?.value === "__custom_saved") {
    const endpoint = String(el(slot.endpointInputId)?.value || "").trim();
    status.textContent = endpoint ? `当前使用：已保存自定义 API（${endpoint}）` : "当前使用：已保存自定义 API";
    return;
  }
  if (!preset) {
    status.textContent = "尚未选择 RunningHub API。";
    return;
  }
  status.textContent = preset.endpoint
    ? `当前使用：${preset.label}`
    : `${preset.label} 缺少 Endpoint，无法调用。`;
}

async function switchRunningHubPreset(slotName) {
  const slot = RUNNINGHUB_SLOT_FIELDS[slotName];
  if (!slot || !applyRunningHubPresetToHidden(slotName)) return;
  const select = el(slot.selectId);
  if (select) select.dataset.appliedValue = select.value || "";
  try {
    await saveRuntime();
    setMsg("runtimeMsg", slot.successText, true);
  } catch (err) {
    setMsg("runtimeMsg", getErrorMessage(err), false);
  }
}

function bindRunningHubPresetSelect(slotName) {
  const slot = RUNNINGHUB_SLOT_FIELDS[slotName];
  const select = slot ? el(slot.selectId) : null;
  if (!select) return;
  const handle = () => switchRunningHubPreset(slotName);
  select.addEventListener("change", handle);
  select.addEventListener("input", handle);
  select.addEventListener("click", () => {
    setTimeout(() => {
      if ((select.value || "") !== (select.dataset.appliedValue || "")) handle();
    }, 0);
  });
}

function runningHubDetailId(value) {
  const text = String(value || "").trim();
  const match = text.match(/api-detail\/(\d{10,})/) || text.match(/\b(\d{10,})\b/);
  return match ? match[1] : "";
}

function uniqueItems(items) {
  return Array.from(new Set((Array.isArray(items) ? items : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)));
}

function isGrokModel(model) {
  return /grok/i.test(String(model || "").trim());
}

function isGeminiImageModel(model) {
  return /(?:gemini|imagen|image)/i.test(String(model || "").trim());
}

function grokModelItems(items) {
  return uniqueItems(items);
}

function imageModelItems(items) {
  return uniqueItems(items).filter(Boolean);
}

function readModelDraft() {
  try {
    const raw = localStorage.getItem(RUNTIME_MODEL_DRAFT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeModelDraft() {
  try {
    localStorage.setItem(RUNTIME_MODEL_DRAFT_KEY, JSON.stringify({
      llmGeminiModels: [],
      llmGptModels: grokModelItems(adminState.llmGptModels),
      imageGeminiModels: imageModelItems(adminState.imageGeminiModels),
    }));
  } catch {
    // localStorage can be unavailable in private browsing; config save still works.
  }
}

function clearModelDraft() {
  try {
    localStorage.removeItem(RUNTIME_MODEL_DRAFT_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function mergeModelDraft() {
  const draft = readModelDraft();
  if (!draft) return false;
  let changed = false;
  ["llmGptModels", "imageGeminiModels"].forEach((key) => {
    const before = uniqueItems(adminState[key]);
    const after = key.startsWith("llm")
      ? grokModelItems([...before, ...(Array.isArray(draft[key]) ? draft[key] : [])])
      : imageModelItems([...before, ...(Array.isArray(draft[key]) ? draft[key] : [])]);
    adminState[key] = after;
    if (after.length !== before.length) changed = true;
  });
  return changed;
}

function normalizeWorkflowChain(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : String(value || "")
      .replace(/->/g, ",")
      .replace(/>/g, ",")
      .split(",");
  const items = source
    .map((item) => {
      if (item && typeof item === "object") {
        const stage = parseWorkflowStage(item);
        return buildWorkflowStageValue(stage.type, stage.value);
      }
      return String(item || "").trim();
    })
    .filter(Boolean);
  if (items.length) return items;
  return (Array.isArray(fallback) ? fallback : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

const CLOSED_LLM_STAGE_PREFIX = "closed_llm_model:";

function parseWorkflowStage(item) {
  if (item && typeof item === "object") {
    const type = String(item.type || item.provider || "").trim();
    const value = String(item.value || item.model || item.workflow_id || item.id || "").trim();
    if (["closed_llm_model", "closed_text_model", "llm_model", "text_model"].includes(type)) {
      return { type: "closed_llm_model", value };
    }
    return { type: "runninghub_workflow", value };
  }
  const text = String(item || "").trim();
  if (text.startsWith(CLOSED_LLM_STAGE_PREFIX)) {
    return { type: "closed_llm_model", value: text.slice(CLOSED_LLM_STAGE_PREFIX.length).trim() };
  }
  return { type: "runninghub_workflow", value: text };
}

function buildWorkflowStageValue(type, value) {
  const stageValue = String(value || "").trim();
  if (!stageValue) return "";
  if (type === "closed_llm_model") return `${CLOSED_LLM_STAGE_PREFIX}${stageValue}`;
  return stageValue;
}

function looksLikeLegacyWorkflowId(value) {
  return /^\d{10,}$/.test(String(value || "").trim());
}

function llmModelOptions() {
  return grokModelItems(adminState.llmGptModels);
}

function imageModelOptions() {
  return imageModelItems(adminState.imageGeminiModels);
}

function modelCatalogForPriority(type) {
  if (type === "image") return imageModelOptions();
  return llmModelOptions();
}

function normalizePriorityList(priorityItems, catalogItems, fallbackItems) {
  const normalized = [];
  const seen = new Set();
  const addItem = (value) => {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    normalized.push(text);
  };
  (Array.isArray(priorityItems) ? priorityItems : []).forEach(addItem);
  (Array.isArray(catalogItems) ? catalogItems : []).forEach(addItem);
  if (normalized.length === 0) {
    (Array.isArray(fallbackItems) ? fallbackItems : []).forEach(addItem);
  }
  return normalized;
}

function syncPriorityModelsFromCatalog(type) {
  if (type === "image") {
    const explicitPriority = imageModelItems(adminState.imagePriorityModels);
    adminState.imagePriorityModels = normalizePriorityList(
      explicitPriority.length ? explicitPriority : imageModelOptions(),
      [],
      ["gemini-3-pro-image-preview"],
    );
    return;
  }
  const normalizeLlmPriorityKey = (key) => {
    const explicitPriority = grokModelItems(adminState[key]);
    adminState[key] = normalizePriorityList(
      explicitPriority,
      [],
      [],
    );
  };
  normalizeLlmPriorityKey("llmPriorityModels");
}

function defaultClosedLlmModel(priorityKey = "llmPriorityModels") {
  const priority = grokModelItems(adminState[priorityKey]);
  return priority[0] || llmModelOptions()[0] || "";
}

function normalizeWorkflowStageForType(type, value) {
  const stageType = String(type || "runninghub_workflow").trim();
  const text = String(value || "").trim();
  if (stageType === "closed_llm_model") {
    return looksLikeLegacyWorkflowId(text) || !text ? defaultClosedLlmModel() : text;
  }
  return (
    text.startsWith(CLOSED_LLM_STAGE_PREFIX)
  ) ? "" : text;
}

function lastWorkflowStep(items) {
  const normalized = normalizeWorkflowChain(items);
  return normalized.length ? normalized[normalized.length - 1] : "";
}

function renderModelList(listKey, wrapId) {
  const wrap = el(wrapId);
  if (!wrap) return;
  wrap.innerHTML = "";
  (Array.isArray(adminState[listKey]) ? adminState[listKey] : []).forEach((model, index) => {
    const chip = document.createElement("div");
    chip.className = "admin-model-chip";
    chip.innerHTML = `<span>${escapeHtml(model)}</span><button type="button" class="ghost admin-model-chip-remove" data-list="${escapeHtml(listKey)}" data-idx="${index}" aria-label="删除模型">×</button>`;
    wrap.appendChild(chip);
  });
}

function renderPriorityModelList(listKey, wrapId) {
  const wrap = el(wrapId);
  if (!wrap) return;
  wrap.innerHTML = "";
  (Array.isArray(adminState[listKey]) ? adminState[listKey] : []).forEach((model, index) => {
    const chip = document.createElement("div");
    chip.className = "admin-model-chip";
    chip.innerHTML = `
      <span>${escapeHtml(model)}</span>
      <div class="admin-model-chip-actions">
        <button type="button" class="ghost admin-model-chip-order" data-priority-list="${escapeHtml(listKey)}" data-priority-idx="${index}" data-priority-action="up" aria-label="上移">↑</button>
        <button type="button" class="ghost admin-model-chip-order" data-priority-list="${escapeHtml(listKey)}" data-priority-idx="${index}" data-priority-action="down" aria-label="下移">↓</button>
        <button type="button" class="ghost admin-model-chip-remove" data-list="${escapeHtml(listKey)}" data-idx="${index}" aria-label="删除模型">×</button>
      </div>`;
    wrap.appendChild(chip);
  });
}

function renderPriorityModelListSafe(listKey, wrapId) {
  const wrap = el(wrapId);
  if (!wrap) return;
  wrap.innerHTML = "";
  (Array.isArray(adminState[listKey]) ? adminState[listKey] : []).forEach((model, index) => {
    const chip = document.createElement("div");
    chip.className = "admin-model-chip";
    const escapedListKey = escapeHtml(listKey);
    chip.innerHTML = `
      <span>${escapeHtml(model)}</span>
      <div class="admin-model-chip-actions">
        <button type="button" class="ghost admin-model-chip-order" data-priority-list="${escapedListKey}" data-priority-idx="${index}" data-priority-action="up" aria-label="上移">↑</button>
        <button type="button" class="ghost admin-model-chip-order" data-priority-list="${escapedListKey}" data-priority-idx="${index}" data-priority-action="down" aria-label="下移">↓</button>
        <button type="button" class="ghost admin-model-chip-remove" data-list="${escapedListKey}" data-idx="${index}" aria-label="删除模型">×</button>
      </div>`;
    wrap.appendChild(chip);
  });
}

function renderAllModelLists() {
  syncPriorityModelsFromCatalog("llm");
  syncPriorityModelsFromCatalog("image");
  renderModelList("llmGptModels", "rtLlmGptModelList");
  renderPriorityModelListSafe("llmPriorityModels", "rtLlmPriorityModelList");
  renderModelList("imageGeminiModels", "rtImageGeminiModelList");
  renderPriorityModelListSafe("imagePriorityModels", "rtImagePriorityModelList");
  renderModelSummaries();
}

function firstModel(listKey) {
  const items = Array.isArray(adminState[listKey]) ? adminState[listKey] : [];
  const first = String(items[0] || "").trim();
  return first;
}

function buildModelSummary(geminiListKey, gptListKey, label) {
  const priorityKey = "llmPriorityModels";
  const priority = Array.isArray(adminState[priorityKey]) ? adminState[priorityKey] : [];
  if (priority.length > 0) return `当前默认执行：按优先级顺序依次尝试，当前首选 ${priority[0]}`;
  const geminiModel = firstModel(geminiListKey);
  const gptModel = firstModel(gptListKey);
  if (geminiModel) return `当前默认执行：${label}优先使用 ${geminiModel}`;
  if (gptModel) return `当前默认执行：${label}回退使用 ${gptModel}`;
  return `当前默认执行：未配置 ${label}候选模型`;
}





function addModelFromInput(listKey, inputId) {
  const input = el(inputId);
  if (!input) return;
  const value = String(input.value || "").trim();
  if (!value) return;
  if (!Array.isArray(adminState[listKey])) {
    adminState[listKey] = [];
  }
  if (!adminState[listKey].includes(value)) {
    adminState[listKey].push(value);
    if (listKey === "llmGptModels") {
      syncPriorityModelsFromCatalog("llm");
    } else if (listKey === "imageGeminiModels") {
      syncPriorityModelsFromCatalog("image");
    }
    writeModelDraft();
    renderAllModelLists();
  }
  input.value = "";
}

function setLlmModelPickerStatus(message, isError = false) {
  const picker = el("rtLlmGrokModelPicker");
  if (!picker) return;
  picker.hidden = false;
  picker.innerHTML = `<div class="admin-model-picker-status${isError ? " error" : ""}">${escapeHtml(message)}</div>`;
}

function hideLlmModelPicker() {
  const picker = el("rtLlmGrokModelPicker");
  if (picker) picker.hidden = true;
  adminState.llmModelPickerTargetListKey = "";
}

function placeLlmModelPickerNear(triggerId) {
  const picker = el("rtLlmGrokModelPicker");
  const trigger = el(triggerId);
  const editor = trigger?.closest(".admin-model-list-editor");
  if (picker && editor && picker.parentElement !== editor) {
    editor.appendChild(picker);
  }
}

function placeImageModelPickerNear(triggerId) {
  const picker = el("rtImageGeminiModelPicker");
  const trigger = el(triggerId);
  const editor = trigger?.closest(".admin-model-list-editor");
  if (picker && editor && picker.parentElement !== editor) {
    editor.appendChild(picker);
  }
}

function modelVendor(model) {
  const text = String(model || "").trim();
  const lower = text.toLowerCase();
  if (!text) return "其他";
  if (lower.includes("openai") || lower.startsWith("gpt") || /^o[1345](?:[-_.]|$)/i.test(text)) return "OpenAI";
  if (lower.includes("anthropic") || lower.includes("claude")) return "Anthropic";
  if (lower.includes("google") || lower.includes("gemini") || lower.includes("imagen")) return "Google";
  if (lower.includes("xai") || lower.includes("grok")) return "xAI";
  if (lower.includes("qwen")) return "Qwen";
  if (lower.includes("deepseek")) return "DeepSeek";
  if (lower.includes("doubao") || lower.includes("bytedance") || lower.includes("seedream") || lower.includes("seedance")) return "ByteDance";
  if (lower.includes("glm")) return "GLM";
  if (lower.includes("minimax")) return "MiniMax";
  if (lower.includes("mistral")) return "Mistral";
  if (lower.includes("flux")) return "Flux";
  if (lower.includes("dall-e")) return "DALL-E";
  if (lower.includes("wan")) return "Wan";
  if (lower.includes("kling")) return "Kling";
  if (lower.includes("hailuo")) return "Hailuo";
  if (lower.includes("veo")) return "Veo";
  const first = text.split(/[/:_.-]/).find(Boolean) || text;
  return first.slice(0, 24);
}

function renderSearchableModelPicker(picker, items, dataAttrName, emptyMessage, placeholder = "搜尋模型") {
  if (!picker) return;
  const options = uniqueItems(items).sort((a, b) => a.localeCompare(b));
  picker.hidden = false;
  if (!options.length) {
    picker.innerHTML = `<div class="admin-model-picker-status">${escapeHtml(emptyMessage)}</div>`;
    return;
  }
  const vendors = uniqueItems(options.map((model) => modelVendor(model))).sort((a, b) => a.localeCompare(b));
  picker.innerHTML = `
    <div class="admin-model-picker-toolbar">
      <div class="admin-model-picker-count" data-model-picker-count>共 ${options.length} 个可用模型</div>
      <select class="admin-model-picker-vendor" data-model-picker-vendor>
        <option value="">全部厂商</option>
        ${vendors.map((vendor) => `<option value="${escapeHtml(vendor)}">${escapeHtml(vendor)}</option>`).join("")}
      </select>
    </div>
    <input class="admin-model-picker-search" type="search" placeholder="${escapeHtml(placeholder)}" data-model-picker-search>
    <div class="admin-model-picker-options">
      ${options
        .map((model) => `<button type="button" class="ghost admin-model-picker-option" data-vendor="${escapeHtml(modelVendor(model))}" data-${dataAttrName}="${escapeHtml(model)}">${escapeHtml(model)}</button>`)
        .join("")}
    </div>
  `;
  filterModelPickerOptions(picker, "");
}

function filterModelPickerOptions(picker, query) {
  if (!picker) return;
  const normalized = String(query || "").trim().toLowerCase();
  const selectedVendor = String(picker.querySelector("[data-model-picker-vendor]")?.value || "");
  let visibleCount = 0;
  picker.querySelectorAll(".admin-model-picker-option").forEach((button) => {
    const text = String(button.textContent || "").toLowerCase();
    const vendor = String(button.dataset.vendor || "");
    const visible = !(normalized && !text.includes(normalized)) && !(selectedVendor && vendor !== selectedVendor);
    button.hidden = !visible;
    if (visible) visibleCount += 1;
  });
  const countNode = picker.querySelector("[data-model-picker-count]");
  if (countNode) countNode.textContent = `显示 ${visibleCount} / ${picker.querySelectorAll(".admin-model-picker-option").length} 个可用模型`;
}

function bindModelPickerFilters(pickerId) {
  const picker = el(pickerId);
  if (!picker) return;
  picker.addEventListener("input", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.dataset.modelPickerSearch !== undefined) {
      filterModelPickerOptions(picker, target.value);
    }
  });
  picker.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.dataset.modelPickerVendor !== undefined) {
      const query = picker.querySelector("[data-model-picker-search]")?.value || "";
      filterModelPickerOptions(picker, query);
    }
  });
}

function activeTextModelPriorityListKey() {
  return "llmPriorityModels";
}

function addModelToFront(listKey, model) {
  const value = String(model || "").trim();
  if (!value) return;
  if (!Array.isArray(adminState[listKey])) adminState[listKey] = [];
  adminState[listKey] = [value, ...adminState[listKey].filter((item) => item !== value)];
}

function addLlmModelFromPicker(model) {
  const value = String(model || "").trim();
  if (!value) return;
  if (adminState.llmModelPickerTargetListKey) {
    addLlmPriorityModelFromPicker(adminState.llmModelPickerTargetListKey, value);
    return;
  }
  if (!Array.isArray(adminState.llmGptModels)) adminState.llmGptModels = [];
  if (!adminState.llmGptModels.includes(value)) adminState.llmGptModels.push(value);
  addModelToFront("llmPriorityModels", value);
  syncPriorityModelsFromCatalog("llm");
  writeModelDraft();
  renderAllModelLists();
  hideLlmModelPicker();
  setMsg("runtimeMsg", `已加入文字模型：${value}`, true);
}

function addLlmPriorityModelFromPicker(listKey, model) {
  const value = String(model || "").trim();
  if (!value) return;
  if (listKey !== "llmPriorityModels") return;
  addModelToFront(listKey, value);
  if (!Array.isArray(adminState.llmGptModels)) adminState.llmGptModels = [];
  if (!adminState.llmGptModels.includes(value)) adminState.llmGptModels.push(value);
  addModelToFront("llmPriorityModels", value);
  adminState.llmModelPickerTargetListKey = "";
  syncPriorityModelsFromCatalog("llm");
  writeModelDraft();
  renderAllModelLists();
  hideLlmModelPicker();
  setMsg("runtimeMsg", `已加入调用顺序：${value}`, true);
}

function openLlmPriorityModelPicker(listKey) {
  const picker = el("rtLlmGrokModelPicker");
  if (!picker) return;
  const triggerId = "btnAddLlmPriorityModel";
  placeLlmModelPickerNear(triggerId);
  const candidates = uniqueItems(adminState.llmGptModels);
  if (!candidates.length) {
    adminState.llmModelPickerTargetListKey = "";
    setLlmModelPickerStatus("请先点击「识别模型」取得候选模型，或先在候选模型中添加一个模型。", true);
    return;
  }
  adminState.llmModelPickerTargetListKey = listKey;
  renderSearchableModelPicker(picker, candidates, "llm-model", "暂无候选文字模型", "搜索候选模型");
}

function renderAvailableLlmModels(models) {
  const picker = el("rtLlmGrokModelPicker");
  if (!picker) return;
  adminState.llmModelPickerTargetListKey = "";
  renderSearchableModelPicker(picker, uniqueItems(Array.isArray(models) ? models : []), "llm-model", "没有查询到可用文字模型", "搜索文字模型");
}

async function toggleAvailableLlmModels() {
  const picker = el("rtLlmGrokModelPicker");
  if (!picker) return;
  placeLlmModelPickerNear("btnBrowseLlmGrokModels");
  if (!picker.hidden && picker.children.length > 0) {
    hideLlmModelPicker();
    return;
  }
  const baseUrl = el("rtLlmBaseUrl").value.trim();
  const apiKey = el("rtLlmApiKeyGpt").value.trim() || el("rtLlmApiKeyGemini").value.trim();
  if (!baseUrl || !apiKey) {
    setLlmModelPickerStatus("请先填写 API Base URL 和 API Key", true);
    return;
  }
  setLlmModelPickerStatus("正在识别当前 API 支持的文字模型...");
  try {
    const resp = await api("/api/admin/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "text", provider: "openai-compatible", base_url: baseUrl, api_key: apiKey }),
    });
    renderAvailableLlmModels(resp.models || []);
  } catch (err) {
    setLlmModelPickerStatus(err.detail || err.message || String(err), true);
  }
}

function addPriorityModelFromInput(listKey, inputId, type) {
  const input = el(inputId);
  if (!input) return;
  const value = String(input.value || "").trim();
  if (!value) return;
  if (!Array.isArray(adminState[listKey])) {
    adminState[listKey] = [];
  }
  if (!adminState[listKey].includes(value)) {
    adminState[listKey].push(value);
  }
  syncPriorityModelsFromCatalog(type);
  writeModelDraft();
  renderAllModelLists();
  input.value = "";
}

function setImageModelPickerStatus(message, isError = false) {
  const picker = el("rtImageGeminiModelPicker");
  if (!picker) return;
  picker.hidden = false;
  picker.innerHTML = `<div class="admin-model-picker-status${isError ? " error" : ""}">${escapeHtml(message)}</div>`;
}

function hideImageModelPicker() {
  const picker = el("rtImageGeminiModelPicker");
  if (picker) picker.hidden = true;
  adminState.imageModelPickerTargetListKey = "";
}

function addImageModelFromPicker(model) {
  const value = String(model || "").trim();
  if (!value) return;
  if (!Array.isArray(adminState.imageGeminiModels)) adminState.imageGeminiModels = [];
  if (!adminState.imageGeminiModels.includes(value)) adminState.imageGeminiModels.push(value);
  addModelToFront("imagePriorityModels", value);
  adminState.imageModelPickerTargetListKey = "";
  syncPriorityModelsFromCatalog("image");
  writeModelDraft();
  renderAllModelLists();
  hideImageModelPicker();
  setMsg("runtimeMsg", `已加入图片模型：${value}`, true);
}

function openImagePriorityModelPicker() {
  const picker = el("rtImageGeminiModelPicker");
  if (!picker) return;
  placeImageModelPickerNear("btnAddImagePriorityModel");
  const candidates = uniqueItems(adminState.imageGeminiModels);
  if (!candidates.length) {
    adminState.imageModelPickerTargetListKey = "";
    setImageModelPickerStatus("请先点击「识别模型」取得候选图片模型。", true);
    return;
  }
  adminState.imageModelPickerTargetListKey = "imagePriorityModels";
  renderSearchableModelPicker(picker, candidates, "image-model", "暂无候选图片模型", "搜索候选图片模型");
}





function renderAvailableImageModels(models) {
  const picker = el("rtImageGeminiModelPicker");
  if (!picker) return;
  adminState.imageModelPickerTargetListKey = "";
  renderSearchableModelPicker(
    picker,
    uniqueItems(Array.isArray(models) ? models : []),
    "image-model",
    "没有查询到可用图片模型",
    "搜索图片模型",
  );
}

async function toggleAvailableImageModels() {
  const picker = el("rtImageGeminiModelPicker");
  if (!picker) return;
  placeImageModelPickerNear("btnBrowseImageGeminiModels");
  if (!picker.hidden && picker.children.length > 0) {
    hideImageModelPicker();
    return;
  }
  const baseUrl = el("rtImageBaseUrl").value.trim();
  const apiKey = el("rtImageGeminiApiKey").value.trim();
  if (!baseUrl || !apiKey) {
    setImageModelPickerStatus("请先填写 API Base URL 和 API Key", true);
    return;
  }
  setImageModelPickerStatus("正在识别当前 API 支持的图片模型...");
  try {
    const resp = await api("/api/admin/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "image", provider: "openai-compatible", base_url: baseUrl, api_key: apiKey }),
    });
    renderAvailableImageModels(resp.models || []);
  } catch (err) {
    setImageModelPickerStatus(err.detail || err.message || String(err), true);
  }
}

function setVideoModelPickerStatus(message, isError = false) {
  const picker = el("rtVideoModelPicker");
  if (!picker) return;
  picker.hidden = false;
  picker.innerHTML = `<div class="admin-model-picker-status${isError ? " error" : ""}">${escapeHtml(message)}</div>`;
}

function hideVideoModelPicker() {
  const picker = el("rtVideoModelPicker");
  if (picker) picker.hidden = true;
}

function renderAvailableVideoModels(models) {
  const picker = el("rtVideoModelPicker");
  if (!picker) return;
  renderSearchableModelPicker(
    picker,
    uniqueItems(Array.isArray(models) ? models : []),
    "video-model",
    "没有查询到可用视频模型",
    "搜索视频模型",
  );
}

function applyVideoModel(model) {
  const value = String(model || "").trim();
  if (!value) return;
  const input = el("rtMuleRouterWanI2vModelName");
  if (input) input.value = value;
  const endpointInput = el("rtMuleRouterWanI2vEndpoint");
  if (endpointInput) {
    const current = String(endpointInput.value || "").trim();
    if (/\/vendors\/[^/]+\/v\d+\//i.test(current) && /\/generation(?:[/?#]|$)/i.test(current)) {
      endpointInput.value = current.replace(/(\/vendors\/[^/]+\/v\d+\/)([^/?#]+)(\/generation.*)$/i, `$1${value}$3`);
    }
  }
  hideVideoModelPicker();
  setMsg("runtimeMsg", `已选择视频模型：${value}`, true);
}

async function toggleAvailableVideoModels() {
  const picker = el("rtVideoModelPicker");
  if (!picker) return;
  if (!picker.hidden && picker.children.length > 0) {
    hideVideoModelPicker();
    return;
  }
  const baseUrl = el("rtMuleRouterBaseUrl").value.trim();
  const apiKey = el("rtMuleRouterApiKey").value.trim();
  const endpoint = el("rtMuleRouterWanI2vEndpoint").value.trim();
  setVideoModelPickerStatus("正在识别当前 API 支持的视频模型...");
  try {
    const resp = await api("/api/admin/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "video", provider: "openai-compatible", base_url: baseUrl, api_key: apiKey, endpoint }),
    });
    renderAvailableVideoModels(resp.models || []);
  } catch (err) {
    setVideoModelPickerStatus(err.detail || err.message || String(err), true);
  }
}

function bindModelTabs() {
  const tabs = Array.from(document.querySelectorAll("[data-model-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-model-panel]"));
  if (!tabs.length || !panels.length) return;
  const activate = (name) => {
    tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.modelTab === name));
    panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.modelPanel === name));
  };
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.dataset.modelTab || "text"));
  });
  activate(tabs.find((tab) => tab.classList.contains("is-active"))?.dataset.modelTab || "text");
}



function bindRunningHubSlotTabs() {
  const tabs = Array.from(document.querySelectorAll("[data-runninghub-slot-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-runninghub-slot-panel]"));
  if (!tabs.length || !panels.length) return;
  const activate = (name) => {
    tabs.forEach((tab) => tab.classList.toggle("is-active", tab.dataset.runninghubSlotTab === name));
    panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.runninghubSlotPanel === name));
  };
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.dataset.runninghubSlotTab || "persona"));
  });
  activate(tabs.find((tab) => tab.classList.contains("is-active"))?.dataset.runninghubSlotTab || "persona");
}

function closeModelPickersOnOutsideClick(target) {
  const pickerPairs = [
    ["rtLlmGrokModelPicker", "btnBrowseLlmGrokModels"],
    ["rtImageGeminiModelPicker", "btnBrowseImageGeminiModels"],
    ["rtVideoModelPicker", "btnBrowseVideoModels"],
  ];
  pickerPairs.forEach(([pickerId, triggerId]) => {
    const picker = el(pickerId);
    if (!picker || picker.hidden) return;
    if (target.closest(`#${pickerId}`) || target.closest(`#${triggerId}`)) return;
    picker.hidden = true;
  });
}

const TASK_POLL_INTERVAL_MS = 10000;
const taskState = {
  rows: [],
  inspectText: "",
};
const adminState = {
  rechargeTarget: null,
  selectedUser: null,
  userDetailRequestId: 0,
  userListRequestId: 0,
  userReviewInFlight: false,
  userDetailReturnFocus: null,
  activePage: "overview",
  llmGeminiModels: [],
  llmGptModels: [],
  llmPriorityModels: [],
  llmModelPickerTargetListKey: "",
  imageGeminiModels: [],
  imagePriorityModels: [],
  imageModelPickerTargetListKey: "",
  workflowChains: {},
  tgTrustedUsers: [],
  sentimentCookieProfiles: [],
};
const REMOTE_COMFY_TASKS = [
  ["text_to_image", "文字生成图片"],
  ["persona_post_image", "推文生成配图"],
];
const TASK_TYPE_LABELS = { text_to_image: "文字生成图片", persona_post_image: "推文生成配图" };
const ADMIN_PAGES = new Set(["overview", "users", "tasks", "pricing", "runtime", "sentimentCookies", "account"]);
const ADMIN_PAGE_ALIASES = {
  secOverview: "overview",
  secUsers: "users",
  secTasks: "tasks",
  secPricing: "pricing",
  secRuntime: "runtime",
  secSentimentCookies: "sentimentCookies",
  secAccount: "account",
};
const WORKFLOW_CHAIN_META = [];
const WORKFLOW_CHAIN_META_BY_KEY = Object.fromEntries(
  WORKFLOW_CHAIN_META.map((item) => [item.key, item]),
);
const WORKFLOW_CHAIN_CONTAINER_IDS = Object.fromEntries(
  WORKFLOW_CHAIN_META.map((item) => [item.key, item.containerId]),
);

function syncWorkflowChainFromDom(key) {
  const container = el(WORKFLOW_CHAIN_CONTAINER_IDS[key]);
  if (!container) return normalizeWorkflowChain(adminState.workflowChains[key]);
  const values = Array.from(container.querySelectorAll(".workflow-step-row"))
    .map((row) => {
      const input = row.querySelector(`[data-chain-input="${key}"]`);
      const typeNode = row.querySelector(`[data-chain-type="${key}"]`);
      const modelNode = row.querySelector(`[data-chain-model="${key}"]`);
      const value = input ? String(input.value || "").trim() : "";
      const modelValue = modelNode ? String(modelNode.value || "").trim() : "";
      const type = typeNode ? String(typeNode.value || "runninghub_workflow") : "runninghub_workflow";
      return buildWorkflowStageValue(type, normalizeWorkflowStageForType(type, modelNode ? modelValue : value));
    });
  adminState.workflowChains[key] = values.length ? values : [""];
  return adminState.workflowChains[key];
}

function renderWorkflowChain(key) {
  const container = el(WORKFLOW_CHAIN_CONTAINER_IDS[key]);
  if (!container) return;
  const meta = WORKFLOW_CHAIN_META_BY_KEY[key] || {};
  const rawItems = Array.isArray(adminState.workflowChains[key]) ? adminState.workflowChains[key] : [];
  const items = rawItems.length ? rawItems : [""];
  adminState.workflowChains[key] = items;
  container.innerHTML = items.map((value, index) => {
    const stage = parseWorkflowStage(value);
    const typeOptions = [];
    if (meta.supportsClosedLlmModel) {
      typeOptions.push(`<option value="closed_llm_model"${stage.type === "closed_llm_model" ? " selected" : ""}>闭源文字模型</option>`);
    }
    const stageTypeOptions = typeOptions.length > 1
      ? `
        <select class="workflow-step-type" data-chain-type="${key}" data-idx="${index}" aria-label="步骤类型">
          ${typeOptions.join("")}
        </select>
      `
      : "";
    const modelOptions = stage.type === "closed_llm_model" ? llmModelOptions() : [];
    let stageValue = stage.value;
    if (stage.type === "closed_llm_model") {
      stageValue = normalizeWorkflowStageForType(stage.type, stage.value);
      if (stageValue && !modelOptions.includes(stageValue)) modelOptions.push(stageValue);
    }
    let valueControl = "";
    if (stage.type === "closed_llm_model") {
      valueControl = `
        <select class="workflow-step-value" data-chain-model="${key}" data-idx="${index}" aria-label="选择文字模型">
          ${modelOptions.map((model) => `<option value="${escapeHtml(model)}"${model === stageValue ? " selected" : ""}>${escapeHtml(model)}</option>`).join("")}
        </select>
      `;
    } else {
      valueControl = `
        <input
          type="text"
          value="${escapeHtml(stageValue)}"
          data-chain-input="${key}"
          data-idx="${index}"
          placeholder="Workflow ID"
        >
      `;
    }
    return `
    <div class="workflow-step-item">
      <div class="workflow-step-row${stageTypeOptions ? " workflow-step-row-with-type" : ""}">
        <span class="workflow-step-index">步骤 ${index + 1}</span>
        ${stageTypeOptions}
        ${valueControl}
        <div class="workflow-step-actions">
          <button type="button" class="ghost workflow-step-btn" data-workflow-action="insert" data-chain="${key}" data-idx="${index}" aria-label="在后面新增一步">+</button>
          <button type="button" class="ghost workflow-step-btn" data-workflow-action="remove" data-chain="${key}" data-idx="${index}" aria-label="删除当前步骤">-</button>
        </div>
      </div>
      ${index < items.length - 1 ? '<div class="workflow-step-sep">&gt;</div>' : ""}
    </div>
  `;
  }).join("");
}

function renderAllWorkflowChains() {
  WORKFLOW_CHAIN_META.forEach((item) => renderWorkflowChain(item.key));
}

function insertWorkflowChainStep(key, index) {
  const items = syncWorkflowChainFromDom(key).slice();
  items.splice(index + 1, 0, "");
  adminState.workflowChains[key] = items;
  renderWorkflowChain(key);
}

function removeWorkflowChainStep(key, index) {
  const items = syncWorkflowChainFromDom(key).slice();
  if (items.length <= 1) {
    adminState.workflowChains[key] = [""];
  } else {
    items.splice(index, 1);
    adminState.workflowChains[key] = items.length ? items : [""];
  }
  renderWorkflowChain(key);
}

function collectWorkflowChains() {
  const result = {};
  WORKFLOW_CHAIN_META.forEach((item) => {
    result[item.key] = normalizeWorkflowChain(syncWorkflowChainFromDom(item.key));
  });
  return result;
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

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function taskStatusDetail(t) {
  const total = Number(t && t.total_count);
  const success = Number(t && t.success_count);
  const failed = Number(t && t.failed_count);
  const firstError = oneLine((t && t.first_error) || (t && t.error) || "");
  if (total > 0) {
    const parts = [`成功 ${success}/${total}`];
    if (failed > 0) parts.push(`失败 ${failed}`);
    if (firstError) parts.push(`首个失败：${firstError}`);
    return parts.join(" | ");
  }
  return firstError || "";
}

function taskStatusCell(t) {
  const detail = taskStatusDetail(t);
  return `${statusPill(t.status)}${detail ? `<div class="small">${detail}</div>` : ""}`;
}

function runninghubCell(t) {
  const ids = Array.isArray(t && t.runninghub_task_ids)
    ? t.runninghub_task_ids.map((x) => oneLine(x)).filter(Boolean)
    : [];
  if (!ids.length) {
    const single = oneLine(t && t.runninghub_task_id);
    return single || "-";
  }
  return ids.map((id) => `<div class="small">${id}</div>`).join("");
}

function runninghubList(t) {
  const ids = Array.isArray(t && t.runninghub_task_ids)
    ? t.runninghub_task_ids.map((x) => oneLine(x)).filter(Boolean)
    : [];
  if (ids.length) return ids;
  const single = oneLine(t && t.runninghub_task_id);
  return single ? [single] : [];
}

function buildExecutionTraceText(groups) {
  const items = Array.isArray(groups) ? groups : [];
  const lines = [];
  items.forEach((group) => {
    if (!group || typeof group !== "object") return;
    lines.push(`${group.title || "执行链路"}`);
    if (group.status) lines.push(`  状态：${group.status}`);
    if (group.message) lines.push(`  说明：${group.message}`);
    if (group.final_output_path) lines.push(`  最终产物：${group.final_output_path}`);
    const steps = Array.isArray(group.steps) ? group.steps : [];
    steps.forEach((step) => {
      if (!step || typeof step !== "object") return;
      const stepParts = [
        `步骤 ${step.step || "-"}`,
        step.workflow_id ? `流程=${step.workflow_id}` : "",
        step.runninghub_task_id ? `任务=${step.runninghub_task_id}` : "",
        step.status ? `状态=${step.status}` : "",
      ].filter(Boolean);
      lines.push(`  - ${stepParts.join(" | ")}`);
      if (step.input_ref) lines.push(`    输入：${step.input_ref}`);
      if (step.output_path) lines.push(`    输出：${step.output_path}`);
      if (step.uploaded_ref) lines.push(`    续链上传：${step.uploaded_ref}`);
      if (step.message) lines.push(`    说明：${step.message}`);
    });
    lines.push("");
  });
  return lines.filter((line, index, arr) => !(line === "" && arr[index - 1] === "")).join("\n").trim();
}

function buildExecutionTraceHtml(groups) {
  const items = Array.isArray(groups) ? groups : [];
  if (!items.length) {
    return `<div class="task-empty task-empty-inline">暂无执行链路详情</div>`;
  }
  return items.map((group) => {
    const steps = Array.isArray(group && group.steps) ? group.steps : [];
    const stepsHtml = steps.length
      ? steps.map((step) => {
        const meta = [
          step.workflow_id ? `流程：${oneLine(step.workflow_id)}` : "",
          step.runninghub_task_id ? `任务：${oneLine(step.runninghub_task_id)}` : "",
          step.status ? `状态：${oneLine(step.status)}` : "",
        ].filter(Boolean);
        const refs = [
          step.input_ref ? `输入：${oneLine(step.input_ref)}` : "",
          step.output_path ? `输出：${oneLine(step.output_path)}` : "",
          step.uploaded_ref ? `续链上传：${oneLine(step.uploaded_ref)}` : "",
          step.message ? `说明：${oneLine(step.message)}` : "",
        ].filter(Boolean);
        return `
          <article class="inspect-log-item">
            <div class="inspect-log-meta">
              <span>步骤 ${escapeHtml(String(step.step || "-"))}</span>
              ${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
            </div>
            ${refs.length ? `<div class="inspect-log-extra">${escapeHtml(refs.join(" | "))}</div>` : ""}
          </article>
        `;
      }).join("")
      : `<div class="task-empty task-empty-inline">暂无步骤明细</div>`;
    return `
        <div class="inspect-section-title">${escapeHtml(group.title || "执行链路")}</div>
        ${group.final_output_path ? `<div class="small" style="margin-bottom:8px">最终产物：${escapeHtml(oneLine(group.final_output_path))}</div>` : ""}
        ${group.message ? `<div class="small" style="margin-bottom:8px">说明：${escapeHtml(oneLine(group.message))}</div>` : ""}
        <div class="inspect-log-list">${stepsHtml}</div>
    `;
  }).join("");
}

function workflowCell(t) {
  const workflowName = oneLine(t.workflow_name || t.type || "-");
  const workflowId = oneLine(t.workflow_id || "-");
  const taskType = taskTypeLabel(t.type);
  return `
    <div><strong>${workflowName}</strong></div>
    <div class="small">生成类型：${taskType}</div>
    <div class="small">内部流程编号：${workflowId}</div>
  `;
}

function taskTypeLabel(taskType) {
  const key = String(taskType || "").trim();
  return TASK_TYPE_LABELS[key] || key || "-";
}

function taskActionOptions(task) {
  const status = String((task && task.status) || "");
  const options = [
    `<option value="">请选择</option>`,
    `<option value="detail">查看生成详情</option>`,
    `<option value="logs">查看处理记录</option>`,
    `<option value="export_logs">导出处理记录</option>`,
  ];
  if (task && task.has_download) {
    options.push(`<option value="download">下载结果</option>`);
  }
  if (String(status || "") === "failed") {
    options.push(`<option value="retry">重新生成</option>`);
  }
  options.push(`<option value="delete_task">删除生成记录</option>`);
  return options.join("");
}

function buildTaskDetailText(data) {
  const logs = Array.isArray(data.logs) ? data.logs : [];
  const executionTraceText = buildExecutionTraceText(data.execution_trace);
  const lines = [
    `生成编号：${data.id || "-"}`,
    `客户ID：${data.user_id || "-"}`,
    `生成类型：${taskTypeLabel(data.type)}`,
    `内部流程：${data.workflow_name || "-"}`,
    `内部流程编号：${data.workflow_id || "-"}`,
    `链路摘要：${data.workflow_chain_summary || "-"}`,
    `供应商记录编号：${data.runninghub_task_id || "-"}`,
    `供应商记录编号列表：${Array.isArray(data.runninghub_task_ids) && data.runninghub_task_ids.length ? data.runninghub_task_ids.join(", ") : "-"}`,
    `状态：${data.status || "-"}`,
    `批量结果：${data.total_count ? `成功 ${data.success_count || 0}/${data.total_count}，失败 ${data.failed_count || 0}` : "-"}`,
    `额度消耗(分)：${data.cost_cents || 0}`,
    `创建时间：${formatTime(data.created_at)}`,
    `更新时间：${formatTime(data.updated_at)}`,
    `错误：${data.error || "-"}`,
    `最近分析：${data.analysis_summary || "-"}`,
    "",
    "输入：",
    JSON.stringify(data.input || {}, null, 2),
    "",
    "输出：",
    JSON.stringify(data.output || {}, null, 2),
    "",
    "用量：",
    JSON.stringify(data.usage || {}, null, 2),
    "",
    "执行链路：",
    executionTraceText || "暂无执行链路详情",
    "",
    "详细处理记录：",
  ];
  logs.forEach((it) => {
    lines.push(`[${formatTime(it.created_at)}] [${it.kind}] ${oneLine(it.message || "-")}`);
    if (it && it.data && typeof it.data === "object") lines.push(JSON.stringify(it.data, null, 2));
  });
  if (!logs.length) lines.push("暂无详细处理记录");
  return lines.join("\n");
}

function buildTaskLogsText(payload) {
  const task = payload.task || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const analysisSummary = oneLine(task.analysis_summary || "");
  const lines = [
    `生成编号：${task.id || "-"}`,
    `生成类型：${taskTypeLabel(task.type)}`,
    `内部流程：${task.workflow_name || "-"}`,
    `内部流程编号：${task.workflow_id || "-"}`,
    `供应商记录编号：${task.runninghub_task_id || "-"}`,
    `供应商记录编号列表：${Array.isArray(task.runninghub_task_ids) && task.runninghub_task_ids.length ? task.runninghub_task_ids.join(", ") : "-"}`,
    `状态：${task.status || "-"}`,
    `批量结果：${task.total_count ? `成功 ${task.success_count || 0}/${task.total_count}，失败 ${task.failed_count || 0}` : "-"}`,
    `错误：${task.error || "-"}`,
    `最近分析：${analysisSummary || "-"}`,
    "",
    "处理记录：",
  ];
  items.forEach((it) => {
    const data = it.data || {};
    const suffix = [
      data.stage ? `阶段=${oneLine(data.stage)}` : "",
      data.status ? `状态=${oneLine(data.status)}` : "",
      data.source ? `来源=${oneLine(data.source)}` : "",
      data.item_index ? `子项=${data.item_index}` : "",
      data.item_id ? `子项ID=${oneLine(data.item_id)}` : "",
      data.runninghub_task_id ? `供应商记录编号=${oneLine(data.runninghub_task_id)}` : "",
      data.error ? `错误=${oneLine(data.error)}` : "",
    ].filter(Boolean);
    lines.push(`[${formatTime(it.created_at)}] [${it.kind}] ${oneLine(it.message)}${suffix.length ? ` | ${suffix.join(" | ")}` : ""}`);
    if (Object.keys(data).length) lines.push(`  data: ${safeJson(data)}`);
  });
  if (!items.length) lines.push("暂无处理记录");
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

function buildTaskDetailHtml(data) {
  const batchText = Number(data && data.total_count) > 0
    ? `成功 ${data.success_count || 0}/${data.total_count || 0}，失败 ${data.failed_count || 0}`
    : "-";
  const firstError = oneLine((data && data.error) || "");
  const logs = Array.isArray(data && data.logs) ? data.logs : [];
  const executionTraceHtml = buildExecutionTraceHtml(data && data.execution_trace);
  const logsHtml = logs.length
    ? logs.map((it) => {
      const detail = it && it.data && typeof it.data === "object" ? safeJson(it.data) : "";
      return `
        <article class="inspect-log-item">
          <div class="inspect-log-meta">
            <span>${escapeHtml(formatTime(it.created_at))}</span>
            <span>${escapeHtml(it.kind || "-")}</span>
          </div>
          <div class="inspect-log-text">${escapeHtml(oneLine(it.message || "-"))}</div>
          ${detail ? `<pre class="inspect-pre" style="margin-top:8px">${escapeHtml(detail)}</pre>` : ""}
        </article>
      `;
    }).join("")
    : `<div class="task-empty task-empty-inline">暂无详细处理记录</div>`;
  return `
    <div class="inspect-stack">
      <div class="inspect-grid">
        ${inspectItem("生成编号", data.id)}
        ${inspectItem("客户ID", data.user_id)}
        ${inspectItem("生成类型", taskTypeLabel(data.type))}
        ${inspectItem("内部流程", data.workflow_name)}
        ${inspectItem("内部流程编号", data.workflow_id)}
        ${inspectItem("链路摘要", data.workflow_chain_summary)}
        ${inspectItemHtml("状态", statusPill(data.status))}
        ${inspectItem("供应商记录编号", data.runninghub_task_id)}
        ${inspectItem("供应商记录编号列表", Array.isArray(data.runninghub_task_ids) && data.runninghub_task_ids.length ? data.runninghub_task_ids.join(", ") : "-")}
        ${inspectItem("批量结果", batchText)}
        ${inspectItem("额度消耗(分)", data.cost_cents || 0)}
        ${inspectItem("创建时间", formatTime(data.created_at))}
        ${inspectItem("更新时间", formatTime(data.updated_at))}
        ${inspectItem("结果下载", data.has_download ? "可下载" : "暂无结果文件")}
      </div>
      ${firstError ? `<div class="inspect-note inspect-note-bad">错误：${escapeHtml(firstError)}</div>` : ""}
      ${data.analysis_summary ? `<div class="inspect-note">最近分析：${escapeHtml(oneLine(data.analysis_summary))}</div>` : ""}
      ${String(data.status || "") === "failed" ? `<div class="row" style="margin-top:4px"><button class="primary" type="button" data-act="analyze_error" data-id="${escapeHtml(data.id)}">错误分析</button></div>` : ""}
      <div class="inspect-section">
        <div class="inspect-section-title">输入</div>
        <pre class="inspect-pre">${escapeHtml(safeJson(data.input || {}))}</pre>
      </div>
      <div class="inspect-section">
        <div class="inspect-section-title">输出</div>
        <pre class="inspect-pre">${escapeHtml(safeJson(data.output || {}))}</pre>
      </div>
      <div class="inspect-section">
        <div class="inspect-section-title">用量</div>
        <pre class="inspect-pre">${escapeHtml(safeJson(data.usage || {}))}</pre>
      </div>
      <div class="inspect-section">
        <div class="inspect-section-title">执行链路</div>
        ${executionTraceHtml}
      </div>
      <div class="inspect-section">
        <div class="inspect-section-title">详细处理记录</div>
        <div class="inspect-log-list">${logsHtml}</div>
      </div>
    </div>
  `;
}

function buildTaskLogsHtml(payload) {
  const task = payload && payload.task ? payload.task : {};
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const batchText = Number(task && task.total_count) > 0
    ? `成功 ${task.success_count || 0}/${task.total_count || 0}，失败 ${task.failed_count || 0}`
    : "-";
  const logsHtml = items.length
    ? items.map((it) => {
      const data = it && it.data && typeof it.data === "object" ? it.data : {};
      const extra = [];
      if (data.stage) extra.push(`阶段=${oneLine(data.stage)}`);
      if (data.status) extra.push(`状态=${oneLine(data.status)}`);
      if (data.source) extra.push(`来源=${oneLine(data.source)}`);
      if (data.workflow_name) extra.push(`内部流程=${data.workflow_name}`);
      if (data.workflow_id) extra.push(`内部流程编号=${data.workflow_id}`);
      if (data.runninghub_task_id) extra.push(`供应商记录编号=${data.runninghub_task_id}`);
      if (data.item_index) extra.push(`子项=${data.item_index}`);
      if (data.item_id) extra.push(`子项ID=${oneLine(data.item_id)}`);
      if (data.error) extra.push(`错误=${oneLine(data.error)}`);
      return `
        <article class="inspect-log-item">
          <div class="inspect-log-meta">
            <span>${escapeHtml(formatTime(it.created_at))}</span>
            <span>${escapeHtml(it.kind || "-")}</span>
          </div>
          <div class="inspect-log-text">${escapeHtml(oneLine(it.message || "-"))}</div>
          ${extra.length ? `<div class="inspect-log-extra">${escapeHtml(extra.join(" | "))}</div>` : ""}
          ${Object.keys(data).length ? `<pre class="inspect-pre" style="margin-top:8px">${escapeHtml(safeJson(data))}</pre>` : ""}
        </article>
      `;
    }).join("")
    : `<div class="task-empty task-empty-inline">暂无处理记录</div>`;
  return `
    <div class="inspect-stack">
      <div class="inspect-grid">
        ${inspectItem("生成编号", task.id)}
        ${inspectItem("生成类型", taskTypeLabel(task.type))}
        ${inspectItem("内部流程", task.workflow_name)}
        ${inspectItemHtml("状态", statusPill(task.status))}
        ${inspectItem("内部流程编号", task.workflow_id)}
        ${inspectItem("供应商记录编号", task.runninghub_task_id)}
        ${inspectItem("批量结果", batchText)}
        ${inspectItem("错误", task.error || "-")}
      </div>
      ${task.analysis_summary ? `<div class="inspect-note">最近分析：${escapeHtml(oneLine(task.analysis_summary))}</div>` : ""}
      ${String(task.status || "") === "failed" ? `<div class="row" style="margin-top:4px"><button class="primary" type="button" data-act="analyze_error" data-id="${escapeHtml(task.id)}">错误分析</button></div>` : ""}
      <div class="inspect-section">
        <div class="inspect-section-title">处理时间线</div>
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
  taskState.inspectText = rawText || "";
  modal.style.display = "grid";
  modal.setAttribute("aria-hidden", "false");
}

function closeTaskInspectModal() {
  const modal = el("taskInspectModal");
  if (!modal) return;
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
  taskState.inspectText = "";
}

async function copyTaskInspectText() {
  if (!taskState.inspectText) {
    setMsg("taskMsg", "当前没有可复制内容", false);
    return;
  }
  await navigator.clipboard.writeText(taskState.inspectText);
  setMsg("taskMsg", "已复制当前生成内容", true);
}

function syncSelectOptions(id, values, defaultLabel) {
  const node = el(id);
  if (!node) return;
  const current = String(node.value || "");
  const options = [`<option value="">${escapeHtml(defaultLabel)}</option>`]
    .concat(values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`));
  node.innerHTML = options.join("");
  node.value = values.includes(current) ? current : "";
}

function getTaskFilterValues() {
  return {
    search: String((el("taskSearch") && el("taskSearch").value) || "").trim().toLowerCase(),
    status: String((el("taskStatusFilter") && el("taskStatusFilter").value) || "").trim(),
    workflow: String((el("taskWorkflowFilter") && el("taskWorkflowFilter").value) || "").trim(),
    user: String((el("taskUserFilter") && el("taskUserFilter").value) || "").trim(),
  };
}

function taskSearchText(task) {
  return [
    task && task.id,
    task && task.username,
    task && task.user_id,
    task && task.workflow_name,
    task && task.workflow_id,
    task && task.workflow_chain_summary,
    task && task.type,
    task && task.runninghub_task_id,
    ...(Array.isArray(task && task.runninghub_task_ids) ? task.runninghub_task_ids : []),
    task && task.error,
    task && task.first_error,
  ].map((value) => oneLine(value)).join(" ").toLowerCase();
}

function filterTasks(rows) {
  const filters = getTaskFilterValues();
  return rows.filter((task) => {
    if (filters.search && !taskSearchText(task).includes(filters.search)) return false;
    if (filters.status && String(task.status || "") !== filters.status) return false;
    if (filters.workflow && String(task.workflow_name || task.type || "") !== filters.workflow) return false;
    if (filters.user && String(task.username || task.user_id || "") !== filters.user) return false;
    return true;
  });
}

function renderTaskSummary(allRows, visibleRows) {
  const host = el("taskSummary");
  if (!host) return;
  const activeCount = visibleRows.filter((row) => ["queued", "running"].includes(String(row.status || ""))).length;
  const successCount = visibleRows.filter((row) => String(row.status || "") === "success").length;
  const failedCount = visibleRows.filter((row) => String(row.status || "") === "failed").length;
  const downloadCount = visibleRows.filter((row) => !!row.has_download).length;
  const cards = [
    { label: "当前显示", value: visibleRows.length, hint: `全部记录 ${allRows.length}` },
    { label: "运行中 / 排队", value: activeCount, hint: "running + queued" },
    { label: "已成功", value: successCount, hint: "已完成记录" },
    { label: "可下载结果", value: downloadCount, hint: `失败 ${failedCount}` },
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
  const taskType = String((task && task.type) || "");
  const buttons = [
    `<button class="ghost task-action-btn" type="button" data-act="detail" data-id="${escapeHtml(task.id)}">详情</button>`,
    `<button class="ghost task-action-btn" type="button" data-act="logs" data-id="${escapeHtml(task.id)}">处理记录</button>`,
    `<button class="ghost task-action-btn" type="button" data-act="export_logs" data-id="${escapeHtml(task.id)}">导出</button>`,
  ];
  if (task && task.has_download) {
    buttons.push(`<button class="blue task-action-btn" type="button" data-act="download" data-id="${escapeHtml(task.id)}">下载结果</button>`);
  }
  if (String((task && task.status) || "") === "failed") {
    buttons.push(`<button class="primary task-action-btn" type="button" data-act="retry" data-id="${escapeHtml(task.id)}">重试</button>`);
  }
  buttons.push(`<button class="ghost task-action-btn" type="button" data-act="delete_task" data-id="${escapeHtml(task.id)}">删除</button>`);
  return buttons.join("");
}

function renderTaskCard(task) {
  const status = String(task.status || "").trim() || "unknown";
  const workflowName = oneLine(task.workflow_name || task.type || "-");
  const taskType = taskTypeLabel(task.type);
  const workflowId = oneLine(task.workflow_id || "-");
  const workflowChainSummary = oneLine(task.workflow_chain_summary || "");
  const userName = oneLine(task.username || task.user_id || "-");
  const batchText = Number(task.total_count) > 0
    ? `成功 ${task.success_count || 0}/${task.total_count || 0}，失败 ${task.failed_count || 0}`
    : "单任务";
  const runninghubIds = runninghubList(task);
  const errorText = oneLine(task.first_error || task.error || "");
  return `
    <article class="task-card task-card-status-${escapeHtml(status)}">
      <div class="task-card-head">
        <div class="task-card-main">
          <div class="task-card-title-row">
            <div class="task-card-title">${escapeHtml(workflowName)}</div>
            ${statusPill(task.status)}
          </div>
          <div class="task-card-subtitle">生成类型：${escapeHtml(taskType)} · 客户：${escapeHtml(userName)}</div>
          ${workflowChainSummary ? `<div class="small" style="margin-top:4px">链路摘要：${escapeHtml(workflowChainSummary)}</div>` : ""}
        </div>
        <div class="task-card-actions">
          ${taskActionButtons(task)}
        </div>
      </div>
      <div class="task-chip-row">
        <span class="meta-chip">生成编号：${escapeHtml(task.id)}</span>
        <span class="meta-chip">内部流程编号：${escapeHtml(workflowId)}</span>
        <span class="meta-chip">创建时间：${escapeHtml(formatTime(task.created_at))}</span>
        <span class="meta-chip">额度消耗：${escapeHtml(String(task.cost_cents || 0))} 分</span>
      </div>
      <div class="task-card-grid">
        <div class="task-card-item">
          <div class="task-card-label">批量进度</div>
          <div class="task-card-value">${escapeHtml(batchText)}</div>
        </div>
        <div class="task-card-item">
          <div class="task-card-label">更新时间</div>
          <div class="task-card-value">${escapeHtml(formatTime(task.updated_at || task.created_at))}</div>
        </div>
        <div class="task-card-item task-card-item-wide">
          <div class="task-card-label">供应商记录</div>
          <div class="task-card-value task-card-rh">
            ${runninghubIds.length
              ? runninghubIds.map((id) => `<span class="meta-chip meta-chip-code">${escapeHtml(id)}</span>`).join("")
              : `<span class="small">暂无供应商记录编号</span>`}
          </div>
        </div>
      </div>
      ${errorText ? `<div class="task-card-alert">错误：${escapeHtml(errorText)}</div>` : ""}
    </article>
  `;
}

function renderTasks() {
  const allRows = Array.isArray(taskState.rows) ? taskState.rows : [];
  const visibleRows = filterTasks(allRows);
  const list = el("taskList");
  const empty = el("taskEmpty");
  const meta = el("taskMetaLine");
  if (!list || !empty || !meta) return;
  renderTaskSummary(allRows, visibleRows);
  meta.textContent = visibleRows.length === allRows.length
    ? `共 ${allRows.length} 条生成记录，按创建时间倒序展示`
    : `显示 ${visibleRows.length} / ${allRows.length} 条生成记录`;
  empty.style.display = visibleRows.length ? "none" : "block";
  list.innerHTML = visibleRows.map((task) => renderTaskCard(task)).join("");
}

function setButtonLoading(buttonId, loading, loadingText) {
  const button = el(buttonId);
  if (!button) return;
  if (loading) {
    if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
    button.disabled = true;
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");
    button.textContent = loadingText || button.dataset.idleText || "";
  } else {
    button.disabled = false;
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
    if (button.dataset.idleText) button.textContent = button.dataset.idleText;
  }
}

function initSensitiveInputToggles() {
  SENSITIVE_RUNTIME_INPUT_IDS.forEach((id) => {
    const input = el(id);
    if (!input || input.type === "hidden" || input.closest(".sensitive-input-wrap")) return;
    input.type = "password";
    input.autocomplete = "off";
    input.setAttribute("spellcheck", "false");
    const wrapper = document.createElement("div");
    wrapper.className = "sensitive-input-wrap";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    input.classList.add("sensitive-input");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost sensitive-toggle-btn";
    button.dataset.target = id;
    button.innerHTML = `<span class="sensitive-eye-icon" aria-hidden="true"></span>`;
    button.setAttribute("aria-label", "\u663e\u793a\u5bc6\u94a5\u5185\u5bb9");
    button.title = "\u663e\u793a";
    button.setAttribute("aria-pressed", "false");
    wrapper.appendChild(button);
  });
}

function toggleSensitiveInput(button) {
  const input = el(button.dataset.target || "");
  if (!input) return;
  const willShow = input.type === "password";
  input.type = willShow ? "text" : "password";
  button.classList.toggle("is-visible", willShow);
  button.setAttribute("aria-label", willShow ? "\u9690\u85cf\u5bc6\u94a5\u5185\u5bb9" : "\u663e\u793a\u5bc6\u94a5\u5185\u5bb9");
  button.title = willShow ? "\u9690\u85cf" : "\u663e\u793a";
  button.setAttribute("aria-pressed", willShow ? "true" : "false");
  input.focus();
}

async function ensureAdmin() {
  const me = await api("/api/me");
  if (!me.is_admin) {
    location.href = "/console.html";
    return null;
  }
  el("adminName").textContent = me.username;
  if (el("accCurrentUsername")) el("accCurrentUsername").value = me.username || "";
  return me;
}

function runtimeFormToPayload() {
  const workflowChains = collectWorkflowChains();
  adminState.llmGeminiModels = [];
  adminState.llmGptModels = grokModelItems(adminState.llmGptModels);
  adminState.llmPriorityModels = grokModelItems(adminState.llmPriorityModels);
  adminState.imageGeminiModels = imageModelItems(adminState.imageGeminiModels);
  adminState.imagePriorityModels = imageModelItems(adminState.imagePriorityModels);
  const llmGrokModels = stringifyModelList(adminState.llmGptModels);
  const llmPriorityModels = stringifyModelList(adminState.llmPriorityModels);
  const imageGeminiModels = stringifyModelList(adminState.imageGeminiModels);
  const imagePriorityModels = stringifyModelList(adminState.imagePriorityModels);
  return {
    telegram_bot_token: el("rtTelegramBotToken") ? el("rtTelegramBotToken").value.trim() : "",
    image_generate_mode_default: "closed_model_api",
    image_generate_workflow_ids: [],
    llm_base_url: el("rtLlmBaseUrl").value.trim(),
    llm_api_key_gemini: "",
    llm_api_key_gpt: el("rtLlmApiKeyGpt").value.trim(),
    llm_api_key: el("rtLlmApiKeyGpt").value.trim(),
    llm_default_model_gemini: "",
    llm_default_model_gpt: llmGrokModels,
    llm_default_model: llmGrokModels,
    llm_model_priority_order: llmPriorityModels,
    image_model_provider_base_url: el("rtImageBaseUrl").value.trim(),
    image_model_provider_api_key_gemini: el("rtImageGeminiApiKey").value.trim(),
    image_model_default_model_gemini: imageGeminiModels,
    image_model_default_model: imageGeminiModels,
    image_model_priority_order: imagePriorityModels || imageGeminiModels,
    new_persona_runninghub_base_url: el("rtNewPersonaRunningHubBaseUrl") ? el("rtNewPersonaRunningHubBaseUrl").value.trim() : "",
    new_persona_runninghub_api_key: el("rtNewPersonaRunningHubApiKey") ? el("rtNewPersonaRunningHubApiKey").value.trim() : "",
    new_persona_runninghub_persona_t2i_detail_url: el("rtNewPersonaPersonaT2iDetailUrl") ? el("rtNewPersonaPersonaT2iDetailUrl").value.trim() : "",
    new_persona_runninghub_persona_t2i_endpoint: el("rtNewPersonaPersonaT2iEndpoint") ? el("rtNewPersonaPersonaT2iEndpoint").value.trim() : "",
    new_persona_runninghub_tweet_i2i_detail_url: el("rtNewPersonaTweetI2iDetailUrl") ? el("rtNewPersonaTweetI2iDetailUrl").value.trim() : "",
    new_persona_runninghub_tweet_i2i_endpoint: el("rtNewPersonaTweetI2iEndpoint") ? el("rtNewPersonaTweetI2iEndpoint").value.trim() : "",
    mulerouter_api_name: el("rtMuleRouterApiName") ? el("rtMuleRouterApiName").value.trim() : "",
    mulerouter_api_key: el("rtMuleRouterApiKey") ? el("rtMuleRouterApiKey").value.trim() : "",
    mulerouter_base_url: el("rtMuleRouterBaseUrl") ? el("rtMuleRouterBaseUrl").value.trim() : "",
    mulerouter_wan_i2v_model: el("rtMuleRouterWanI2vModelName") ? el("rtMuleRouterWanI2vModelName").value.trim() : "",
    mulerouter_wan_i2v_endpoint: el("rtMuleRouterWanI2vEndpoint") ? el("rtMuleRouterWanI2vEndpoint").value.trim() : "",
    mulerouter_wan_i2v_negative_prompt: el("rtMuleRouterWanI2vNegativePrompt") ? el("rtMuleRouterWanI2vNegativePrompt").value.trim() : "",
    video_app_id: "",
    cleanup_enabled: !!el("rtCleanupEnabled").checked,
    cleanup_time: el("rtCleanupTime").value || "03:30",
    cleanup_retention_days: Number(el("rtCleanupRetentionDays").value || 7),
  };
}

function fillRuntimeForm(data) {
  const v = data || {};
  const hasRuntimeField = (key) => Object.prototype.hasOwnProperty.call(v, key);
  if (el("rtTelegramBotToken")) el("rtTelegramBotToken").value = "";
  el("rtLlmBaseUrl").value = v.llm_base_url || "http://202.90.21.53:3008";
  el("rtLlmApiKeyGemini").value = "";
  el("rtLlmApiKeyGpt").value = v.llm_api_key_gpt || "";
  adminState.llmGeminiModels = [];
  adminState.llmGptModels = grokModelItems([
    ...parseModelList(v.llm_default_model_gpt || ""),
    ...parseModelList(v.llm_model_priority_order || ""),
    ...parseModelList(v.llm_default_model || ""),
  ]);
  adminState.llmPriorityModels = grokModelItems(
    hasRuntimeField("llm_model_priority_order")
      ? parseModelList(v.llm_model_priority_order)
      : adminState.llmGptModels,
  );
  el("rtImageBaseUrl").value = v.image_model_provider_base_url || "http://202.90.21.53:3008";
  el("rtImageGeminiApiKey").value = v.image_model_provider_api_key_gemini || "";
  if (el("rtNewPersonaRunningHubBaseUrl")) el("rtNewPersonaRunningHubBaseUrl").value = v.new_persona_runninghub_base_url || "https://www.runninghub.ai";
  if (el("rtNewPersonaRunningHubApiKey")) el("rtNewPersonaRunningHubApiKey").value = v.new_persona_runninghub_api_key || "";
  if (el("rtNewPersonaPersonaT2iDetailUrl")) el("rtNewPersonaPersonaT2iDetailUrl").value = v.new_persona_runninghub_persona_t2i_detail_url || "https://www.runninghub.cn/call-api/api-detail/2046514150500524033";
  if (el("rtNewPersonaPersonaT2iEndpoint")) el("rtNewPersonaPersonaT2iEndpoint").value = v.new_persona_runninghub_persona_t2i_endpoint || "/rhart-image-g-2/text-to-image";
  if (el("rtNewPersonaTweetI2iDetailUrl")) el("rtNewPersonaTweetI2iDetailUrl").value = v.new_persona_runninghub_tweet_i2i_detail_url || "https://www.runninghub.cn/call-api/api-detail/2046503667076751361";
  if (el("rtNewPersonaTweetI2iEndpoint")) el("rtNewPersonaTweetI2iEndpoint").value = v.new_persona_runninghub_tweet_i2i_endpoint || "/rhart-image-g-2/image-to-image";
  renderRunningHubPresetSelect("persona");
  renderRunningHubPresetSelect("tweet");
  adminState.imageGeminiModels = imageModelItems([
    ...parseModelList(v.image_model_default_model_gemini || ""),
    ...parseModelList(v.image_model_default_model || ""),
  ]);
  adminState.imagePriorityModels = imageModelItems(v.image_model_priority_order ? parseModelList(v.image_model_priority_order) : adminState.imageGeminiModels);
  if (el("rtMuleRouterApiName")) el("rtMuleRouterApiName").value = v.mulerouter_api_name || "";
  if (el("rtMuleRouterApiKey")) el("rtMuleRouterApiKey").value = v.mulerouter_api_key || "";
  if (el("rtMuleRouterBaseUrl")) el("rtMuleRouterBaseUrl").value = v.mulerouter_base_url || "";
  if (el("rtMuleRouterWanI2vModelName")) el("rtMuleRouterWanI2vModelName").value = v.mulerouter_wan_i2v_model || "";
  if (el("rtMuleRouterWanI2vEndpoint")) el("rtMuleRouterWanI2vEndpoint").value = v.mulerouter_wan_i2v_endpoint || "";
  if (el("rtMuleRouterWanI2vNegativePrompt")) el("rtMuleRouterWanI2vNegativePrompt").value = v.mulerouter_wan_i2v_negative_prompt || "";
  syncPriorityModelsFromCatalog("llm");
  const restoredModelDraft = mergeModelDraft();
  renderAllModelLists();
  if (restoredModelDraft) {
    setMsg("runtimeMsg", "已恢复浏览器中的未保存候选模型草稿，请确认后点击保存运行配置。", true);
  }
  adminState.workflowChains = {};
  renderAllWorkflowChains();
  el("rtCleanupEnabled").checked = v.cleanup_enabled !== false;
  el("rtCleanupTime").value = v.cleanup_time || "03:30";
  el("rtCleanupRetentionDays").value = String(v.cleanup_retention_days || 7);
}

async function loadRuntime() {
  const cfg = runtimeConfigResponseToConfig(await api("/api/admin/runtime_config"));
  fillRuntimeForm(cfg);
  return cfg;
}

async function saveRuntime() {
  const payload = runtimeFormToPayload();
  const resp = await api("/api/admin/runtime_config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const cfg = runtimeConfigResponseToConfig(resp);
  clearModelDraft();
  if (cfg) fillRuntimeForm(cfg);
  await loadTgSettings().catch(() => undefined);
  return cfg;
}

function sentimentCookieHealthLabel(health) {
  const map = {
    healthy: "正常",
    watch: "需关注",
    degraded: "需处理",
    expired: "已过期",
    missing: "未授权",
    unknown: "未知",
  };
  return map[health] || health || "-";
}

function sentimentCookieActionLabel(action) {
  const map = {
    keep: "已就绪",
    "authorize-profile": "请先登录并授权",
    "reauthorize-profile": "请重新登录并同步",
    "refresh-profile-cookies": "请刷新当前授权 Cookie",
    "refresh-before-expiry": "Cookie 即将过期，建议重新同步",
  };
  return map[action] || action || "";
}

function sentimentCookieStatusDetails(profile) {
  const validCookieCount = Number(profile?.validCookieCount || 0);
  const key = String(profile?.key || profile?.platform || "").trim().toLowerCase();
  const requiresSessionid = key === "threads";
  const ordinaryCookieReady = validCookieCount > 0;
  const ordinaryCookieText = ordinaryCookieReady
    ? `普通 Cookie：已授权（${validCookieCount}）`
    : "普通 Cookie：未授权";
  const sessionidReady = profile?.hasRequiredSessionCookie !== false && ordinaryCookieReady;
  if (!requiresSessionid) {
    return [
      { text: ordinaryCookieText, state: ordinaryCookieReady ? "ready" : "missing" },
      { text: "sessionid：未授权（当前平台不要求）", state: "unknown" },
    ];
  }
  const liveStatus = String(profile?.liveAuthStatus || "").trim();
  const liveMessage = String(profile?.liveAuthMessage || "").trim();
  const checkedAt = profile?.liveAuthCheckedAt ? formatAdminDate(profile.liveAuthCheckedAt) : "";
  const sessionidText = !ordinaryCookieReady
    ? "sessionid：未授权"
    : liveStatus === "verified"
      ? "sessionid：已授权，实时检测可用"
      : liveStatus === "invalid"
        ? "sessionid：已授权，但实时检测不可用"
        : liveStatus === "probe_failed"
          ? "sessionid：已授权，实时检测失败"
          : liveStatus === "missing_sessionid"
            ? "sessionid：未授权，当前只有普通 Cookie"
            : sessionidReady
              ? "sessionid：已授权，等待实时检测"
              : "sessionid：未授权，当前只有普通 Cookie";
  const sessionidState = liveStatus === "verified"
    ? "ready"
    : liveStatus === "probe_failed"
      ? "unknown"
      : liveStatus === "invalid" || liveStatus === "missing_sessionid"
        ? "missing"
        : sessionidReady ? "ready" : "missing";
  const solutionText = liveMessage || (sessionidReady
    ? "提示：刷新状态会自动检测 Threads sessionid 是否真实可用；如果账号被封、受限或跳登录，请重新登录可用账号并等待授权助手自动同步。"
    : "提示：Threads 全量搜索需要可用账号的 sessionid；登录可用账号后，授权助手会自动同步，也可以点击同步当前标签页。");
  return [
    { text: ordinaryCookieText, state: ordinaryCookieReady ? "ready" : "missing" },
    { text: checkedAt ? `${sessionidText}（检测时间：${checkedAt}）` : sessionidText, state: sessionidState },
    {
      text: solutionText,
      state: liveStatus === "verified" ? "ready" : (liveStatus === "probe_failed" ? "unknown" : "missing"),
    },
  ];
}

function formatAdminDate(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString("zh-CN", { hour12: false });
}

const SENTIMENT_COOKIE_PROFILE_PRIORITY = ["threads", "instagram", "xiaohongshusearch", "facebooksearch", "xsearch"];
const SENTIMENT_COOKIE_PROFILE_ALIASES = {
  threads: "threads",
  instagram: "instagram",
  x: "xsearch",
  xsearch: "xsearch",
  twitter: "xsearch",
  facebook: "facebooksearch",
  facebooksearch: "facebooksearch",
  fb: "facebooksearch",
  xiaohongshu: "xiaohongshusearch",
  xiaohongshusearch: "xiaohongshusearch",
  rednote: "xiaohongshusearch",
  xhs: "xiaohongshusearch",
};

function sentimentCookieProfileCanonicalKey(profile) {
  for (const field of ["key", "platform", "sourceKey"]) {
    const raw = String(profile?.[field] || "").trim();
    if (!raw) continue;
    const compact = raw.replace(/[\s_-]+/g, "").toLowerCase();
    const key = SENTIMENT_COOKIE_PROFILE_ALIASES[raw.toLowerCase()] || SENTIMENT_COOKIE_PROFILE_ALIASES[compact] || compact;
    if (SENTIMENT_COOKIE_PROFILE_PRIORITY.includes(key)) return key;
  }
  return "";
}

function preferredSentimentCookieProfiles(profiles) {
  const rows = Array.isArray(profiles) ? profiles : [];
  return rows
    .filter((profile) => SENTIMENT_COOKIE_PROFILE_PRIORITY.includes(sentimentCookieProfileCanonicalKey(profile)))
    .sort((a, b) => {
      const ak = sentimentCookieProfileCanonicalKey(a);
      const bk = sentimentCookieProfileCanonicalKey(b);
      const ai = SENTIMENT_COOKIE_PROFILE_PRIORITY.includes(ak) ? SENTIMENT_COOKIE_PROFILE_PRIORITY.indexOf(ak) : 99;
      const bi = SENTIMENT_COOKIE_PROFILE_PRIORITY.includes(bk) ? SENTIMENT_COOKIE_PROFILE_PRIORITY.indexOf(bk) : 99;
      if (ai !== bi) return ai - bi;
      return ak.localeCompare(bk);
    });
}

function renderSentimentCookieProfiles(payload) {
  const profiles = preferredSentimentCookieProfiles(payload?.profiles || []);
  adminState.sentimentCookieProfiles = profiles;
  const summary = payload?.summary || {};
  const summaryNode = el("sentimentCookieSummary");
  if (summaryNode) {
    summaryNode.innerHTML = `
      <div class="overview-pod"><div class="overview-label">已授权</div><div class="overview-value">${Number(summary.authorizedProfileCount || 0)}</div></div>
      <div class="overview-pod"><div class="overview-label">需处理</div><div class="overview-value">${Number(summary.needsRefreshProfileCount || 0)}</div></div>
      <div class="overview-pod"><div class="overview-label">有效 Cookie</div><div class="overview-value">${Number(summary.validCookieCount || 0)}</div></div>
      <div class="overview-pod"><div class="overview-label">过期 Cookie</div><div class="overview-value">${Number(summary.expiredCookieCount || 0)}</div></div>
    `;
  }
  const select = el("sentimentCookieProfile");
  if (select) {
    const previous = select.value;
    select.innerHTML = profiles.map((profile) => {
      const key = String(profile.key || profile.platform || "");
      const label = `${profile.label || key} (${sentimentCookieHealthLabel(profile.authHealth)})`;
      return `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`;
    }).join("");
    if (previous && profiles.some((profile) => String(profile.key || profile.platform || "") === previous)) {
      select.value = previous;
    }
  }
  const body = el("sentimentCookieBody");
  if (body) {
    body.innerHTML = profiles.map((profile) => {
      const key = String(profile.key || profile.platform || "");
      const cookieNames = (Array.isArray(profile.cookieNames) ? profile.cookieNames : []).slice(0, 12);
      const nameText = cookieNames.length ? cookieNames.join(", ") : "-";
      const statusDetails = sentimentCookieStatusDetails(profile);
      const actionLabel = sentimentCookieActionLabel(profile.recommendedAction);
      return `
        <tr>
          <td><strong>${escapeHtml(profile.label || key)}</strong><div class="small">${escapeHtml(profile.domain || profile.platform || "")}</div></td>
          <td>
            <span class="badge ${escapeHtml(profile.authHealth || "unknown")}">${escapeHtml(sentimentCookieHealthLabel(profile.authHealth))}</span>
            ${actionLabel ? `<div class="small">${escapeHtml(actionLabel)}</div>` : ""}
            ${statusDetails.map((line) => `<div class="small sentiment-cookie-detail ${escapeHtml(line.state || "unknown")}">${escapeHtml(line.text || "")}</div>`).join("")}
          </td>
          <td>${Number(profile.validCookieCount || 0)} / ${Number(profile.expiredCookieCount || 0)}</td>
          <td>${Number(profile.expiringSoonCookieCount || 0)}<div class="small">${escapeHtml(profile.nearestExpiresAt || "")}</div></td>
          <td>${escapeHtml(formatAdminDate(profile.lastAuthorizedAt))}</td>
          <td class="sentiment-cookie-names">${escapeHtml(nameText)}</td>
          <td class="sentiment-cookie-actions">
            <button type="button" class="ghost" data-act="sentiment_cookie_pick" data-id="${escapeHtml(key)}">手动填 Cookie</button>
            <button type="button" class="ghost" data-act="sentiment_cookie_open" data-id="${escapeHtml(key)}">打开</button>
          </td>
        </tr>
      `;
    }).join("");
  }
}

function selectedSentimentCookieProfile(profileKey = "") {
  const key = String(profileKey || el("sentimentCookieProfile")?.value || "").trim();
  const profiles = Array.isArray(adminState.sentimentCookieProfiles) ? adminState.sentimentCookieProfiles : [];
  return profiles.find((profile) => String(profile.key || profile.platform || "") === key) || profiles[0] || null;
}

function sentimentCookieAuthUrl(profile) {
  if (!profile) return "";
  const urls = Array.isArray(profile.authUrls) ? profile.authUrls.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const primary = String(profile.authUrl || "").trim();
  return primary || urls[0] || (profile.domain ? `https://${String(profile.domain).replace(/^\.+/, "")}/` : "");
}

function openSentimentCookieAuthPage(profileKey = "") {
  const profile = selectedSentimentCookieProfile(profileKey);
  const url = sentimentCookieAuthUrl(profile);
  if (!url) throw new Error("当前平台没有配置授权页。");
  if (el("sentimentCookieProfile") && profile) el("sentimentCookieProfile").value = String(profile.key || profile.platform || "");
  window.open(url, "_blank", "noopener");
  setMsg("sentimentCookieMsg", `已打开 ${profile?.label || profile?.key || "当前平台"} 授权页。登录完成后在浏览器授权助手中同步当前站点。`, true);
}

async function copySentimentCookieHelperBase() {
  const base = window.location.origin;
  await navigator.clipboard.writeText(base);
  setMsg("sentimentCookieMsg", `已复制助手接口地址：${base}`, true);
}

async function copySentimentCookieExtensionUrl() {
  await navigator.clipboard.writeText("chrome://extensions/");
  setMsg("sentimentCookieMsg", "已复制扩展管理页地址：chrome://extensions/。浏览器限制网页直接打开该地址，请粘贴到地址栏进入。", true);
}

async function copySentimentCookieHelperToken() {
  const payload = await api("/api/admin/sentiment/browser_auth/helper_token");
  const token = String(payload?.token || "").trim();
  if (!token) throw new Error("未取得同步令牌，请刷新后台后重试。");
  await navigator.clipboard.writeText(token);
  setMsg("sentimentCookieMsg", "已复制同步令牌。请粘贴到浏览器授权助手的同步令牌输入框并保存。", true);
}

async function rotateSentimentCookieHelperToken() {
  const payload = await api("/api/admin/sentiment/browser_auth/helper_token/rotate", { method: "POST" });
  const token = String(payload?.token || "").trim();
  if (!token) throw new Error("同步令牌轮换失败，请稍后重试。");
  await navigator.clipboard.writeText(token);
  setMsg("sentimentCookieMsg", "同步令牌已轮换并复制。新版授权助手会自动刷新后台配置；如果同步提示令牌失效，请在助手中保存新令牌或重新加载新版助手。", true);
}

function sentimentDownloadFilename(disposition) {
  const text = String(disposition || "");
  const utf8Match = text.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const match = text.match(/filename="?([^";]+)"?/i);
  return match ? match[1] : "opinx-browser-auth-helper.zip";
}

async function downloadSentimentCookieHelper() {
  setMsg("sentimentCookieMsg", "正在生成授权助手下载包...");
  const response = await fetch("/browser-auth-extension/download", {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("登录已过期，请重新登录后台后再下载授权助手。");
    if (response.status === 403) throw new Error("当前账号没有管理员权限，无法下载授权助手。");
    const text = await response.text().catch(() => "");
    throw new Error(text || `授权助手下载失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error("授权助手下载包为空，请刷新页面后重试。");
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = sentimentDownloadFilename(response.headers.get("content-disposition"));
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setMsg("sentimentCookieMsg", "授权助手 zip 已开始下载。建议优先按安装说明加载固定目录；zip 只作为备用安装包。", true);
}
async function loadSentimentCookieProfiles() {
  const payload = await api("/api/admin/sentiment/browser_auth/profiles");
  renderSentimentCookieProfiles(payload);
  return payload;
}

async function saveSentimentCookieProfile() {
  const profileKey = String(el("sentimentCookieProfile")?.value || "").trim();
  const cookiesText = String(el("sentimentCookieText")?.value || "").trim();
  const note = String(el("sentimentCookieNote")?.value || "").trim();
  if (!profileKey) throw new Error("请选择授权平台。");
  if (!cookiesText) throw new Error("请粘贴 Cookie 内容。");
  const resp = await api(`/api/admin/sentiment/browser_auth/profiles/${encodeURIComponent(profileKey)}/cookies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cookies_text: cookiesText, note }),
  });
  if (el("sentimentCookieText")) el("sentimentCookieText").value = "";
  await loadSentimentCookieProfiles();
  return resp;
}

async function clearSentimentCookieProfile() {
  const profileKey = String(el("sentimentCookieProfile")?.value || "").trim();
  if (!profileKey) throw new Error("请选择授权平台。");
  if (!confirm(`确认清空 ${profileKey} 的 Cookie 吗？清空后该平台真实扫描会失效，直到重新授权。`)) return null;
  const resp = await api(`/api/admin/sentiment/browser_auth/profiles/${encodeURIComponent(profileKey)}/cookies`, {
    method: "DELETE",
  });
  await loadSentimentCookieProfiles();
  return resp;
}

async function loadPricing() {
  const p = await api("/api/admin/pricing");
  el("priceRhCoins").value = p.rh_coins_per_10rmb;
  el("priceUsdRmb").value = p.usd_to_rmb;
  el("priceNanoUsd").value = p.nano_usd_per_image;
  el("priceGemIn").value = p.gemini_input_usd_per_1m;
  el("priceGemOut").value = p.gemini_output_usd_per_1m;
}

async function savePricing() {
  const payload = {
    rh_coins_per_10rmb: Number(el("priceRhCoins").value || 2500),
    usd_to_rmb: Number(el("priceUsdRmb").value || 7.2),
    nano_usd_per_image: Number(el("priceNanoUsd").value || 0.134),
    gemini_input_usd_per_1m: Number(el("priceGemIn").value || 4.0),
    gemini_output_usd_per_1m: Number(el("priceGemOut").value || 18.0),
  };
  await api("/api/admin/pricing", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function renderTgSettings(data) {
  const settings = data || {};
  const rows = Array.isArray(settings.trusted_users) ? settings.trusted_users : [];
  adminState.tgTrustedUsers = rows;
  setText("tgBotTokenStatus", settings.bot_token_configured ? (settings.bot_token_masked || "已配置") : "未配置");
  const sourceMap = { runtime: "运行配置", file: "本地文件", env: "环境变量" };
  setText("tgBotTokenSource", settings.bot_token_configured
    ? `当前来源：${sourceMap[settings.bot_token_source] || settings.bot_token_source || "已配置"}；输入新 Token 并保存运行配置后会立即生效。`
    : "当前未配置；输入 Bot Token 并保存运行配置后会立即生效。");
  setText("tgTrustedUserCount", rows.length);
  setText("tgBotDbPath", settings.db_path || "-");
  const envIds = Array.isArray(settings.allowed_chat_ids_env) ? settings.allowed_chat_ids_env : [];
  setText("tgBotAllowedIds", envIds.length ? envIds.join(", ") : "-");

  const body = el("tgTrustedUserBody");
  if (!body) return;
  body.innerHTML = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" class="small">暂无信任用户 ID</td>`;
    body.appendChild(tr);
    return;
  }
  rows.forEach((item) => {
    const chatId = String(item.chat_id || "");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(chatId)}</td>
      <td>${escapeHtml(item.label || "")}</td>
      <td>${item.enabled ? '<span class="pill success">启用</span>' : '<span class="pill failed">停用</span>'}</td>
      <td>${item.notify_busy ? "开启" : "关闭"}</td>
      <td>${item.notify_available ? "开启" : "关闭"}</td>
      <td>
        <button class="ghost" data-act="tg_toggle" data-id="${escapeHtml(chatId)}" data-enabled="${item.enabled ? 1 : 0}">${item.enabled ? "停用" : "启用"}</button>
        <button class="ghost" data-act="tg_delete" data-id="${escapeHtml(chatId)}">删除</button>
      </td>
    `;
    body.appendChild(tr);
  });
}

async function loadTgSettings() {
  const data = await api("/api/admin/tg_settings");
  renderTgSettings(data);
  return data;
}

async function saveTgTrustedUser() {
  const chatId = Number(el("tgTrustedChatId").value || 0);
  if (!Number.isFinite(chatId) || chatId <= 0) {
    throw new Error("请填写有效的 TG 用户 ID");
  }
  const payload = {
    chat_id: Math.floor(chatId),
    label: el("tgTrustedLabel").value.trim(),
    enabled: !!el("tgTrustedEnabled").checked,
    notify_busy: !!el("tgTrustedNotifyBusy").checked,
    notify_available: !!el("tgTrustedNotifyAvailable").checked,
  };
  const resp = await api("/api/admin/tg_trusted_users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  renderTgSettings(resp.tg_settings || resp);
  el("tgTrustedChatId").value = "";
  el("tgTrustedLabel").value = "";
  el("tgTrustedEnabled").checked = true;
  el("tgTrustedNotifyBusy").checked = true;
  el("tgTrustedNotifyAvailable").checked = true;
}

async function loadUsers() {
  const requestId = ++adminState.userListRequestId;
  const rows = (await api("/api/admin/users?limit=500")).items || [];
  if (requestId !== adminState.userListRequestId) return;
  setText("adminUserCount", rows.length);
  setText("overviewUserCount", rows.length);
  setText("overviewUserCountMirror", rows.length);
  setText("adminPendingCount", rows.filter((user) => user.approval_status === "pending").length);

  const body = el("userBody");
  body.replaceChildren();
  rows.forEach((u) => {
    const tr = document.createElement("tr");
    const role = u.is_admin ? "管理员" : "客户";
    const state = u.approval_status === "pending" ? "待授权" : (u.approval_status === "rejected" ? "已拒绝" : (u.is_disabled ? "已禁用" : "已启用"));
    [u.id, u.username, [u.full_name, u.company].filter(Boolean).join(" / ") || "-", role, state, u.balance_cents].forEach((value) => {
      const td = document.createElement("td");
      td.textContent = String(value ?? "");
      tr.appendChild(td);
    });
    const actions = document.createElement("td");
    const addAction = (label, act, extra = {}) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.textContent = label;
      button.dataset.act = act;
      button.dataset.id = String(u.id);
      Object.entries(extra).forEach(([key, value]) => { button.dataset[key] = String(value); });
      actions.appendChild(button);
    };
    addAction("查看详情", "user_detail");
    if (u.approval_status === "approved") {
      addAction("额度分配", "recharge", { name: u.username });
      addAction(u.is_disabled ? "启用" : "禁用", "toggle", { disabled: u.is_disabled ? 1 : 0 });
    }
    addAction("删除", "delete_user", { name: u.username });
    tr.appendChild(actions);
    body.appendChild(tr);
  });
}

function detailRow(label, value) {
  const row = document.createElement("div");
  row.className = "admin-user-detail-item";
  const title = document.createElement("span");
  const content = document.createElement("strong");
  title.textContent = label;
  content.textContent = String(value === null || value === undefined || value === "" ? "-" : value);
  row.append(title, content);
  return row;
}

function clearUserPasswordReset() {
  if (el("userPasswordResultValue")) el("userPasswordResultValue").textContent = "";
  if (el("userPasswordResult")) el("userPasswordResult").hidden = true;
}

async function resetSelectedUserPassword() {
  const user = adminState.selectedUser;
  if (!user?.id || user.is_admin) return;
  if (!confirm(`确认重置账号 ${user.username || user.id} 的登录密码吗？该账号现有登录会话会立即失效。`)) return;
  el("btnResetUserPassword").disabled = true;
  try {
    clearUserPasswordReset();
    const response = await api(`/api/admin/users/${user.id}/reset-password`, {
      method: "POST",
    });
    el("userPasswordResultValue").textContent = String(response.temporary_password || "");
    el("userPasswordResult").hidden = false;
    setMsg("userDetailMsg", "密码已重置，旧登录会话已失效。请立即复制并安全交付给用户。", true);
  } finally {
    el("btnResetUserPassword").disabled = false;
  }
}

async function openUserDetailModal(id) {
  adminState.userDetailReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const requestId = ++adminState.userDetailRequestId;
  const response = await api(`/api/admin/users/${id}`);
  if (requestId !== adminState.userDetailRequestId) return;
  const user = response.user || {};
  const resourceCounts = response.resource_counts || {};
  adminState.selectedUser = user;
  el("userDetailSub").textContent = `${user.username || "-"} · ID ${user.id || "-"}`;
  const body = el("userDetailBody");
  body.replaceChildren(
    detailRow("登录账号", user.username),
    detailRow("账号 ID", user.id),
    detailRow("姓名", user.full_name),
    detailRow("公司 / 团队", user.company),
    detailRow("电子邮箱", user.email),
    detailRow("联系电话", user.phone),
    detailRow("账号角色", user.is_admin ? "管理员" : "客户"),
    detailRow("账号状态", user.is_disabled ? "已禁用" : "已启用"),
    detailRow("密码状态", user.password_configured ? "已设置（仅可重置）" : "未设置"),
    detailRow("申请类型", user.account_type === "guest" ? "游客申请" : "后台创建"),
    detailRow("审核状态", user.approval_status),
    detailRow("可用额度", `${user.balance_cents || 0} 分`),
    detailRow("最后登录", user.last_login_at ? formatTime(user.last_login_at) : "尚未登录"),
    detailRow("创建时间", user.created_at ? formatTime(user.created_at) : "-"),
    detailRow("更新时间", user.updated_at ? formatTime(user.updated_at) : "-"),
    detailRow("授权时间", user.approved_at ? formatTime(user.approved_at) : "尚未授权"),
    detailRow("授权管理员", user.approved_by_username ? `${user.approved_by_username} · ID ${user.approved_by}` : "-"),
    detailRow("人设 / 分组", `${Number(resourceCounts.personas || 0)} / ${Number(resourceCounts.persona_groups || 0)}`),
    detailRow("社媒账号 / 代理", `${Number(resourceCounts.social_accounts || 0)} / ${Number(resourceCounts.social_proxies || 0)}`),
    detailRow("自动化任务", Number(resourceCounts.social_tasks || 0)),
  );
  const useCase = detailRow("使用情境", user.use_case);
  useCase.classList.add("admin-user-detail-item-wide");
  body.appendChild(useCase);
  clearUserPasswordReset();
  el("userPasswordSection").hidden = !!user.is_admin;
  el("userApprovalNote").value = user.admin_note || "";
  setMsg("userDetailMsg", "");
  el("btnApproveUser").disabled = !!user.is_admin || user.approval_status === "approved";
  el("btnRejectUser").disabled = !!user.is_admin || user.approval_status !== "pending";
  el("userDetailModal").style.display = "grid";
  el("userDetailModal").setAttribute("aria-hidden", "false");
  window.setTimeout(() => el("btnUserDetailClose")?.focus(), 0);
}

function closeUserDetailModal() {
  const modal = el("userDetailModal");
  if (!modal || modal.getAttribute("aria-hidden") === "true") return;
  adminState.userDetailRequestId += 1;
  clearUserPasswordReset();
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
  adminState.selectedUser = null;
  const returnFocus = adminState.userDetailReturnFocus;
  adminState.userDetailReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}

async function reviewSelectedUser(approvalStatus) {
  const user = adminState.selectedUser;
  if (!user?.id || adminState.userReviewInFlight) return;
  adminState.userReviewInFlight = true;
  el("btnApproveUser").disabled = true;
  el("btnRejectUser").disabled = true;
  try {
    await api(`/api/admin/users/${user.id}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approval_status: approvalStatus,
        expected_approval_status: user.approval_status,
        admin_note: el("userApprovalNote").value.trim(),
      }),
    });
    closeUserDetailModal();
    await loadUsers();
    setMsg("userMsg", approvalStatus === "approved" ? "账号已授权并启用" : "账号申请已拒绝", true);
  } finally {
    adminState.userReviewInFlight = false;
    if (adminState.selectedUser) {
      el("btnApproveUser").disabled = !!user.is_admin || user.approval_status === "approved";
      el("btnRejectUser").disabled = !!user.is_admin || user.approval_status !== "pending";
    }
  }
}

async function loadTasks() {
  const rows = (await api("/api/admin/tasks?limit=300")).items || [];
  taskState.rows = rows;
  const total = rows.length;
  const failed = rows.filter((row) => String(row.status || "") === "failed").length;
  const running = rows.filter((row) => ["running", "queued"].includes(String(row.status || ""))).length;
  setText("adminTaskCount", total);
  setText("overviewTaskCount", total);
  setText("overviewTaskCountMirror", total);
  setText("overviewFailedCount", failed);
  setText("overviewFailedCountMirror", failed);
  setText("overviewRunningCount", running);
  setText("overviewRunningCountMirror", running);
  syncSelectOptions(
    "taskStatusFilter",
    Array.from(new Set(rows.map((row) => String(row.status || "").trim()).filter(Boolean))).sort(),
    "全部状态",
  );
  syncSelectOptions(
    "taskWorkflowFilter",
    Array.from(new Set(rows.map((row) => String(row.workflow_name || row.type || "").trim()).filter(Boolean))).sort(),
    "全部类型",
  );
  syncSelectOptions(
    "taskUserFilter",
    Array.from(new Set(rows.map((row) => String(row.username || row.user_id || "").trim()).filter(Boolean))).sort(),
    "全部客户",
  );
  renderTasks();
  const lastUpdated = el("taskLastUpdated");
  if (lastUpdated) lastUpdated.textContent = `最近刷新：${new Date().toLocaleTimeString()}`;
}

async function createUser() {
  const payload = {
    username: el("newUserName").value.trim(),
    password: el("newUserPassword").value,
    is_admin: !!el("newUserIsAdmin").checked,
    balance_cents: Number(el("newUserBalance").value || 0),
  };
  if (!payload.username) throw new Error("客户用户名不能为空");
  if (!payload.password || payload.password.length < 6) throw new Error("密码至少 6 位");
  await api("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  el("newUserName").value = "";
  el("newUserPassword").value = "";
  el("newUserIsAdmin").checked = false;
  el("newUserBalance").value = "0";
}

async function runTaskAction(act, id) {
  if (act === "detail") {
    const data = await api(`/api/tasks/${id}`);
    openTaskInspectModal({
      title: "生成详情",
      subtitle: `${data.workflow_name || data.type || "任务"} · ${data.id || id}`,
      html: buildTaskDetailHtml(data),
      rawText: buildTaskDetailText(data),
    });
    return true;
  }
  if (act === "logs") {
    const data = await api(`/api/admin/tasks/${id}/logs?limit=500`);
    openTaskInspectModal({
      title: "处理记录",
      subtitle: `${(data.task && (data.task.workflow_name || data.task.type)) || "任务"} · ${id}`,
      html: buildTaskLogsHtml(data),
      rawText: buildTaskLogsText(data),
    });
    return true;
  }
  if (act === "export_logs") {
    window.open(`/api/admin/tasks/${id}/logs/export`, "_blank");
    return true;
  }
  if (act === "download") {
    window.open(`/api/tasks/${id}/download`, "_blank");
    return true;
  }
  if (act === "analyze_error") {
    setMsg("taskMsg", "");
    try {
      await api(`/api/admin/tasks/${id}/analyze_error`, { method: "POST" });
      const data = await api(`/api/tasks/${id}`);
      openTaskInspectModal({
        title: "生成详情",
        subtitle: `${data.workflow_name || data.type || "任务"} · ${data.id || id}`,
        html: buildTaskDetailHtml(data),
        rawText: buildTaskLogsText({ task: data, items: data.logs || [] }),
      });
      setMsg("taskMsg", "错误分析已生成", true);
      await loadTasks();
    } catch (err) {
      setMsg("taskMsg", err.detail || err.message || String(err), false);
    }
    return true;
  }
  if (act === "retry") {
    setMsg("taskMsg", "");
    try {
      const resp = await api(`/api/tasks/${id}/retry`, { method: "POST" });
      setMsg("taskMsg", `已创建重试记录，新生成编号：${resp.id}`, true);
      await loadTasks();
    } catch (err) {
      setMsg("taskMsg", err.detail || err.message || String(err), false);
    }
    return true;
  }
  if (act === "retry_resume") {
    setMsg("taskMsg", "");
    try {
      const resp = await api(`/api/tasks/${id}/retry_resume`, { method: "POST" });
      setMsg("taskMsg", `已创建断点重试记录，新生成编号：${resp.id}`, true);
      await loadTasks();
    } catch (err) {
      setMsg("taskMsg", err.detail || err.message || String(err), false);
    }
    return true;
  }
  if (act === "delete_task") {
    if (!confirm(`确认删除生成记录 ${id} 吗？`)) return true;
    await api(`/api/admin/tasks/${id}`, { method: "DELETE" });
    await loadTasks();
    return true;
  }
  return false;
}

function openRechargeModal(id, name) {
  adminState.rechargeTarget = { id: String(id || ""), name: String(name || id || "") };
  if (el("rechargeSub")) el("rechargeSub").textContent = `客户：${adminState.rechargeTarget.name}`;
  if (el("rechargeAmount")) el("rechargeAmount").value = "1000";
  if (el("rechargeNote")) el("rechargeNote").value = "额度分配";
  setMsg("rechargeMsg", "");
  const modal = el("rechargeModal");
  if (modal) {
    modal.style.display = "grid";
    modal.setAttribute("aria-hidden", "false");
  }
}

function closeRechargeModal() {
  const modal = el("rechargeModal");
  if (modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }
  adminState.rechargeTarget = null;
}

async function submitRecharge() {
  const target = adminState.rechargeTarget;
  if (!target || !target.id) return;
  const amount = Number(el("rechargeAmount").value || 0);
  const note = String(el("rechargeNote").value || "").trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    setMsg("rechargeMsg", "额度必须为正整数（分）", false);
    return;
  }
  await api(`/api/admin/users/${target.id}/recharge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount_cents: Math.floor(amount), note }),
  });
  closeRechargeModal();
  await loadUsers();
}

function bindActions() {
  bindModelTabs();
  bindTextModelContentTabs();
  bindRunningHubSlotTabs();
  el("btnSaveRuntime").addEventListener("click", async () => {
    setMsg("runtimeMsg", "");
    try {
      await saveRuntime();
      setMsg("runtimeMsg", "运行配置已保存，并已按本地配置文件内容回填表单", true);
    } catch (err) {
      setMsg("runtimeMsg", formatRuntimeConfigError("保存", err), false);
    }
  });

  [
    ["btnAddLlmGptModel", "rtLlmGptModelInput", "llmGptModels"],
  ].forEach(([buttonId, inputId, listKey]) => {
    if (el(buttonId)) {
      el(buttonId).addEventListener("click", () => addModelFromInput(listKey, inputId));
    }
    if (el(inputId)) {
      el(inputId).addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addModelFromInput(listKey, inputId);
        }
      });
    }
  });

  if (el("btnBrowseLlmGrokModels")) {
    el("btnBrowseLlmGrokModels").addEventListener("click", toggleAvailableLlmModels);
  }
  if (el("rtLlmGrokModelPicker")) {
    el("rtLlmGrokModelPicker").addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const model = target.dataset.llmModel || "";
      if (model) addLlmModelFromPicker(model);
    });
    bindModelPickerFilters("rtLlmGrokModelPicker");
  }
  if (el("btnBrowseImageGeminiModels")) {
    el("btnBrowseImageGeminiModels").addEventListener("click", toggleAvailableImageModels);
  }
  if (el("rtImageGeminiModelPicker")) {
    el("rtImageGeminiModelPicker").addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const model = target.dataset.imageModel || "";
      if (model) addImageModelFromPicker(model);
    });
    bindModelPickerFilters("rtImageGeminiModelPicker");
  }
  if (el("btnBrowseVideoModels")) {
    el("btnBrowseVideoModels").addEventListener("click", toggleAvailableVideoModels);
  }
  bindRunningHubPresetSelect("persona");
  bindRunningHubPresetSelect("tweet");
  document.querySelectorAll("[data-secret-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = el(button.dataset.secretTarget || "");
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
    });
  });
  if (el("btnApplyVideoModel")) {
    el("btnApplyVideoModel").addEventListener("click", () => applyVideoModel(el("rtMuleRouterWanI2vModelName")?.value));
  }
  if (el("rtVideoModelPicker")) {
    el("rtVideoModelPicker").addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const model = target.dataset.videoModel || "";
      if (model) applyVideoModel(model);
    });
    bindModelPickerFilters("rtVideoModelPicker");
  }

  [
    ["btnAddLlmPriorityModel", "llmPriorityModels"],
  ].forEach(([buttonId, listKey]) => {
    if (el(buttonId)) {
      el(buttonId).addEventListener("click", (event) => {
        event.stopPropagation();
        openLlmPriorityModelPicker(listKey);
      });
    }
  });

  if (el("btnAddImagePriorityModel")) {
    el("btnAddImagePriorityModel").addEventListener("click", (event) => {
      event.stopPropagation();
      openImagePriorityModelPicker();
    });
  }

  el("btnSavePricing").addEventListener("click", async () => {
    setMsg("pricingMsg", "");
    try {
      await savePricing();
      setMsg("pricingMsg", "计费参数已保存", true);
    } catch (err) {
      setMsg("pricingMsg", err.detail || String(err), false);
    }
  });

  if (el("btnRefreshTgTrustedUsers")) {
    el("btnRefreshTgTrustedUsers").addEventListener("click", async () => {
      setMsg("tgSettingsMsg", "");
      try {
        await loadTgSettings();
      setMsg("tgSettingsMsg", "TG 信任用户已删除", true);
      } catch (err) {
        setMsg("tgSettingsMsg", getErrorMessage(err), false);
      }
    });
  }

  if (el("btnAddTgTrustedUser")) {
    el("btnAddTgTrustedUser").addEventListener("click", async () => {
      setMsg("tgSettingsMsg", "");
      try {
        await saveTgTrustedUser();
        setMsg("tgSettingsMsg", "信任用户 ID 已保存", true);
      } catch (err) {
        setMsg("tgSettingsMsg", getErrorMessage(err), false);
      }
    });
  }

  el("btnCreateUser").addEventListener("click", async () => {
    setMsg("userMsg", "");
    try {
      await createUser();
      setMsg("userMsg", "客户账号已创建", true);
      await loadUsers();
    } catch (err) {
      setMsg("userMsg", err.detail || err.message || String(err), false);
    }
  });

  if (el("btnChangePassword")) {
    el("btnChangePassword").addEventListener("click", async () => {
      clearAccountMsgs();
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
        setMsg("accountPasswordMsg", err.detail || String(err), false);
      }
    });
  }

  if (el("btnChangeUsername")) {
    el("btnChangeUsername").addEventListener("click", async () => {
      clearAccountMsgs();
      const newUsername = (el("accNewUsername").value || "").trim();
      const pwd = el("accUsernamePassword").value || "";
      if (!newUsername) return setMsg("accountUsernameMsg", "请填写新用户名", false);
      if (newUsername.length < 3 || newUsername.length > 32) return setMsg("accountUsernameMsg", "新用户名长度需在 3-32 之间", false);
      if (!/^[a-zA-Z0-9._-]+$/.test(newUsername)) return setMsg("accountUsernameMsg", "新用户名仅支持字母/数字/.-_", false);
      if (!pwd) return setMsg("accountUsernameMsg", "请填写当前密码用于确认", false);
      try {
        await api("/api/auth/change_username", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd, new_username: newUsername }),
        });
        el("accUsernamePassword").value = "";
        el("accNewUsername").value = "";
        const me = await api("/api/me");
        el("adminName").textContent = me.username;
        if (el("accCurrentUsername")) el("accCurrentUsername").value = me.username || "";
        setMsg("accountUsernameMsg", "用户名已修改", true);
      } catch (err) {
        setMsg("accountUsernameMsg", err.detail || String(err), false);
      }
    });
  }

  el("btnLogout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    location.href = "/admin";
  });

  el("btnToUser").addEventListener("click", () => {
    location.href = "/console.html";
  });

  if (el("btnTaskRefresh")) {
    el("btnTaskRefresh").addEventListener("click", async () => {
      try {
        setMsg("taskMsg", "");
        await loadTasks();
      } catch (err) {
        setMsg("taskMsg", err.detail || err.message || String(err), false);
      }
    });
  }

  ["taskSearch", "taskStatusFilter", "taskWorkflowFilter", "taskUserFilter"].forEach((id) => {
    const node = el(id);
    if (!node) return;
    node.addEventListener(id === "taskSearch" ? "input" : "change", () => {
      renderTasks();
    });
  });

  if (el("btnTaskFilterReset")) {
    el("btnTaskFilterReset").addEventListener("click", () => {
      if (el("taskSearch")) el("taskSearch").value = "";
      if (el("taskStatusFilter")) el("taskStatusFilter").value = "";
      if (el("taskWorkflowFilter")) el("taskWorkflowFilter").value = "";
      if (el("taskUserFilter")) el("taskUserFilter").value = "";
      renderTasks();
    });
  }

  if (el("btnSentimentCookieRefresh")) {
    el("btnSentimentCookieRefresh").addEventListener("click", async () => {
      setMsg("sentimentCookieMsg", "正在刷新舆情 Cookie 状态...");
      try {
        await loadSentimentCookieProfiles();
        setMsg("sentimentCookieMsg", "舆情 Cookie 状态已刷新。", true);
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnSentimentCookieOpenAuth")) {
    el("btnSentimentCookieOpenAuth").addEventListener("click", () => {
      try {
        openSentimentCookieAuthPage();
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnSentimentCookieDownloadHelper")) {
    el("btnSentimentCookieDownloadHelper").addEventListener("click", async () => {
      try {
        await downloadSentimentCookieHelper();
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnSentimentCookieCopyBase")) {
    el("btnSentimentCookieCopyBase").addEventListener("click", async () => {
      try {
        await copySentimentCookieHelperBase();
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnSentimentCookieCopyExtensionUrl")) {
    el("btnSentimentCookieCopyExtensionUrl").addEventListener("click", async () => {
      try {
        await copySentimentCookieExtensionUrl();
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnSentimentCookieSave")) {
    el("btnSentimentCookieSave").addEventListener("click", async () => {
      setMsg("sentimentCookieMsg", "正在保存授权 Cookie...");
      try {
        const resp = await saveSentimentCookieProfile();
        setMsg("sentimentCookieMsg", `已保存 ${Number(resp?.savedCookieCount || 0)} 个 Cookie。`, true);
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
    });
  }
  if (el("btnSentimentCookieClear")) {
    el("btnSentimentCookieClear").addEventListener("click", async () => {
      setMsg("sentimentCookieMsg", "");
      try {
        const resp = await clearSentimentCookieProfile();
        if (resp) setMsg("sentimentCookieMsg", "当前平台 Cookie 已清空。", true);
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
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
        setMsg("taskMsg", err.message || String(err), false);
      }
    });
  }
  if (el("taskInspectModal")) {
    el("taskInspectModal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeTaskInspectModal();
    });
  }
  if (el("btnRechargeClose")) {
    el("btnRechargeClose").addEventListener("click", () => closeRechargeModal());
  }
  if (el("btnRechargeSubmit")) {
    el("btnRechargeSubmit").addEventListener("click", async () => {
      setMsg("rechargeMsg", "");
      try {
        await submitRecharge();
      } catch (err) {
        setMsg("rechargeMsg", err.detail || err.message || String(err), false);
      }
    });
  }
  if (el("rechargeModal")) {
    el("rechargeModal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeRechargeModal();
    });
  }
  if (el("btnUserDetailClose")) {
    el("btnUserDetailClose").addEventListener("click", closeUserDetailModal);
  }
  if (el("btnApproveUser")) {
    el("btnApproveUser").addEventListener("click", async () => {
      try {
        await reviewSelectedUser("approved");
      } catch (err) {
        setMsg("userDetailMsg", err.detail || err.message || String(err), false);
      }
    });
  }
  if (el("btnRejectUser")) {
    el("btnRejectUser").addEventListener("click", async () => {
      if (!confirm("确认拒绝该账号的使用申请吗？")) return;
      try {
        await reviewSelectedUser("rejected");
      } catch (err) {
        setMsg("userDetailMsg", err.detail || err.message || String(err), false);
      }
    });
  }
  if (el("btnResetUserPassword")) {
    el("btnResetUserPassword").addEventListener("click", async () => {
      try {
        await resetSelectedUserPassword();
      } catch (err) {
        setMsg("userDetailMsg", err.detail || err.message || String(err), false);
      }
    });
  }
  if (el("btnCopyUserPassword")) {
    el("btnCopyUserPassword").addEventListener("click", async () => {
      const password = String(el("userPasswordResultValue")?.textContent || "");
      if (!password) return;
      try {
        await navigator.clipboard.writeText(password);
        setMsg("userDetailMsg", "临时密码已复制。", true);
      } catch {
        setMsg("userDetailMsg", "复制失败，请手动选择临时密码。", false);
      }
    });
  }
  if (el("userDetailModal")) {
    el("userDetailModal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeUserDetailModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeTaskInspectModal();
      closeRechargeModal();
      closeUserDetailModal();
    }
  });
  document.addEventListener("change", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const chainKey = target.dataset ? String(target.dataset.chainType || "") : "";
    if (chainKey && WORKFLOW_CHAIN_CONTAINER_IDS[chainKey]) {
      syncWorkflowChainFromDom(chainKey);
      renderWorkflowChain(chainKey);
    }
  });

  document.querySelectorAll("[data-page]").forEach((node) => {
    node.addEventListener("click", () => {
      setActiveAdminPage(node.dataset.page || "overview");
    });
  });

  document.addEventListener("click", async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    closeModelPickersOnOutsideClick(target);
    const sensitiveToggle = target.closest(".sensitive-toggle-btn");
    if (sensitiveToggle instanceof HTMLElement) {
      toggleSensitiveInput(sensitiveToggle);
      return;
    }
    const btn = target;
    if (btn.classList.contains("admin-model-chip-remove")) {
      const idx = Number(btn.dataset.idx || -1);
      const listName = String(btn.dataset.list || "");
      const list = adminState[listName];
      if (idx >= 0 && Array.isArray(list)) {
        const [removedModel] = list.splice(idx, 1);
        if (listName === "llmGptModels") {
          ["llmPriorityModels"].forEach((priorityKey) => {
            if (Array.isArray(adminState[priorityKey])) {
              adminState[priorityKey] = adminState[priorityKey].filter((model) => model !== removedModel);
            }
          });
          syncPriorityModelsFromCatalog("llm");
        } else if (listName === "llmPriorityModels") {
          syncPriorityModelsFromCatalog("llm");
        } else if (listName === "imageGeminiModels" || listName === "imagePriorityModels") {
          syncPriorityModelsFromCatalog("image");
        }
        writeModelDraft();
        renderAllModelLists();
      }
      return;
    }
    if (btn.dataset.priorityAction) {
      const action = String(btn.dataset.priorityAction || "");
      const listName = String(btn.dataset.priorityList || "");
      const idx = Number(btn.dataset.priorityIdx || -1);
      const list = adminState[listName];
      if (!Array.isArray(list) || idx < 0 || idx >= list.length) return;
      if (action === "up" && idx > 0) {
        const item = list[idx];
        list[idx] = list[idx - 1];
        list[idx - 1] = item;
      } else if (action === "down" && idx < list.length - 1) {
        const item = list[idx];
        list[idx] = list[idx + 1];
        list[idx + 1] = item;
      }
      if (listName === "llmPriorityModels") syncPriorityModelsFromCatalog("llm");
      if (listName === "imagePriorityModels") syncPriorityModelsFromCatalog("image");
      writeModelDraft();
      renderAllModelLists();
      return;
    }
    if (btn.dataset.workflowAction) {
      const idx = Number(btn.dataset.idx || -1);
      const chainKey = String(btn.dataset.chain || "");
      if (idx < 0 || !WORKFLOW_CHAIN_CONTAINER_IDS[chainKey]) return;
      if (btn.dataset.workflowAction === "insert") {
        insertWorkflowChainStep(chainKey, idx);
      } else if (btn.dataset.workflowAction === "remove") {
        removeWorkflowChainStep(chainKey, idx);
      }
      return;
    }
    if (!btn.dataset) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if (!act || !id) return;

    try {
      if (await runTaskAction(act, id, btn)) return;
    } catch (err) {
      setMsg("taskMsg", err.detail || err.message || String(err), false);
      return;
    }
    if (act === "recharge") {
      openRechargeModal(id, btn.dataset.name || id);
      return;
    }
    if (act === "user_detail") {
      try {
        await openUserDetailModal(id);
      } catch (err) {
        setMsg("userMsg", getErrorMessage(err), false);
      }
      return;
    }
    if (act === "toggle") {
      const disabled = String(btn.dataset.disabled || "0") === "1";
      try {
        await api(`/api/admin/users/${id}/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_disabled: !disabled }),
        });
        await loadUsers();
      } catch (err) {
        setMsg("userMsg", getErrorMessage(err), false);
      }
      return;
    }
    if (act === "delete_user") {
      const name = btn.dataset.name || id;
      if (!confirm(`确认删除客户 ${name} 吗？该客户的会话、生成记录和额度流水都会删除。`)) return;
      try {
        await api(`/api/admin/users/${id}`, { method: "DELETE" });
        await loadUsers();
        await loadTasks();
      } catch (err) {
        setMsg("userMsg", getErrorMessage(err), false);
      }
      return;
    }
    if (act === "tg_toggle") {
      const enabled = String(btn.dataset.enabled || "0") === "1";
      const resp = await api(`/api/admin/tg_trusted_users/${id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      renderTgSettings(resp.tg_settings || resp);
      setMsg("tgSettingsMsg", enabled ? "TG 用户已停用" : "TG 用户已启用", true);
      return;
    }
    if (act === "tg_delete") {
      if (!confirm(`确认删除 TG 信任用户 ${id} 吗？`)) return;
      const resp = await api(`/api/admin/tg_trusted_users/${id}`, { method: "DELETE" });
      renderTgSettings(resp.tg_settings || resp);
      setMsg("tgSettingsMsg", "TG 信任用户已删除", true);
      return;
    }
    if (act === "sentiment_cookie_pick") {
      if (el("sentimentCookieProfile")) el("sentimentCookieProfile").value = id;
      if (el("sentimentCookieText")) el("sentimentCookieText").focus();
      setActiveAdminPage("sentimentCookies");
      return;
    }
    if (act === "sentiment_cookie_open") {
      try {
        openSentimentCookieAuthPage(id);
      } catch (err) {
        setMsg("sentimentCookieMsg", getErrorMessage(err), false);
      }
      setActiveAdminPage("sentimentCookies");
      return;
    }
    if (act === "delete_task") {
      return;
    }
  });
}







function buildLlmModelSummary() {
  const priority = grokModelItems(adminState.llmPriorityModels);
  if (priority.length) return `文字模型：${priority[0]}`;
  const model = llmModelOptions()[0] || "";
  if (model) return `文字模型：${model}`;
  return "未配置文字模型";
}

function renderModelSummaries() {
  const llmSummary = el("rtLlmModelSummary");
  if (llmSummary) llmSummary.textContent = buildLlmModelSummary();
  const imageSummary = el("rtImageModelSummary");
  if (imageSummary) {
    const priority = imageModelItems(adminState.imagePriorityModels);
    const first = priority[0] || imageModelOptions()[0] || "";
    imageSummary.textContent = first ? `图片模型：${first}` : "未配置图片模型";
  }
}

function bindTextModelContentTabs() {
  return;
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    const me = await ensureAdmin();
    if (!me) return;
    initSensitiveInputToggles();
    bindActions();
    setActiveAdminPage(readAdminPageFromHash(), false);
  } catch {
    location.href = "/admin";
    return;
  }

  try {
    await loadRuntime();
    setMsg("runtimeMsg", "");
  } catch (err) {
    setMsg("runtimeMsg", formatRuntimeConfigError("读取", err), false);
  }

  try {
    await loadTgSettings();
    setMsg("tgSettingsMsg", "");
  } catch (err) {
    setMsg("tgSettingsMsg", getErrorMessage(err), false);
  }

  try {
    await loadSentimentCookieProfiles();
    setMsg("sentimentCookieMsg", "");
  } catch (err) {
    setMsg("sentimentCookieMsg", getErrorMessage(err), false);
  }

  try {
    await loadPricing();
  } catch (err) {
    setMsg("pricingMsg", getErrorMessage(err), false);
  }

  try {
    await loadUsers();
  } catch (err) {
    setMsg("userMsg", getErrorMessage(err), false);
  }

  try {
    await loadTasks();
  } catch (err) {
    setMsg("taskMsg", getErrorMessage(err), false);
  }

  setInterval(async () => {
    try {
      await loadUsers();
      if (!el("taskAutoRefresh") || el("taskAutoRefresh").checked) {
        await loadTasks();
      }
    } catch {
      // ignore
    }
  }, TASK_POLL_INTERVAL_MS);
});

window.addEventListener("hashchange", () => {
  setActiveAdminPage(readAdminPageFromHash(), false);
});
