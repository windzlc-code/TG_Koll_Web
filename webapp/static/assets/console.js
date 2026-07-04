const $ = (id) => document.getElementById(id);

const state = {
  view: "workspace",
  activeModule: "personas",
  workspaceMenuOpen: true,
  generationType: "text_to_image",
  personaGroup: "content",
  simpleBranches: {},
  files: [],
  tasks: [],
  personas: [],
  selectedPersonaId: "",
  socialAccounts: [],
  socialTasks: [],
  events: null,
};

const modules = [
  { id: "generation", label: "生成 / 编辑任务", hint: "文生图、图生图、修图、换脸、视频", callback: "toolr18_generation" },
  { id: "personas", label: "我的人设", hint: "人设列表、详情、推文、设置", callback: "list_personas" },
  { id: "publishing", label: "发布与排程", hint: "立即发布、矩阵发布、定时、队列", callback: "publish_schedule_queue" },
  { id: "automation", label: "指纹浏览器自动化", hint: "Camoufox Profile 登录、检测、养号、回复", callback: "social_automation" },
  { id: "queue", label: "任务队列", hint: "待发布、失败、定时、取消、重试", callback: "queue_view" },
];

const taskMeta = {
  text_to_image: { title: "文生图", minImages: 0, files: "无需文件，填写 Prompt 后直接生成图片。", callback: "toolr18_task_r18_text_to_image_*" },
  image_generate: { title: "图片生成", minImages: 1, files: "单图参考上传 1 张图，双图参考上传 2 张图。", callback: "image_generate" },
  single_image_edit: { title: "单图编辑", minImages: 1, files: "上传 1 张原图，填写编辑指令。", callback: "single_image_edit" },
  get_nano_banana: { title: "图片编辑", minImages: 2, files: "上传 2 张图片：原图 + 参考图。", callback: "get_nano_banana" },
  face_swap: { title: "人物换脸", minImages: 2, files: "上传 2 张图片：目标图 + 人脸参考图。", callback: "face_swap" },
  video_i2v: { title: "图生视频", minImages: 1, files: "上传 1 张首帧参考图，可选音频。", callback: "video_i2v" },
  get_gemini: { title: "素材解析", minImages: 0, files: "发送图片/视频和需要解析的问题。", callback: "get_gemini" },
};

const personaGroups = {
  content: {
    label: "人设内容",
    actions: [
      ["pd", "查看人设详情"],
      ["posts", "查看推文"],
      ["history", "发布历史"],
      ["genpost_branch", "新建推文"],
      ["publish", "发布推文"],
    ],
  },
  settings: {
    label: "人设设置",
    actions: [
      ["editname", "改名称"],
      ["tweetstyle", "推文风格"],
      ["editcontent", "人设简介"],
      ["linksettings", "链接设置"],
      ["acctmgmt", "账号 Profile 管理"],
      ["hot_metrics", "人设热点数据"],
    ],
  },
  account: {
    label: "浏览器账号",
    actions: [
      ["acctplatform_threads", "Threads 登录检测"],
      ["persona_autoreply", "Threads 自动回复"],
      ["persona_warmup", "Threads 养号"],
    ],
  },
  data: {
    label: "数据面板",
    actions: [
      ["open_dashboard", "打开人设看板"],
      ["refresh", "刷新人设数据"],
      ["clear_tasks", "清理该人设自动化队列"],
    ],
  },
};

const moduleDefaultBranch = {
  publishing: "publish_post",
  automation: "open_login",
  queue: "pending",
};

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "include", ...options });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { detail: text }; }
  if (!response.ok) throw data;
  return data;
}

function showMsg(id, text, ok = true) {
  const node = $(id);
  if (!node) return;
  node.textContent = text || "";
  node.className = `notice ${ok ? "ok" : "bad"}`;
}

function numberText(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString() : "0";
}

function formatTime(value) {
  if (!value) return "-";
  const number = Number(value);
  const date = Number.isFinite(number) && number > 100000 ? new Date(number * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function fileKind(file) {
  const name = String(file?.name || "").toLowerCase();
  if (/\.(png|jpg|jpeg|webp|gif|bmp)$/.test(name)) return "image";
  if (/\.(mp4|mov|avi|mkv|webm)$/.test(name)) return "video";
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/.test(name)) return "audio";
  return "file";
}

function statusLabel(status) {
  const map = {
    queued: "排队中", running: "执行中", success: "成功", failed: "失败", cancelled: "已取消",
    need_manual: "需人工", pending_login: "待登录", ready: "可用",
    open_login: "打开登录", check_login: "检测登录", publish_post: "发布内容",
    threads_warmup: "Threads 养号", threads_auto_reply: "Threads 自动回复",
  };
  return map[String(status || "")] || String(status || "-");
}

function currentModule() {
  return modules.find((item) => item.id === state.activeModule) || modules[0];
}

function selectedPersona() {
  return state.personas.find((item) => String(item.id) === String(state.selectedPersonaId)) || state.personas[0] || null;
}

function setView(view) {
  state.view = view;
  if (view !== "workspace") state.workspaceMenuOpen = false;
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  document.querySelectorAll("[data-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === view));
  const titles = { workspace: "任务工作台", tasks: "任务队列", social: "浏览器发布", accounts: "账号 Profile", settings: "系统状态" };
  $("viewTitle").textContent = titles[view] || "控制台";
  updateWorkspaceFlow();
  if (view === "tasks") loadTasks();
  if (view === "social" || view === "accounts" || view === "settings") loadSocial();
}

function updateWorkspaceFlow() {
  const flow = $("workspaceFlow");
  const button = document.querySelector('[data-view="workspace"]');
  if (!flow || !button) return;
  const open = state.workspaceMenuOpen && state.view === "workspace";
  flow.classList.toggle("is-open", open);
  button.setAttribute("aria-expanded", open ? "true" : "false");
}

function renderModuleMenu() {
  updateWorkspaceFlow();
  $("moduleMenu").innerHTML = `<div class="module-accordion">${modules.map((item) => {
    const isActive = item.id === state.activeModule;
    return `
      <div class="module-accordion-item">
        <button type="button" class="module-trigger ${isActive ? "is-active" : ""}" data-module="${esc(item.id)}">
          <span class="module-trigger-text">
            <span>${esc(item.label)}</span>
            <small>${esc(item.hint)}</small>
          </span>
        </button>
      </div>
    `;
  }).join("")}</div>`;
}

function syncModuleMenuState() {
  updateWorkspaceFlow();
  document.querySelectorAll("[data-module]").forEach((button) => {
    const moduleId = button.dataset.module;
    const isActive = moduleId === state.activeModule;
    button.classList.toggle("is-active", isActive);
  });
}

function setMenuClickHighlight(button, leaveScope = button) {
  if (!button) return;
  document.querySelectorAll(".is-click-highlight").forEach((node) => {
    if (node !== button) node.classList.remove("is-click-highlight");
  });
  button.classList.add("is-click-highlight");
  const clear = () => {
    button.classList.remove("is-click-highlight");
    leaveScope.removeEventListener("mouseleave", clear);
  };
  leaveScope.addEventListener("mouseleave", clear, { once: true });
}

function setModule(moduleId) {
  state.activeModule = moduleId;
  renderWorkspace();
}

function selectedBranch(moduleId) {
  if (moduleId === "generation") return state.generationType;
  if (moduleId === "personas") return state.personaGroup;
  return state.simpleBranches[moduleId] || moduleDefaultBranch[moduleId] || "";
}

function renderWorkspace(renderMenu = true) {
  const module = currentModule();
  if (renderMenu) renderModuleMenu();
  else syncModuleMenuState();
  $("moduleTitle").textContent = module.label;
  $("moduleEyebrow").textContent = module.id === "personas" ? "Persona Flow" : "Web Flow";
  $("moduleCallback").textContent = module.callback;
  if (module.id === "generation") renderGenerationModule();
  else if (module.id === "personas") renderPersonaModule();
  else renderSimpleFlowModule(module.id);
  renderConfirmSummary();
}

function renderGenerationModule() {
  $("moduleBody").innerHTML = `
    <div class="module-toolbar">
      <strong>生成任务</strong>
      <span class="muted">任务类型和后续分支都在右侧下拉框选择。</span>
    </div>
    <div class="form-grid">
      <label>任务类型
        <select id="taskType">
          <option value="text_to_image">文生图</option>
          <option value="image_generate">图片生成</option>
          <option value="single_image_edit">单图编辑</option>
          <option value="get_nano_banana">图片编辑</option>
          <option value="face_swap">人物换脸</option>
          <option value="video_i2v">图生视频</option>
          <option value="get_gemini">素材解析</option>
        </select>
      </label>
      <label>完成后分支
        <select id="taskBranch">
          <option value="new">新建任务</option>
          <option value="toolr18_task_r18_text_to_image_reroll">重新生成图片</option>
          <option value="toolr18_task_r18_text_to_image_continue">继续生成图片</option>
          <option value="r18_image_edit_continue">继续编辑结果图</option>
          <option value="r18_rerun_latest">重跑最近任务</option>
        </select>
      </label>
      <label>提示词模式
        <select id="promptMode">
          <option value="grok">Grok 改写并预览</option>
          <option value="custom">输入自定义提示词</option>
          <option value="free">AI 自由发挥</option>
        </select>
      </label>
      <label data-generation-field="ratio">图像比例
        <select id="taskAspectRatio">
          <option value="auto">自动</option><option value="1:1">1:1</option><option value="3:4">3:4</option>
          <option value="4:3">4:3</option><option value="9:16">9:16</option><option value="16:9">16:9</option>
        </select>
      </label>
      <label data-generation-field="mode">参考模式
        <select id="taskMode">
          <option value="single_reference">单图参考</option>
          <option value="dual_reference">双图参考</option>
        </select>
      </label>
      <label data-generation-field="video">清晰度
        <select id="taskResolution"><option value="720p">720p</option><option value="1080p">1080p</option></select>
      </label>
      <label data-generation-field="video">时长
        <input id="taskDuration" type="number" min="2" max="15" value="2" />
      </label>
      <label data-generation-field="video">Seed
        <input id="taskSeed" type="number" min="0" placeholder="随机" />
      </label>
      <label data-generation-field="qa">文生图 QA
        <select id="taskQa"><option value="on">开启自动 QA</option><option value="off">关闭自动 QA</option></select>
      </label>
      <label data-generation-field="highres">最终分辨率
        <select id="taskFinalResolution"><option value="on">开启最终高清</option><option value="off">关闭最终高清</option></select>
      </label>
      <label data-generation-field="lora">人设 LoRA
        <select id="taskPersonaLora"><option value="off">不使用人设 LoRA</option><option value="auto">自动选择人设 LoRA</option></select>
      </label>
      <label data-generation-field="video">图生视频音频
        <select id="taskAudioMode"><option value="skip">跳过音频</option><option value="upload">上传音频</option><option value="keep">沿用已有音频</option></select>
      </label>
    </div>
    <label>Prompt / 指令</label>
    <textarea id="taskPrompt" rows="7" placeholder="填写任务指令，Web 会按当前类型提交到已有后台。"></textarea>
    <label data-generation-field="video">负面提示词</label>
    <input id="taskNegativePrompt" data-generation-field="video" placeholder="可选，用于图生视频或远程工作流" />
    <div class="upload-zone" id="uploadZone">
      <input id="taskFiles" type="file" multiple hidden />
      <div><strong>拖拽或点击上传素材</strong><p id="uploadHint"></p></div>
    </div>
    <div class="file-strip" id="fileStrip"></div>
    <div class="flow-box" id="generationBrief"></div>
    <div class="command-actions">
      <button id="submitTask" type="button" class="primary">确认执行</button>
      <button id="clearCommand" type="button">清空</button>
    </div>
  `;
  $("taskType").value = state.generationType;
  bindGenerationEvents();
  updateGenerationFields();
  renderFiles();
}

function bindGenerationEvents() {
  $("taskType").addEventListener("change", () => {
    state.generationType = $("taskType").value;
    updateGenerationFields();
    renderConfirmSummary();
  });
  ["taskBranch", "promptMode", "taskAspectRatio", "taskQa", "taskFinalResolution", "taskPersonaLora", "taskMode", "taskResolution", "taskDuration", "taskSeed"].forEach((id) => {
    const node = $(id);
    if (node) node.addEventListener("change", renderConfirmSummary);
  });
  $("taskPrompt").addEventListener("input", renderConfirmSummary);
  $("uploadZone").addEventListener("click", () => $("taskFiles").click());
  $("uploadZone").addEventListener("dragover", (event) => { event.preventDefault(); $("uploadZone").classList.add("dragging"); });
  $("uploadZone").addEventListener("dragleave", () => $("uploadZone").classList.remove("dragging"));
  $("uploadZone").addEventListener("drop", (event) => {
    event.preventDefault();
    $("uploadZone").classList.remove("dragging");
    addFiles(event.dataTransfer.files);
  });
  $("taskFiles").addEventListener("change", (event) => addFiles(event.target.files));
  $("fileStrip").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-file]");
    if (!button) return;
    state.files.splice(Number(button.dataset.removeFile), 1);
    renderFiles();
  });
  $("submitTask").addEventListener("click", () => submitGenerationTask().catch((error) => showMsg("commandMsg", error.detail || error.message || "提交失败", false)));
  $("clearCommand").addEventListener("click", () => {
    state.files = [];
    $("taskPrompt").value = "";
    $("taskNegativePrompt").value = "";
    renderFiles();
    renderConfirmSummary();
  });
}

function updateGenerationFields() {
  const type = $("taskType").value;
  const show = (selector, visible) => document.querySelectorAll(selector).forEach((node) => { node.style.display = visible ? "" : "none"; });
  show('[data-generation-field="mode"]', type === "image_generate");
  show('[data-generation-field="video"]', type === "video_i2v");
  show('[data-generation-field="ratio"]', ["text_to_image", "image_generate"].includes(type));
  show('[data-generation-field="qa"]', type === "text_to_image");
  show('[data-generation-field="highres"]', ["text_to_image", "image_generate"].includes(type));
  show('[data-generation-field="lora"]', ["text_to_image", "image_generate"].includes(type));
  const meta = taskMeta[type] || taskMeta.text_to_image;
  $("uploadHint").textContent = meta.files;
  $("generationBrief").innerHTML = `<span>Bot 回调</span><strong>${esc(meta.callback)}</strong><span>${esc(meta.files)}</span>`;
}

function renderPersonaModule() {
  if (!state.personas.length) {
    $("moduleBody").innerHTML = `
      <div class="module-toolbar">
        <strong>我的人设</strong>
        <button type="button" class="chip-button" data-persona-refresh>刷新人设列表</button>
      </div>
      <div class="empty-state">正在加载人设列表，或当前还没有人设。</div>
    `;
    return;
  }
  const current = selectedPersona();
  $("moduleBody").innerHTML = `
    <div class="module-toolbar">
      <div>
        <strong>我的人设 / 人设列表</strong>
        <div class="muted">选择某个人设后，只显示该人设自己的功能分组。</div>
      </div>
      <button type="button" class="chip-button" data-persona-refresh>刷新人设列表</button>
    </div>
    <div class="form-grid">
      <label>搜索人设
        <input id="personaSearch" type="search" placeholder="输入名称、设备、Threads 账号" />
      </label>
      <label>操作分组
        <select id="personaActionGroup">
          ${Object.entries(personaGroups).map(([key, group]) => `<option value="${esc(key)}">${esc(group.label)}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="persona-list" id="personaList"></div>
    <div class="persona-detail" id="personaDetail"></div>
  `;
  $("personaSearch").addEventListener("input", renderPersonaList);
  $("personaActionGroup").value = state.personaGroup;
  $("personaActionGroup").addEventListener("change", () => {
    state.personaGroup = $("personaActionGroup").value;
    renderModuleMenu();
    renderPersonaDetail();
    renderConfirmSummary();
  });
  renderPersonaList();
  if (current) renderPersonaDetail();
}

function renderPersonaList() {
  const query = String($("personaSearch")?.value || "").trim().toLowerCase();
  const personas = state.personas.filter((item) => {
    const haystack = [item.name, item.content, item.owner_bot_name, item.threads_account?.handle].join(" ").toLowerCase();
    return !query || haystack.includes(query);
  });
  $("personaList").innerHTML = personas.length ? personas.map((persona) => {
    const counts = persona.counts || {};
    const hot = persona.hot || {};
    return `
      <article class="persona-card ${String(persona.id) === String(state.selectedPersonaId) ? "is-active" : ""}" data-persona-id="${esc(persona.id)}">
        <div class="persona-card-head">
          <h4>${esc(persona.name || "未命名人设")}</h4>
          <span class="status ${persona.threads_account?.bound ? "ready" : ""}">${persona.threads_account?.handle ? esc(persona.threads_account.handle) : "未绑 Threads"}</span>
        </div>
        <p>${esc(String(persona.content || "暂无简介").slice(0, 120))}</p>
        <div class="persona-metrics">
          <div><span>帖子</span><strong>${numberText(counts.posts)}</strong></div>
          <div><span>已发布</span><strong>${numberText(counts.published)}</strong></div>
          <div><span>素材图</span><strong>${numberText(counts.images)}</strong></div>
          <div><span>热度</span><strong>${numberText(hot.hot_score)}</strong></div>
        </div>
      </article>
    `;
  }).join("") : `<div class="empty-state">没有匹配的人设。</div>`;
}

function renderPersonaDetail() {
  const persona = selectedPersona();
  if (!persona) {
    $("personaDetail").innerHTML = `<div class="empty-state">请先选择一个人设。</div>`;
    return;
  }
  const groupKey = $("personaActionGroup")?.value || state.personaGroup || "content";
  state.personaGroup = groupKey;
  const group = personaGroups[groupKey] || personaGroups.content;
  const warnings = Array.isArray(persona.warnings) ? persona.warnings : [];
  $("personaDetail").innerHTML = `
    <div>
      <div class="eyebrow">Selected Persona</div>
      <h3>${esc(persona.name || "未命名人设")}</h3>
      <p>浏览器 Profile：${esc((state.socialAccounts.find((item) => String(item.persona_id) === String(persona.id)) || {}).username || "未绑定")}</p>
    </div>
    <div class="flow-box">
      <span>Web 链路</span>
      <strong>我的人设 → ${esc(persona.name || persona.id)} → ${esc(group.label)}</strong>
    </div>
    ${warnings.length ? `<div class="flow-box"><span>待处理提示</span><strong>${warnings.map(esc).join(" / ")}</strong></div>` : ""}
    <div class="persona-actions-grid">
      ${group.actions.map(([action, label]) => `<button type="button" data-persona-action="${esc(action)}">${esc(label)}</button>`).join("")}
    </div>
  `;
}


function currentBranch(moduleId) {
  return selectedBranch(moduleId);
}

function selectedSocialAccount(accountId) {
  return state.socialAccounts.find((account) => String(account.id) === String(accountId || "")) || null;
}

function platformForAccount(accountId) {
  const account = selectedSocialAccount(accountId);
  return account?.platform || "threads";
}

function taskOptionsForPlatform(platform) {
  if (platform === "instagram") {
    return [
      ["open_login", "打开登录"],
      ["check_login", "检测登录"],
      ["browse_feed", "浏览 Feed"],
      ["browse_profile", "浏览主页"],
      ["publish_post", "发布内容"],
      ["comment_post", "评论帖子"],
      ["reply_comment", "回复评论"],
      ["like_post", "点赞帖子"],
      ["share_post", "分享帖子"],
    ];
  }
  return [
    ["open_login", "打开登录"],
    ["check_login", "检测登录"],
    ["browse_feed", "浏览 Feed"],
    ["threads_warmup", "Threads 养号"],
    ["threads_auto_reply", "Threads 自动回复"],
  ];
}

function optionTags(options, selectedValue) {
  return options.map(([value, label]) => `<option value="${esc(value)}" ${value === selectedValue ? "selected" : ""}>${esc(label)}</option>`).join("");
}

function personaOptionTags() {
  return state.personas.length
    ? state.personas.map((persona) => `<option value="${esc(persona.id)}" ${String(persona.id) === String(state.selectedPersonaId) ? "selected" : ""}>${esc(persona.name || persona.id)}</option>`).join("")
    : `<option value="">暂无人设</option>`;
}

function accountOptionTags() {
  return state.socialAccounts.length
    ? state.socialAccounts.map((account) => `<option value="${esc(account.id)}" data-platform="${esc(account.platform || "")}">${esc(account.username || account.id)} · ${esc(account.platform || "-")}</option>`).join("")
    : `<option value="">暂无 Profile</option>`;
}

function syncStandaloneSocialForm() {
  const account = selectedSocialAccount($("socialAccount")?.value);
  const platform = account?.platform || $("socialPlatform")?.value || "threads";
  if ($("socialPlatform")) $("socialPlatform").value = platform;
  const select = $("socialTaskType");
  if (!select) return;
  const options = taskOptionsForPlatform(platform);
  const current = select.value;
  const next = options.some(([value]) => value === current) ? current : options[0][0];
  select.innerHTML = optionTags(options, next);
}

function renderSimpleFlowModule(moduleId) {
  const branch = currentBranch(moduleId);
  const firstAccount = state.socialAccounts[0]?.id || "";
  const accountId = $("simpleAccount")?.value || firstAccount;
  const platform = platformForAccount(accountId);
  const taskOptions = taskOptionsForPlatform(platform);
  const selectedTask = taskOptions.some(([value]) => value === branch) ? branch : taskOptions[0][0];
  const commonAccount = `
    <div class="form-grid">
      <label>账号 Profile
        <select id="simpleAccount">${accountOptionTags()}</select>
      </label>
      <label>平台
        <input id="simplePlatform" value="${esc(platform)}" readonly />
      </label>
    </div>`;
  const commonQueue = `
    <label>定时执行
      <input id="simpleScheduleAt" placeholder="可选，例如 2026-07-03 21:30" />
    </label>
    <div class="form-grid">
      <label>优先级
        <input id="simplePriority" type="number" min="0" value="0" />
      </label>
      <label>最大重试
        <input id="simpleMaxRetries" type="number" min="0" value="2" />
      </label>
    </div>`;
  const contentBox = `
    <label>正文 / 评论 / 回复模板</label>
    <textarea id="simpleContent" rows="5" placeholder="按任务类型填写：发布正文、评论内容、回复模板。多条模板可一行一条。"></textarea>`;
  let body = "";
  if (moduleId === "publishing") {
    body = `
      <div class="module-toolbar">
        <strong>发布与排程</strong>
        <span class="muted">发布任务会提交到现有浏览器 Profile 自动化队列。</span>
      </div>
      <div class="form-grid">
        <label>发布方式
          <select id="simplePublishMode">
            <option value="publish_now">立即发布</option>
            <option value="matrix_start">矩阵发布</option>
            <option value="schedule_publish">定时发布</option>
          </select>
        </label>
        <label>任务类型
          <input id="simplePrimary" value="publish_post" readonly />
        </label>
        <label>人设
          <select id="simplePersona">${personaOptionTags()}</select>
        </label>
      </div>
      ${commonAccount}
      ${contentBox}
      <label>素材路径 media_paths
        <textarea id="simpleMediaPaths" rows="3" placeholder="publish_post 必填。一行一个本地素材路径，交给后端 runner 读取。"></textarea>
      </label>
      ${commonQueue}`;
  } else if (moduleId === "automation") {
    body = `
      <div class="module-toolbar">
        <strong>指纹浏览器自动化</strong>
        <span class="muted">所有任务都通过 Camoufox persistent Profile 执行，只显示 runner 支持的任务类型。</span>
      </div>
      ${commonAccount}
      <label>任务类型
        <select id="simplePrimary">${optionTags(taskOptions, selectedTask)}</select>
      </label>
      <div class="form-grid">
        <label>目标 URL / 用户名
          <input id="simpleTargetUrl" placeholder="browse_profile/comment/like/share/reply 时填写" />
        </label>
        <label>策略 strategy_id
          <input id="simpleStrategyId" placeholder="可选，例如 default" />
        </label>
      </div>
      <div class="form-grid">
        <label>浏览次数 / scroll_times
          <input id="simpleScrollTimes" type="number" min="1" value="5" />
        </label>
        <label>点赞上限 / like_limit
          <input id="simpleLikeLimit" type="number" min="0" value="3" />
        </label>
        <label>评论上限 / max_comments
          <input id="simpleMaxComments" type="number" min="0" value="1" />
        </label>
        <label>评论概率 / comment_chance
          <input id="simpleCommentChance" type="number" min="0" max="1" step="0.05" value="0.2" />
        </label>
        <label>最大帖子数 / max_posts
          <input id="simpleMaxPosts" type="number" min="1" value="3" />
        </label>
        <label>最大回复数 / max_replies
          <input id="simpleMaxReplies" type="number" min="1" value="3" />
        </label>
        <label>内容天数 / max_age_days
          <input id="simpleMaxAgeDays" type="number" min="1" value="7" />
        </label>
        <label>最低浏览量 / min_views
          <input id="simpleMinViews" type="number" min="0" value="0" />
        </label>
      </div>
      <label>回复范围 reply_scope
        <select id="simpleReplyScope">
          <option value="comments">评论区</option>
          <option value="hot_posts">热点帖子</option>
        </select>
      </label>
      ${contentBox}
      <label>目标 URL 列表 target_urls
        <textarea id="simpleTargetUrls" rows="3" placeholder="热点回复可填写，一行一个 URL。"></textarea>
      </label>
      ${commonQueue}`;
  } else {
    body = `
      <div class="module-toolbar">
        <strong>任务队列</strong>
        <span class="muted">队列筛选在 Web 端完成，取消和重试在任务行内执行。</span>
      </div>
      <div class="form-grid">
        <label>状态
          <select id="simplePrimary">
            <option value="pending">待执行</option>
            <option value="failed">失败</option>
            <option value="scheduled">定时</option>
          </select>
        </label>
        <label>平台
          <select id="simplePlatform">
            <option value="all">全部</option>
            <option value="threads">Threads</option>
            <option value="instagram">Instagram</option>
          </select>
        </label>
      </div>`;
  }
  $("moduleBody").innerHTML = `
    ${body}
    <div class="flow-box"><span>真实执行链路</span><strong>${esc(currentModule().callback)} · ${esc(branch)}</strong></div>
    <div id="commandMsg" class="notice"></div>
    <div class="command-actions"><button id="executeSimpleFlow" type="button" class="primary">确认执行</button></div>
  `;
  if ($("simpleAccount") && accountId) $("simpleAccount").value = accountId;
  if ($("simplePublishMode")) {
    const modes = ["publish_now", "matrix_start", "schedule_publish"];
    $("simplePublishMode").value = modes.includes(branch) ? branch : "publish_now";
  }
  bindSimpleFlowInputs(moduleId);
  $("executeSimpleFlow").addEventListener("click", () => executeSimpleFlow().catch((error) => showMsg("commandMsg", error.detail || error.message || "执行失败", false)));
}

function bindSimpleFlowInputs(moduleId) {
  ["simplePrimary", "simplePublishMode", "simpleAccount", "simplePersona", "simplePlatform", "simpleScheduleAt", "simpleContent", "simpleTargetUrl", "simpleMediaPaths", "simpleTargetUrls", "simplePriority", "simpleMaxRetries", "simpleScrollTimes", "simpleLikeLimit", "simpleMaxComments", "simpleCommentChance", "simpleMaxPosts", "simpleMaxReplies", "simpleMaxAgeDays", "simpleMinViews", "simpleReplyScope", "simpleStrategyId"].forEach((id) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener(node.tagName === "TEXTAREA" || node.tagName === "INPUT" ? "input" : "change", () => {
      if (id === "simplePrimary" || id === "simplePublishMode") state.simpleBranches[moduleId] = node.value;
      if (id === "simpleAccount" && moduleId === "automation") renderSimpleFlowModule(moduleId);
      renderConfirmSummary();
    });
  });
}

function fillSimpleAccounts() {
  const select = $("simpleAccount");
  if (!select) return;
  select.innerHTML = state.socialAccounts.length
    ? state.socialAccounts.map((account) => `<option value="${esc(account.id)}">${esc(account.username || account.id)} · ${esc(account.platform)}</option>`).join("")
    : `<option value="">暂无账号</option>`;
}


function renderConfirmSummary() {
  const module = currentModule();
  let rows = [["当前入口", module.label], ["执行链路", module.callback]];
  if (state.activeModule === "generation" && $("taskType")) {
    const meta = taskMeta[$("taskType").value] || taskMeta.text_to_image;
    rows = rows.concat([
      ["任务类型", meta.title],
      ["素材", state.files.length ? state.files.map((file) => file.name).join(" / ") : "未选择"],
      ["最终动作", "提交生成任务"],
    ]);
  } else if (state.activeModule === "personas") {
    const persona = selectedPersona();
    const groupKey = $("personaActionGroup")?.value || "content";
    rows = rows.concat([
      ["当前人设", persona ? persona.name : "未选择"],
      ["功能分组", personaGroups[groupKey]?.label || "-"],
      ["最终动作", "执行选中人设功能"],
    ]);
  } else if (state.activeModule === "publishing" || state.activeModule === "automation") {
    const account = selectedSocialAccount($("simpleAccount")?.value);
    rows = rows.concat([
      [state.activeModule === "publishing" ? "发布方式" : "任务类型", $("simplePublishMode")?.selectedOptions?.[0]?.textContent || $("simplePrimary")?.selectedOptions?.[0]?.textContent || selectedBranch(state.activeModule)],
      ["账号 Profile", account ? `${account.username || account.id} · ${account.platform}` : "未选择"],
      ["平台", account?.platform || $("simplePlatform")?.value || "-"],
      ["最终动作", "提交到 social_automation_tasks，由 Camoufox Profile 执行"],
    ]);
  } else {
    rows = rows.concat([
      ["队列筛选", $("simplePrimary")?.selectedOptions?.[0]?.textContent || "-"],
      ["最终动作", "打开任务队列并执行行级取消/重试"],
    ]);
  }
  $("confirmSummary").innerHTML = rows.map(([label, value]) => `
    <div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>
  `).join("");
}


function renderFiles() {
  const host = $("fileStrip");
  if (!host) return;
  if (!state.files.length) {
    host.innerHTML = `<span class="empty-line">未选择文件</span>`;
    return;
  }
  host.innerHTML = state.files.map((file, index) => `
    <div class="file-chip"><span>${esc(file.name)}</span><small>${esc(fileKind(file))}</small><button type="button" data-remove-file="${index}">移除</button></div>
  `).join("");
  renderConfirmSummary();
}

function addFiles(files) {
  const seen = new Set(state.files.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  Array.from(files || []).forEach((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!seen.has(key)) {
      state.files.push(file);
      seen.add(key);
    }
  });
  renderFiles();
}

function appendEvent(kind, message) {
  const host = $("eventStream");
  const row = document.createElement("div");
  row.className = `event-row ${kind || "info"}`;
  row.innerHTML = `<span>${esc(kind || "info")}</span><p>${esc(message || "")}</p>`;
  host.prepend(row);
}

function watchTask(taskId) {
  if (state.events) state.events.close();
  $("watchingTask").textContent = taskId;
  state.events = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`, { withCredentials: true });
  state.events.onmessage = (event) => {
    let payload = {};
    try { payload = JSON.parse(event.data || "{}"); } catch {}
    const kind = String(payload.kind || payload.status || "progress");
    appendEvent(kind, payload.message || payload.detail || kind);
    if (["success", "failed"].includes(kind)) {
      state.events.close();
      state.events = null;
      loadTasks();
    }
  };
  state.events.onerror = () => {
    appendEvent("warn", "事件流已断开，可在任务队列继续查看结果。");
    if (state.events) state.events.close();
    state.events = null;
  };
}

function buildTaskPayload() {
  const type = $("taskType").value;
  const prompt = $("taskPrompt").value.trim();
  const payload = {
    prompt,
    prompt_text: prompt,
    message: prompt,
    negative_prompt: $("taskNegativePrompt")?.value.trim() || "",
    tg_prompt_mode: $("promptMode").value,
    tg_web_branch: $("taskBranch").value,
    aspect_ratio: $("taskAspectRatio")?.value || "auto",
    text_to_image_auto_qa_enabled: $("taskQa")?.value !== "off",
    final_resolution_enabled: $("taskFinalResolution")?.value !== "off",
    persona_lora_mode: $("taskPersonaLora")?.value || "off",
  };
  if (type === "image_generate") payload.mode = $("taskMode").value;
  if (type === "video_i2v") {
    payload.resolution = $("taskResolution").value;
    payload.duration_seconds = Number($("taskDuration").value || 2);
    payload.audio_mode = $("taskAudioMode").value;
    const seed = $("taskSeed").value.trim();
    if (seed) payload.seed = Number(seed);
  }
  return payload;
}

async function submitGenerationTask() {
  const type = $("taskType").value;
  const prompt = $("taskPrompt").value.trim();
  if (!prompt && !["image_generate"].includes(type)) {
    showMsg("commandMsg", "请先填写任务指令。", false);
    return;
  }
  const imageCount = state.files.filter((file) => fileKind(file) === "image").length;
  const requiredImages = taskMeta[type]?.minImages || 0;
  if (imageCount < requiredImages) {
    showMsg("commandMsg", `该任务至少需要 ${requiredImages} 张图片。`, false);
    return;
  }
  const form = new FormData();
  form.append("task_type", type);
  form.append("params_json", JSON.stringify(buildTaskPayload()));
  state.files.forEach((file) => form.append("files", file, file.name));
  showMsg("commandMsg", "正在提交任务...", true);
  const result = await api("/api/tasks/submit", { method: "POST", body: form });
  appendEvent("queued", `任务已创建：${result.id}`);
  showMsg("commandMsg", `任务已提交：${result.id}`, true);
  watchTask(result.id);
  await loadTasks();
}

async function executePersonaAction(action) {
  const persona = selectedPersona();
  if (!persona) {
    showMsg("commandMsg", "请先选择一个人设。", false);
    return;
  }
  if (["open_dashboard", "pd", "posts", "history", "hot_metrics", "editname", "tweetstyle", "editcontent", "linksettings", "persona_image", "publish", "genpost_branch", "acctmgmt"].includes(action)) {
    location.href = "/persona-dashboard.html";
    return;
  }
  if (action === "refresh") {
    const result = await api("/api/persona_dashboard/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archive_id: persona.id }),
    });
    appendEvent("refresh", `已刷新人设：${result.task_id || persona.name}`);
    await loadPersonas();
    return;
  }
  if (action === "clear_tasks") {
    await api(`/api/persona_dashboard/automation/tasks?persona_id=${encodeURIComponent(persona.id)}`, { method: "DELETE" });
    appendEvent("clear", `已清理 ${persona.name} 的自动化队列`);
    await loadSocial();
    return;
  }
  const account = state.socialAccounts.find((item) => String(item.persona_id) === String(persona.id)) || state.socialAccounts[0];
  if (!account) {
    showMsg("commandMsg", "当前没有可用浏览器账号，请先在账号 Profile 里添加。", false);
    return;
  }
  const taskType = {
    acctlogin: "open_login",
    acctquery: "check_login",
    acctprofile: "publish_post",
    persona_autoreply: "threads_auto_reply",
    persona_warmup: "threads_warmup",
    acctplatform_threads: "check_login",
  }[action] || action;
  await createSocialTask(taskType, account.id, persona.id);
  appendEvent("persona", `${persona.name} 已提交：${taskType}`);
}


async function executeSimpleFlow() {
  if (state.activeModule === "queue") {
    setView("tasks");
    await loadTasks();
    await loadSocial();
    showMsg("commandMsg", "已打开任务队列。取消、重试和日志在对应任务行内执行。", true);
    return;
  }
  if (state.activeModule === "publishing" || state.activeModule === "automation") {
    const accountId = $("simpleAccount")?.value || "";
    if (!accountId) {
      showMsg("commandMsg", "请先选择账号 Profile。", false);
      return;
    }
    const taskType = $("simplePrimary")?.value || selectedBranch(state.activeModule);
    const personaId = $("simplePersona")?.value || selectedPersona()?.id || "";
    await createSocialTask(taskType, accountId, personaId, "commandMsg");
    appendEvent("browser", `${taskType} 已提交到指纹浏览器任务队列`);
    return;
  }
  setView("workspace");
}

async function loadMe() {
  try {
    const me = await api("/api/me");
    $("consoleMeName").textContent = me.username || "-";
    if (me.is_admin) $("openAdmin").hidden = false;
  } catch (error) {
    $("consoleMeName").textContent = "本地控制台";
    $("openAdmin").hidden = true;
    appendEvent("error", error.detail || error.message || "本地控制台会话不可用");
  }
}

async function loadPersonas() {
  const data = await api("/api/persona_dashboard/overview").catch(() => ({ personas: [] }));
  state.personas = Array.isArray(data.personas) ? data.personas : [];
  if (!state.selectedPersonaId && state.personas[0]) state.selectedPersonaId = state.personas[0].id;
  if (!state.personas.some((item) => String(item.id) === String(state.selectedPersonaId)) && state.personas[0]) {
    state.selectedPersonaId = state.personas[0].id;
  }
  if (state.activeModule === "personas") renderPersonaModule();
}

async function loadTasks() {
  const data = await api("/api/tasks");
  state.tasks = Array.isArray(data.items) ? data.items : (Array.isArray(data.tasks) ? data.tasks : []);
  const host = $("taskTable");
  if (!state.tasks.length) {
    host.innerHTML = `<div class="empty-state">还没有任务。</div>`;
    return;
  }
  host.innerHTML = state.tasks.map((task) => `
    <article class="task-row">
      <div><strong>${esc(task.workflow_name || task.type || "任务")}</strong><span>${esc(task.id)}</span></div>
      <div><span class="status ${esc(task.status)}">${esc(statusLabel(task.status))}</span></div>
      <div>${esc(formatTime(task.created_at))}</div>
      <div class="row-actions">
        <button type="button" data-watch="${esc(task.id)}">监听</button>
        <button type="button" data-detail="${esc(task.id)}">详情</button>
        ${task.has_download ? `<a href="/api/tasks/${encodeURIComponent(task.id)}/download">下载</a>` : ""}
        ${task.status === "failed" ? `<button type="button" data-retry="${esc(task.id)}">重试</button>` : ""}
      </div>
    </article>
  `).join("");
}

async function showTaskDetail(id) {
  const task = await api(`/api/tasks/${encodeURIComponent(id)}`);
  appendEvent("detail", `${task.type || "任务"} / ${task.status || "-"} / ${task.error || "无错误"}`);
  setView("workspace");
}

async function loadSocialOverview() {
  const overview = await api("/api/persona_dashboard/automation/overview");
  const worker = overview.worker || overview.worker_state || {};
  $("workerState").textContent = worker.running ? "运行中" : (worker.enabled === false ? "已关闭" : "待命");
  $("workerDetail").textContent = worker.last_error || `最近任务：${worker.last_task_id || "-"}`;
  return overview;
}

async function loadSocial() {
  const [overview, accountsData, tasksData] = await Promise.all([
    loadSocialOverview().catch(() => ({})),
    api("/api/persona_dashboard/automation/accounts").catch(() => ({ accounts: [] })),
    api("/api/persona_dashboard/automation/tasks?limit=80").catch(() => ({ tasks: [] })),
  ]);
  state.socialAccounts = accountsData.accounts || [];
  state.socialTasks = tasksData.tasks || [];
  renderSocialAccounts();
  renderSocialTasks();
  syncStandaloneSocialForm();
  if (state.activeModule && ["publishing", "automation"].includes(state.activeModule)) renderSimpleFlowModule(state.activeModule);
  return overview;
}

function renderSocialAccounts() {
  const select = $("socialAccount");
  if (select) {
    select.innerHTML = state.socialAccounts.length
      ? state.socialAccounts.map((account) => `<option value="${esc(account.id)}" data-platform="${esc(account.platform)}">${esc(account.username || account.id)} · ${esc(account.platform)}</option>`).join("")
      : `<option value="">暂无账号</option>`;
    syncStandaloneSocialForm();
  }
  const grid = $("accountGrid");
  if (!grid) return;
  grid.innerHTML = state.socialAccounts.length ? state.socialAccounts.map((account) => `
    <article class="account-card">
      <div><strong>${esc(account.username || account.id)}</strong><span>${esc(account.platform || "-")}</span></div>
      <p>${esc(account.profile_dir || "未配置 Profile")}</p>
      <div class="row-actions">
        <button type="button" data-social-open-login="${esc(account.id)}">打开登录</button>
        <button type="button" data-social-check-login="${esc(account.id)}">检测登录</button>
      </div>
      <span class="status ${esc(account.status)}">${esc(statusLabel(account.status))}</span>
    </article>
  `).join("") : `<div class="empty-state">暂无浏览器账号，请先在人设看板或接口中添加账号 Profile。</div>`;
}

function renderSocialTasks() {
  const host = $("socialTaskList");
  if (!host) return;
  host.innerHTML = state.socialTasks.length ? state.socialTasks.map((task) => `
    <article class="social-task">
      <div><strong>${esc(statusLabel(task.task_type))}</strong><span>${esc(task.platform)} · ${esc(task.account_username || task.account_id || "")}</span></div>
      <span class="status ${esc(task.status)}">${esc(statusLabel(task.status))}</span>
      <div class="row-actions">
        <button type="button" data-social-log="${esc(task.id)}">日志</button>
        ${task.status === "failed" ? `<button type="button" data-social-retry="${esc(task.id)}">重试</button>` : ""}
        ${["queued", "running", "need_manual"].includes(String(task.status)) ? `<button type="button" data-social-cancel="${esc(task.id)}">取消</button>` : ""}
      </div>
    </article>
  `).join("") : `<div class="empty-state">暂无浏览器自动化任务。</div>`;
}


function numberField(id, fallback = undefined) {
  const node = $(id);
  if (!node || node.value === "") return fallback;
  const value = Number(node.value);
  return Number.isFinite(value) ? value : fallback;
}

function splitLines(value) {
  return String(value || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function compactPayload(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && value !== "";
  }));
}

function validateTaskForPlatform(taskType, platform) {
  const allowed = taskOptionsForPlatform(platform).map(([value]) => value);
  return allowed.includes(taskType);
}

async function createSocialTask(taskType = $("socialTaskType")?.value, accountId = $("socialAccount")?.value || $("simpleAccount")?.value, personaId = "", messageId = "socialMsg") {
  if (!accountId) {
    showMsg(messageId, "请先选择账号 Profile。", false);
    return;
  }
  const selected = selectedSocialAccount(accountId);
  const platform = selected?.platform || $("socialPlatform")?.value || $("simplePlatform")?.value || "threads";
  if (!validateTaskForPlatform(taskType, platform)) {
    showMsg(messageId, `${platform} 当前不支持 ${taskType}，请切换到可执行任务类型。`, false);
    return;
  }
  const content = $("socialContent")?.value.trim() || $("simpleContent")?.value.trim() || "";
  const targetUrl = $("socialTargetUrl")?.value.trim() || $("simpleTargetUrl")?.value.trim() || "";
  const mediaPaths = splitLines($("simpleMediaPaths")?.value || $("socialMediaPaths")?.value || "");
  if (taskType === "publish_post" && mediaPaths.length === 0) {
    showMsg(messageId, "publish_post 必须填写 media_paths，一行一个素材路径。", false);
    return;
  }
  if (["comment_post", "reply_comment", "like_post", "share_post", "browse_profile"].includes(taskType) && !targetUrl) {
    showMsg(messageId, `${taskType} 必须填写目标 URL 或用户名。`, false);
    return;
  }
  const payload = compactPayload({
    content,
    caption: content,
    comment: content,
    text: content,
    reply: content,
    reply_text: content,
    target_url: targetUrl,
    post_url: targetUrl,
    username: taskType === "browse_profile" ? targetUrl : "",
    media_paths: mediaPaths,
    target_urls: splitLines($("simpleTargetUrls")?.value || $("socialTargetUrls")?.value || ""),
    login_wait_seconds: numberField("simpleLoginWaitSeconds", 180),
    scroll_times: numberField("simpleScrollTimes", numberField("socialLimit", 5)),
    browse_limit: numberField("simpleScrollTimes", undefined),
    like_limit: numberField("simpleLikeLimit", undefined),
    max_comments: numberField("simpleMaxComments", undefined),
    comment_chance: numberField("simpleCommentChance", undefined),
    max_posts: numberField("simpleMaxPosts", numberField("socialLimit", 3)),
    max_replies: numberField("simpleMaxReplies", numberField("socialMaxReplies", numberField("socialLimit", 3))),
    max_age_days: numberField("simpleMaxAgeDays", numberField("socialMaxAgeDays", undefined)),
    min_views: numberField("simpleMinViews", numberField("socialMinViews", undefined)),
    reply_scope: $("simpleReplyScope")?.value || "",
    strategy_id: $("simpleStrategyId")?.value.trim() || "",
    reply_templates: splitLines(content),
  });
  const scheduledAt = $("simpleScheduleAt")?.value.trim() || "";
  const result = await api("/api/persona_dashboard/automation/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account_id: accountId,
      persona_id: personaId || selected?.persona_id || "",
      platform,
      task_type: taskType,
      scheduled_at: scheduledAt || undefined,
      priority: numberField("simplePriority", 0),
      max_retries: numberField("simpleMaxRetries", 2),
      payload,
    }),
  });
  showMsg(messageId, `浏览器任务已提交：${result.task?.id || ""}`, true);
  await loadSocial();
  return result;
}

async function showSocialLog(id) {
  const data = await api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(id)}/logs`);
  setView("workspace");
  (data.logs || []).slice(-12).reverse().forEach((log) => appendEvent(log.stage || log.level, log.message || JSON.stringify(log.data || {})));
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    setMenuClickHighlight(button, button);
    const nextView = button.dataset.view;
    if (nextView === "workspace" && state.view === "workspace") {
      state.workspaceMenuOpen = !state.workspaceMenuOpen;
      updateWorkspaceFlow();
      return;
    }
    if (nextView === "workspace") state.workspaceMenuOpen = true;
    setView(nextView);
  }));
  $("moduleMenu").addEventListener("click", (event) => {
    const button = event.target.closest("[data-module]");
    if (button) {
      setMenuClickHighlight(button, button.closest(".module-accordion-item") || button);
      setModule(button.dataset.module);
    }
  });
  $("moduleBody").addEventListener("click", (event) => {
    const personaCard = event.target.closest("[data-persona-id]");
    if (personaCard) {
      state.selectedPersonaId = personaCard.dataset.personaId;
      renderPersonaList();
      renderPersonaDetail();
      renderConfirmSummary();
      return;
    }
    const personaAction = event.target.closest("[data-persona-action]");
    if (personaAction) executePersonaAction(personaAction.dataset.personaAction).catch((error) => showMsg("commandMsg", error.detail || error.message || "执行失败", false));
    if (event.target.closest("[data-persona-refresh]")) loadPersonas();
  });
  $("refreshAll").addEventListener("click", () => Promise.all([loadTasks(), loadPersonas(), loadSocial().catch(() => {})]));
  $("refreshTasks").addEventListener("click", loadTasks);
  $("taskTable").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const id = button.dataset.watch || button.dataset.detail || button.dataset.retry;
    if (button.dataset.watch) watchTask(id);
    if (button.dataset.detail) showTaskDetail(id).catch((error) => appendEvent("error", error.detail || error.message));
    if (button.dataset.retry) api(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" }).then(loadTasks);
  });
  $("submitSocialTask").addEventListener("click", () => createSocialTask().catch((error) => showMsg("socialMsg", error.detail || error.message || "提交失败", false)));
  $("socialAccount").addEventListener("change", syncStandaloneSocialForm);
  $("socialPlatform").addEventListener("change", syncStandaloneSocialForm);
  $("runSocialOnce").addEventListener("click", () => api("/api/persona_dashboard/automation/worker/run_once", { method: "POST" }).then(loadSocial).catch((error) => showMsg("socialMsg", error.detail || error.message || "执行失败", false)));
  $("refreshSocialTasks").addEventListener("click", loadSocial);
  $("refreshAccounts").addEventListener("click", loadSocial);
  $("accountGrid").addEventListener("click", (event) => {
    const open = event.target.closest("[data-social-open-login]");
    const check = event.target.closest("[data-social-check-login]");
    if (open) createSocialTask("open_login", open.dataset.socialOpenLogin);
    if (check) createSocialTask("check_login", check.dataset.socialCheckLogin);
  });
  $("socialTaskList").addEventListener("click", (event) => {
    const log = event.target.closest("[data-social-log]");
    const retry = event.target.closest("[data-social-retry]");
    const cancel = event.target.closest("[data-social-cancel]");
    if (log) showSocialLog(log.dataset.socialLog);
    if (retry) api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(retry.dataset.socialRetry)}/retry`, { method: "POST" }).then(loadSocial);
    if (cancel) api(`/api/persona_dashboard/automation/tasks/${encodeURIComponent(cancel.dataset.socialCancel)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "user_cancel" }) }).then(loadSocial);
  });
  $("openAdmin").addEventListener("click", () => { location.href = "/admin.html"; });
  $("consoleLogout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/console.html";
  });
}

async function init() {
  bindEvents();
  renderWorkspace();
  appendEvent("ready", "Web 控制台已就绪。");
  await loadMe();
  await Promise.all([loadPersonas(), loadTasks(), loadSocial().catch(() => {})]);
  renderWorkspace();
}

init().catch((error) => {
  appendEvent("error", error.detail || error.message || "控制台初始化失败");
});
