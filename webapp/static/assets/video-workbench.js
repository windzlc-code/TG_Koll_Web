(function videoWorkbenchBootstrap() {
  "use strict";

  const MODULE_ORDER = [
    "digital_human_video",
    "ecommerce_short_video",
    "video_language_replace",
    "video_subject_replace",
    "ecommerce_image",
    "subject_replace",
    "poster_translate",
    "subject_generate",
  ];
  const ACTIVE_STATUSES = new Set(["queued", "pending", "running", "processing", "submitted"]);
  const BACKEND_TASK_TYPES = {
    digital_human_video: "create_video",
    ecommerce_short_video: "ecommerce_short_video",
    video_language_replace: "video_language_replace",
    video_subject_replace: "replace_model",
    ecommerce_image: "image_generate",
    subject_replace: "replace_product",
    poster_translate: "image_generate",
    subject_generate: "image_generate",
  };
  const REFRESH_INTERVAL_MS = 5000;
  const VOICE_PRESETS_ENDPOINT = "/api/video/voice-presets";
  const VOICE_PRESETS_MANIFEST_URL = "/assets/voice_presets_manifest.json";
  const VOICE_MODULES = new Set(["digital_human_video", "ecommerce_short_video", "video_language_replace"]);
  const TIMELINE_MODULES = new Set(["digital_human_video", "ecommerce_short_video", "video_language_replace"]);
  const PILL_SELECT_KEYS = new Set(["content_mode", "subject_kind", "mode", "duration_mode"]);
  const ADMIN_WORKSPACE_USER_ID = String(document.querySelector('meta[name="admin-workspace-user-id"]')?.content || "").trim();
  const ADMIN_CONSOLE_SESSION = document.querySelector('meta[name="admin-console-session"]')?.content === "1";

  const LANGUAGE_OPTIONS = ["Auto", "Chinese", "English", "Japanese", "Korean", "French", "German", "Spanish", "Portuguese", "Russian", "Italian"];
  const SPEAKER_OPTIONS = ["Aiden", "Dylan", "Eric", "Ono_anna", "Ryan", "Serena", "Sohee", "Uncle_fu", "Vivian", "zhenzhen"];
  const SUBTITLE_TEMPLATE_OPTIONS = [
    { value: "keyword_focus", label: "关键词强调" },
    { value: "bilingual_dual", label: "双语双行" },
    { value: "handwritten_quote", label: "手写引语" },
    { value: "split_hook", label: "分屏钩子" },
  ];

  const text = (key, label, extra = {}) => ({ key, label, type: "text", ...extra });
  const textarea = (key, label, extra = {}) => ({ key, label, type: "textarea", ...extra });
  const number = (key, label, extra = {}) => ({ key, label, type: "number", ...extra });
  const select = (key, label, options, extra = {}) => ({
    key,
    label,
    type: "select",
    options: options.map((option) => (
      option && typeof option === "object"
        ? { value: String(option.value ?? option.label ?? ""), label: String(option.label ?? option.value ?? "") }
        : { value: String(option), label: String(option) }
    )),
    ...extra,
  });
  const checkbox = (key, label, extra = {}) => ({ key, label, type: "checkbox", ...extra });
  const file = (key, label, accept, extra = {}) => ({ key, label, type: "file", accept, upload_name: "files", ...extra });

  const FALLBACK_MODULES = {
    digital_human_video: {
      id: "digital_human_video",
      label: "数字人口播视频",
      shortLabel: "数字人",
      kicker: "DIGITAL HUMAN",
      description: "用人物素材与口播内容生成可直接交付的数字人视频。",
      fields: [
        file("model_image", "人物参考图", "image/*", { required: true, help: "建议使用正面、主体清晰的竖版人物图。" }),
        file("audio_file", "口播音频", "audio/*", { help: "可选；未上传时将根据口播文案生成音频。" }),
        file("camera_video", "运镜视频", "video/*", { help: "可选；用于控制镜头与动作节奏。" }),
        textarea("speech_text", "口播文案", { placeholder: "输入数字人的口播内容", required: true, wide: true }),
        textarea("prompt_text", "视频提示词", { placeholder: "补充动作、场景与镜头要求", wide: true }),
        select("language", "语言", LANGUAGE_OPTIONS, { default: "Chinese" }),
        select("speaker", "音色", SPEAKER_OPTIONS, { default: "Ryan" }),
        text("emotion", "情绪", { default: "happy", placeholder: "例如：happy" }),
        select("model_choice", "TTS 模型", ["0.6B", "1.7B"], { default: "1.7B" }),
        select("duration_mode", "时长模式", [{ value: "manual", label: "手动" }, { value: "audio", label: "跟随音频" }], { default: "manual" }),
        number("duration_seconds", "视频时长（秒）", { default: 15, min: 1, max: 300 }),
        checkbox("subtitles_enabled", "生成并烧录字幕", { default: true, wide: true }),
        select("subtitle_template", "字幕样式", SUBTITLE_TEMPLATE_OPTIONS, { default: "keyword_focus" }),
        checkbox("use_ai_copy", "使用 AI 生成口播 / 提示词", { default: true, wide: true }),
      ],
    },
    ecommerce_short_video: {
      id: "ecommerce_short_video",
      label: "广告 / 种草视频",
      shortLabel: "短视频",
      kicker: "COMMERCE VIDEO",
      description: "组合模特、商品与文案，生成适合投放和社媒发布的带货短视频。",
      fields: [
        select("content_mode", "内容模式", [{ value: "planting", label: "种草模式" }, { value: "advertising", label: "广告模式" }], { default: "planting" }),
        file("model_image", "模特图", "image/*", { required: true, help: "真人或模特展示图，建议竖图、主体清晰。" }),
        file("product_image", "商品图", "image/*", { required: true, help: "白底图、场景图或商品实拍均可。" }),
        file("camera_video", "运镜视频", "video/*"),
        file("audio_file", "口播音频", "audio/*"),
        text("product_name", "商品名称", { default: "商品", required: true, placeholder: "例如：夏季防晒衣" }),
        text("style_hint", "画面风格", { default: "自然口播，真实电商场景", placeholder: "例如：自然口播，真实电商场景" }),
        textarea("speech_text", "口播文案", { placeholder: "可留空，由 AI 生成", wide: true }),
        textarea("prompt_text", "视频提示词", { placeholder: "描述动作、镜头与氛围", wide: true }),
        textarea("nano_prompt", "场景图提示词", { placeholder: "用于控制电商场景图", wide: true }),
        select("language", "语言", LANGUAGE_OPTIONS, { default: "Chinese" }),
        select("speaker", "音色", SPEAKER_OPTIONS, { default: "Ryan" }),
        text("emotion", "情绪", { default: "happy" }),
        select("duration_mode", "时长模式", [{ value: "manual", label: "手动" }, { value: "audio", label: "跟随音频" }], { default: "manual" }),
        number("duration_seconds", "视频时长（秒）", { default: 15, min: 1, max: 300 }),
        checkbox("subtitles_enabled", "生成并烧录字幕", { default: true, wide: true }),
        select("subtitle_template", "字幕样式", SUBTITLE_TEMPLATE_OPTIONS, { default: "keyword_focus" }),
        checkbox("use_ai_copy", "使用 AI 生成口播 / 提示词", { default: true, wide: true }),
      ],
    },
    video_language_replace: {
      id: "video_language_replace",
      label: "视频语种更换",
      shortLabel: "语言替换",
      kicker: "VIDEO LOCALIZATION",
      description: "保留原视频节奏与画面，将口播替换为目标语言。",
      fields: [
        file("video_file", "原视频", "video/*", { required: true }),
        file("audio_file", "替换音频", "audio/*", { help: "可选；未上传时使用翻译文本合成。" }),
        select("source_language", "原始语言", LANGUAGE_OPTIONS, { default: "Auto" }),
        select("target_language", "目标语言", LANGUAGE_OPTIONS.filter((item) => item !== "Auto"), { default: "English", required: true }),
        select("speaker", "音色", SPEAKER_OPTIONS, { default: "Ryan" }),
        textarea("target_script", "目标语言脚本", {
          placeholder: "可选：粘贴 SRT、带时间码台词或纯文本；留空时自动识别并翻译原视频语音",
          help: "留空时使用已配置的文字/多模态模型自动转写并翻译；也可填写目标语言脚本或直接上传替换音频。",
          wide: true,
        }),
        checkbox("preserve_background_audio", "保留背景音乐与环境声", { default: true, wide: true }),
        checkbox("subtitles_enabled", "生成并烧录字幕", { default: true, wide: true }),
        select("subtitle_template", "字幕样式", SUBTITLE_TEMPLATE_OPTIONS, { default: "bilingual_dual" }),
      ],
    },
    video_subject_replace: {
      id: "video_subject_replace",
      label: "视频模特 / 商品替换",
      shortLabel: "视频换主体",
      kicker: "VIDEO SUBJECT",
      description: "保留原视频动作和镜头，替换人物或商品主体。",
      fields: [
        file("video_file", "原视频", "video/*", { required: true }),
        file("subject_image", "新主体图片", "image/*", { required: true }),
        select("subject_kind", "替换主体", [
          { value: "model", label: "人物 / 模特" },
          { value: "product", label: "商品" },
        ], { default: "model", required: true, help: "选择后会分别提交为视频模特替换或视频商品替换任务。" }),
        select("mode", "替换模式", [
          { value: "original", label: "基础模式" },
          { value: "primary", label: "快速模式" },
          { value: "slice", label: "片段替换" },
          { value: "motion_transfer", label: "动作迁移" },
        ], { default: "original" }),
        textarea("prompt", "动作 / 场景提示词", { placeholder: "描述替换后的动作与场景", wide: true }),
        number("start_seconds", "起始秒数", { default: 0, min: 0 }),
        number("duration_seconds", "时长（秒）", { default: 10, min: 1, max: 300 }),
        number("width", "输出宽度", { default: 576, min: 1 }),
        number("height", "输出高度", { default: 1024, min: 1 }),
        number("frame", "帧率", { default: 30, min: 1, max: 120 }),
      ],
    },
    ecommerce_image: {
      id: "ecommerce_image",
      label: "电商广告图",
      shortLabel: "电商图片",
      kicker: "COMMERCE IMAGE",
      description: "从商品或模特参考图生成干净、统一的电商展示图。",
      fields: [
        select("mode", "图片模式", [{ value: "product_only", label: "仅商品图" }, { value: "model_product", label: "模特图 + 商品图" }], { default: "product_only" }),
        file("product_image", "商品图", "image/*", { required: true }),
        file("model_image", "模特图", "image/*", { help: "“模特图 + 商品图”模式需要上传。" }),
        text("product_name", "商品名称", { default: "商品", placeholder: "例如：轻薄防晒衣" }),
        text("style_hint", "画面风格", { placeholder: "例如：极简棚拍、柔和补光" }),
        textarea("prompt", "图片提示词", { default: "生成电商商品展示图，画面干净自然，无文字。", required: true, wide: true }),
      ],
    },
    subject_replace: {
      id: "subject_replace",
      label: "人物 / 商品替换",
      shortLabel: "图片换主体",
      kicker: "IMAGE SUBJECT",
      description: "替换图片中的人物或商品，同时保留原构图与光影关系。",
      fields: [
        file("source_image", "原图片", "image/*", { required: true }),
        file("subject_image", "新主体图片", "image/*", { required: true }),
        textarea("prompt", "替换要求", { placeholder: "描述需要保留和改变的内容", wide: true }),
        number("width", "输出宽度", { default: 1024, min: 1 }),
        number("height", "输出高度", { default: 1024, min: 1 }),
      ],
    },
    poster_translate: {
      id: "poster_translate",
      label: "电商图语种切换",
      shortLabel: "海报翻译",
      kicker: "POSTER TRANSLATE",
      description: "识别海报文字并翻译，尽量保持原版式、字体层级与视觉节奏。",
      fields: [
        file("poster_image", "海报图片", "image/*", { required: true }),
        select("source_language", "原始语言", LANGUAGE_OPTIONS, { default: "Auto" }),
        select("target_language", "目标语言", LANGUAGE_OPTIONS.filter((item) => item !== "Auto"), { default: "Chinese", required: true }),
        textarea("translation_notes", "翻译说明", { placeholder: "品牌名、专有名词或语气要求", wide: true }),
        checkbox("preserve_layout", "保持原海报版式", { default: true, wide: true }),
      ],
    },
    subject_generate: {
      id: "subject_generate",
      label: "主体生成",
      shortLabel: "主体生成",
      kicker: "SUBJECT GENERATE",
      description: "根据参考图与描述生成可用于后续图片或视频制作的新主体。",
      fields: [
        file("reference_image", "参考图", "image/*", { help: "可选；上传后用于保持主体特征。" }),
        select("mode", "生成模式", [
          { value: "digital_human_character", label: "数字人角色" },
          { value: "three_view", label: "角色三视图" },
        ], { default: "digital_human_character", required: true, help: "三视图模式会生成便于后续角色建模与一致性制作的多视角参考。" }),
        textarea("prompt", "主体描述", { placeholder: "描述外观、材质、姿态与使用场景", required: true, wide: true }),
        textarea("negative_prompt", "排除内容", { placeholder: "不希望出现在画面中的元素", wide: true }),
        number("width", "输出宽度", { default: 1024, min: 1 }),
        number("height", "输出高度", { default: 1024, min: 1 }),
        number("count", "生成数量", { default: 1, min: 1, max: 8 }),
      ],
    },
  };

  const state = {
    active: false,
    initialized: false,
    moduleId: MODULE_ORDER[0],
    modules: MODULE_ORDER.map((id) => FALLBACK_MODULES[id]),
    moduleLoading: false,
    moduleError: "",
    moduleEmpty: false,
    tasks: [],
    taskLoading: false,
    taskError: "",
    taskWarning: "",
    taskMedia: {},
    taskMediaResolved: {},
    taskMediaLoading: {},
    submitError: "",
    submitting: false,
    drafts: {},
    files: {},
    voicePresets: [],
    voiceLoading: false,
    voiceLoaded: false,
    voiceError: "",
    voiceFilter: "",
    playingVoiceId: "",
    advancedBusy: "",
    timer: 0,
    requestToken: 0,
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character]));
  }

  function humanize(value) {
    return String(value || "").replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function arrayFromPayload(payload, keys) {
    if (Array.isArray(payload)) return payload;
    for (const key of keys) {
      if (Array.isArray(payload?.[key])) return payload[key];
    }
    return [];
  }

  function moduleRowsFromPayload(payload) {
    const direct = arrayFromPayload(payload, ["modules", "items", "data"]);
    if (direct.length) return direct;
    for (const candidate of [payload?.modules, payload?.items, payload?.data, payload]) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const rows = Object.entries(candidate)
        .filter(([, value]) => value && typeof value === "object" && !Array.isArray(value))
        .map(([key, value]) => ({ ...value, id: value.id || value.key || key }));
      if (rows.length) return rows;
    }
    return [];
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (ADMIN_WORKSPACE_USER_ID) headers.set("X-Admin-Workspace-User-ID", ADMIN_WORKSPACE_USER_ID);
    if (ADMIN_CONSOLE_SESSION) headers.set("X-Admin-Console", "1");
    const response = await fetch(path, { credentials: "include", ...options, headers });
    const raw = await response.text();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { detail: raw };
    }
    if (!response.ok) {
      const detail = payload?.detail?.message || payload?.detail || payload?.message || `请求失败（${response.status}）`;
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return payload;
  }

  async function confirmPromptPreview(module, values) {
    const body = new FormData();
    body.append("module", module.id);
    body.append("params_json", JSON.stringify(values));
    const preview = await request("/api/video/prompt-preview", { method: "POST", body });
    const lines = [preview.speech_text, preview.prompt_text].filter(Boolean);
    const summary = lines.length ? lines.join("\n\n") : "将按当前参数创建生成任务。";
    return window.confirm(`请确认生成内容：\n\n${summary}`);
  }

  async function taskAction(taskId, action) {
    if (!taskId) return;
    if (action === "cancel") {
      await request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
    } else {
      try {
        await request(`/api/video/tasks/${encodeURIComponent(taskId)}/resume`, { method: "POST" });
      } catch (resumeError) {
        await request(`/api/tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST" });
      }
    }
    await loadTasks({ quiet: true });
  }

  function normalizeOptions(options) {
    if (!Array.isArray(options)) return [];
    return options.map((option) => {
      if (option && typeof option === "object") {
        const value = option.value ?? option.id ?? option.key ?? option.label ?? "";
        return { value: String(value), label: String(option.label ?? option.name ?? value) };
      }
      return { value: String(option), label: String(option) };
    });
  }

  function normalizeField(rawField, fallbackKey = "") {
    const raw = rawField && typeof rawField === "object" ? rawField : {};
    const key = String(raw.key || raw.name || raw.id || fallbackKey).trim();
    if (!key) return null;
    let type = String(raw.type || raw.input_type || raw.kind || "text").trim().toLowerCase();
    if (["image", "video", "audio", "upload", "file_upload"].includes(type)) type = "file";
    if (["bool", "boolean", "switch"].includes(type)) type = "checkbox";
    if (["integer", "float", "range"].includes(type)) type = "number";
    if (["multiline", "long_text"].includes(type)) type = "textarea";
    if (!["text", "textarea", "number", "select", "checkbox", "file", "url"].includes(type)) type = "text";
    const options = normalizeOptions(raw.options || raw.choices || raw.enum);
    if (options.length && type === "text") type = "select";
    const acceptByKind = { image: "image/*", video: "video/*", audio: "audio/*" };
    return {
      key,
      label: String(raw.label || raw.title || raw.name || humanize(key)),
      type,
      required: Boolean(raw.required),
      multiple: Boolean(raw.multiple),
      accept: String(raw.accept || acceptByKind[String(raw.kind || raw.type || "").toLowerCase()] || ""),
      options,
      default: raw.default ?? raw.default_value ?? raw.value,
      placeholder: String(raw.placeholder || ""),
      help: String(raw.help || raw.hint || raw.description || ""),
      min: raw.min ?? raw.minimum,
      max: raw.max ?? raw.maximum,
      step: raw.step,
      wide: Boolean(raw.wide || raw.full_width || type === "textarea" || type === "checkbox"),
      upload_name: String(raw.upload_name || raw.form_name || raw.file_field || "files"),
    };
  }

  function normalizeFields(rawModule, fallbackModule) {
    const rawFields = rawModule?.fields || rawModule?.inputs || rawModule?.form_fields || rawModule?.form_schema?.fields || rawModule?.schema?.fields;
    let fields = [];
    if (Array.isArray(rawFields)) {
      fields = rawFields.map((fieldItem) => normalizeField(fieldItem)).filter(Boolean);
    } else if (rawFields && typeof rawFields === "object") {
      fields = Object.entries(rawFields).map(([key, fieldItem]) => normalizeField(fieldItem, key)).filter(Boolean);
    }
    return fields.length ? fields : fallbackModule.fields;
  }

  function applyFrontendFieldContracts(moduleId, fields, fallbackModule) {
    const fallbackByKey = new Map(fallbackModule.fields.map((field) => [field.key, field]));
    const requiredKeys = {
      video_subject_replace: ["subject_kind"],
      subject_generate: ["mode"],
    }[moduleId] || [];
    const normalized = fields.map((field) => {
      if (moduleId === "video_language_replace" && field.key === "target_script") {
        return { ...field, ...fallbackByKey.get("target_script") };
      }
      return field;
    });
    for (const key of requiredKeys) {
      if (!normalized.some((field) => field.key === key) && fallbackByKey.has(key)) {
        normalized.unshift(fallbackByKey.get(key));
      }
    }
    return normalized;
  }

  function normalizeModules(payload) {
    const rows = moduleRowsFromPayload(payload);
    const byId = new Map(rows.map((row) => [String(row?.id || row?.key || row?.module || row?.module_id || ""), row]));
    return MODULE_ORDER.map((id) => {
      const fallbackModule = FALLBACK_MODULES[id];
      const taskType = BACKEND_TASK_TYPES[id];
      const raw = byId.get(id) || byId.get(taskType);
      if (!raw) return { ...fallbackModule, task_type: taskType };
      return {
        ...fallbackModule,
        ...raw,
        id,
        task_type: String(raw.task_type || raw.backend_task_type || raw.key || taskType),
        label: String(raw.label || raw.name || raw.title || fallbackModule.label),
        shortLabel: String(raw.short_label || raw.shortLabel || raw.label || fallbackModule.shortLabel),
        kicker: String(raw.kicker || raw.category || fallbackModule.kicker),
        description: String(raw.description || raw.help || fallbackModule.description),
        fields: applyFrontendFieldContracts(id, normalizeFields(raw, fallbackModule), fallbackModule),
      };
    });
  }

  function currentModule() {
    return state.modules.find((module) => module.id === state.moduleId) || state.modules[0] || FALLBACK_MODULES[MODULE_ORDER[0]];
  }

  function draftScope() {
    const userId = window.__CONSOLE_BOOTSTRAP__?.me?.id || window.__CONSOLE_BOOTSTRAP__?.user?.id || ADMIN_WORKSPACE_USER_ID || "self";
    return String(userId);
  }

  function draftStorageKey(moduleId) {
    return `wk-video-workbench-draft:${draftScope()}:${moduleId}`;
  }

  function defaultValues(module) {
    return Object.fromEntries(module.fields.filter((field) => field.type !== "file").map((field) => [
      field.key,
      field.default ?? (field.type === "checkbox" ? false : ""),
    ]));
  }

  function loadDraft(module) {
    if (state.drafts[module.id]) return state.drafts[module.id];
    let stored = null;
    try {
      stored = JSON.parse(window.localStorage.getItem(draftStorageKey(module.id)) || "null");
    } catch {}
    state.drafts[module.id] = {
      values: { ...defaultValues(module), ...(stored?.values && typeof stored.values === "object" ? stored.values : {}) },
      savedAt: String(stored?.savedAt || ""),
    };
    return state.drafts[module.id];
  }

  function saveDraft(moduleId) {
    const draft = state.drafts[moduleId];
    if (!draft) return;
    draft.savedAt = new Date().toISOString();
    try {
      window.localStorage.setItem(draftStorageKey(moduleId), JSON.stringify({ values: draft.values, savedAt: draft.savedAt }));
    } catch {}
    updateDraftStatus();
  }

  function clearDraft(moduleId) {
    const module = state.modules.find((item) => item.id === moduleId) || FALLBACK_MODULES[moduleId];
    state.drafts[moduleId] = { values: defaultValues(module), savedAt: "" };
    state.files[moduleId] = {};
    try {
      window.localStorage.removeItem(draftStorageKey(moduleId));
    } catch {}
    render();
  }

  function advancedId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function parseTimecode(value) {
    const source = String(value || "").trim().replace(",", ".");
    if (!source) return 0;
    const parts = source.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return 0;
    if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
    if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
    return Math.max(0, parts[0]);
  }

  function formatTimecode(value) {
    const seconds = Math.max(0, Number(value) || 0);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = (seconds % 60).toFixed(3).replace(/\.000$/, "");
    return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${remainder.padStart(2, "0")}`;
  }

  function normalizeTimelineRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row, index) => {
      const start = Math.max(0, Number(row?.start ?? row?.start_seconds ?? 0) || 0);
      const end = Math.max(start + 0.1, Number(row?.end ?? row?.end_seconds ?? start + 3) || start + 3);
      return {
        id: String(row?.id || row?.segment_id || advancedId("line")),
        start,
        end,
        text: String(row?.text || row?.dialogue || row?.line || ""),
        regenerate: Boolean(row?.regenerate),
        regenerate_revision: Number(row?.regenerate_revision || 0),
        index,
      };
    });
  }

  function parseTimedScript(source) {
    const input = String(source || "").replace(/\r/g, "").trim();
    if (!input) return [];
    const rows = [];
    const srtPattern = /(?:^|\n)(?:\d+\s*\n)?(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3}|\d{1,2}:\d{2}(?::\d{2})?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3}|\d{1,2}:\d{2}(?::\d{2})?)\s*\n([\s\S]*?)(?=\n\s*\n|$)/g;
    let match;
    while ((match = srtPattern.exec(input))) {
      rows.push({ start: parseTimecode(match[1]), end: parseTimecode(match[2]), text: match[3].replace(/\n+/g, " ").trim() });
    }
    if (rows.length) return normalizeTimelineRows(rows);
    let cursor = 0;
    input.split(/\n+/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
      const timed = line.match(/^\[?\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)\s*(?:-->|-|~)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)\s*\]?\s*(.*)$/);
      if (timed) {
        rows.push({ start: parseTimecode(timed[1]), end: parseTimecode(timed[2]), text: timed[3].trim() });
        cursor = parseTimecode(timed[2]);
      } else {
        rows.push({ start: cursor, end: cursor + 3, text: line.replace(/^[-*]\s*/, "") });
        cursor += 3;
      }
    });
    return normalizeTimelineRows(rows);
  }

  function scriptSource(module, values) {
    if (module.id === "video_language_replace") return values.target_script || values.translated_script || values.script || values.speech_text || "";
    return values.speech_text || values.script || values.copy_text || "";
  }

  function buildStoryboard(module, values, revision = 0) {
    const duration = Math.max(6, Number(values.duration_seconds) || 15);
    const sourceLines = scriptSource(module, values).split(/[\n。！？!?]+/).map((line) => line.trim()).filter(Boolean);
    const count = Math.max(3, Math.min(6, sourceLines.length || Math.round(duration / 4)));
    const sceneDuration = Number((duration / count).toFixed(1));
    const product = String(values.product_name || "商品");
    const style = String(values.style_hint || "自然真实的电商场景");
    return Array.from({ length: count }, (_, index) => ({
      id: advancedId("shot"),
      index,
      start: Number((index * sceneDuration).toFixed(1)),
      end: index === count - 1 ? duration : Number(((index + 1) * sceneDuration).toFixed(1)),
      shot: ["建立场景", "痛点引入", "细节展示", "使用演示", "效果强化", "行动引导"][index] || `镜头 ${index + 1}`,
      dialogue: sourceLines[index % Math.max(1, sourceLines.length)] || `${product}卖点展示 ${index + 1}`,
      visual_prompt: `${style}，${product}，镜头 ${index + 1}${revision ? `，变化版本 ${revision}` : ""}`,
    }));
  }

  function ensureAdvancedValues(module, draft) {
    if (module.id === "ecommerce_short_video" && (!Array.isArray(draft.values.storyboard) || !draft.values.storyboard.length)) {
      draft.values.storyboard = buildStoryboard(module, draft.values);
      draft.values.storyboard_confirmed = false;
      draft.values.storyboard_revision = 0;
    }
    if (TIMELINE_MODULES.has(module.id)) {
      const existing = draft.values.subtitle_segments || draft.values.script_segments;
      draft.values.subtitle_segments = normalizeTimelineRows(existing);
      draft.values.script_segments = draft.values.subtitle_segments;
    }
  }

  function flattenVoicePayload(payload) {
    if (Array.isArray(payload)) return payload;
    const direct = arrayFromPayload(payload, ["items", "voices", "presets", "data"]);
    if (direct.length) return direct;
    const source = payload && typeof payload === "object" ? payload : {};
    return Object.entries(source).flatMap(([language, rows]) => (
      Array.isArray(rows) ? rows.map((row) => ({ ...row, language: row.language || language })) : []
    ));
  }

  function normalizeVoicePreset(row, index) {
    const voiceId = String(row?.voice_id || row?.voiceId || row?.id || row?.key || `voice-${index}`);
    return {
      id: String(row?.id || row?.key || voiceId),
      voiceId,
      label: String(row?.label || row?.name || row?.voice_name || row?.voiceName || voiceId),
      language: String(row?.language || row?.language_code || row?.languageCode || "Other"),
      gender: String(row?.gender || ""),
      previewUrl: String(row?.preview_url || row?.preview_path || row?.previewPath || ""),
    };
  }

  async function loadVoicePresets({ force = false } = {}) {
    if ((state.voiceLoaded && !force) || state.voiceLoading) return;
    state.voiceLoading = true;
    state.voiceError = "";
    render();
    let rows = [];
    try {
      rows = flattenVoicePayload(await request(VOICE_PRESETS_ENDPOINT));
      if (!rows.length) throw new Error("音色接口返回空列表");
    } catch (apiError) {
      try {
        rows = flattenVoicePayload(window.ELEVENLABS_OFFICIAL_VOICE_PRESETS || await request(VOICE_PRESETS_MANIFEST_URL));
        if (!rows.length) throw apiError;
        state.voiceError = "服务端音色列表暂不可用，已载入本地试听资源。";
      } catch {
        rows = SPEAKER_OPTIONS.map((label) => ({ id: label, label, voice_id: label, language: "Built-in" }));
        state.voiceError = apiError?.message || "音色列表加载失败";
      }
    }
    state.voicePresets = rows.map(normalizeVoicePreset).filter((voice) => voice.voiceId);
    state.voiceLoaded = true;
    state.voiceLoading = false;
    render();
  }

  function selectedFiles(moduleId, fieldKey) {
    return state.files[moduleId]?.[fieldKey] || [];
  }

  function moduleIcon(moduleId) {
    const icons = {
      digital_human_video: '<circle cx="12" cy="8" r="3"></circle><path d="M6 20c.8-4.2 2.8-6.3 6-6.3s5.2 2.1 6 6.3"></path><path d="m18 8 4-2v8l-4-2z"></path>',
      ecommerce_short_video: '<rect x="3" y="5" width="13" height="14" rx="2"></rect><path d="m16 10 5-3v10l-5-3z"></path><path d="M7 9h5M7 13h4"></path>',
      video_language_replace: '<path d="M4 5h12v10H9l-4 4v-4H4z"></path><path d="m17 9 4-2v8l-4-2z"></path><path d="M8 9h5M10.5 7v4"></path>',
      video_subject_replace: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><circle cx="9" cy="10" r="2.5"></circle><path d="M5.5 17c.8-2.6 2-3.8 3.5-3.8s2.7 1.2 3.5 3.8M15 9h4M17 7l2 2-2 2"></path>',
      ecommerce_image: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><circle cx="8" cy="9" r="1.5"></circle><path d="m5 17 4-4 3 3 2-2 5 3"></path>',
      subject_replace: '<path d="M4 5h10v10H4zM10 9h10v10H10z"></path><path d="m15 6 2-2 2 2M17 4v5"></path>',
      poster_translate: '<rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M8 8h8M8 12h5M8 16h8"></path><path d="m15 12 3 3 3-3"></path>',
      subject_generate: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"></path><circle cx="12" cy="12" r="4"></circle><path d="m5.6 5.6 2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"></path>',
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[moduleId] || icons.digital_human_video}</svg>`;
  }

  function renderModuleStrip() {
    const groups = [
      { label: "视频生成", hint: "口播、广告与视频编辑", ids: MODULE_ORDER.slice(0, 4) },
      { label: "图片素材", hint: "广告图、替换与主体生成", ids: MODULE_ORDER.slice(4) },
    ];
    return `<nav class="video-module-switcher" aria-label="视频工作台模块切换">
      <div class="video-module-switcher-intro">
        <div><span>WORKFLOW</span><strong>选择创作模块</strong></div>
        <small>沿用原数字人工作台步骤，模块切换后草稿会自动保留</small>
      </div>
      <div class="video-module-groups" role="tablist" aria-label="视频工作台模块">
        ${groups.map((group) => {
          const modules = group.ids.map((id) => state.modules.find((module) => module.id === id)).filter(Boolean);
          return `<div class="video-module-group-row" role="group" aria-label="${escapeHtml(group.label)}">
            <span class="video-module-group-copy"><strong>${escapeHtml(group.label)}</strong><small>${escapeHtml(group.hint)}</small></span>
            <div class="video-module-pills">${modules.map((module) => `
              <button type="button" role="tab" data-video-workbench-module="${escapeHtml(module.id)}" class="video-module-tab ${module.id === state.moduleId ? "is-active" : ""}" aria-selected="${module.id === state.moduleId ? "true" : "false"}" title="${escapeHtml(module.label)}">
                <span class="video-module-tab-icon">${moduleIcon(module.id)}</span>
                <span>${escapeHtml(module.shortLabel || module.label)}</span>
              </button>`).join("")}</div>
          </div>`;
        }).join("")}
      </div>
    </nav>`;
  }

  function optionMarkup(field, value) {
    return field.options.map((option) => `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(value) ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
  }

  function isPillSelectField(field) {
    return field?.type === "select" && PILL_SELECT_KEYS.has(field.key) && field.options.length >= 2 && field.options.length <= 4;
  }

  function renderFileField(field) {
    const files = selectedFiles(state.moduleId, field.key);
    const fileRows = files.map((item) => `<li><span>${escapeHtml(item.name)}</span><small>${formatBytes(item.size)}</small></li>`).join("");
    return `<label class="video-file-field ${files.length ? "has-files" : ""}" data-video-file-field="${escapeHtml(field.key)}">
      <input type="file" data-video-field="${escapeHtml(field.key)}" ${field.accept ? `accept="${escapeHtml(field.accept)}"` : ""} ${field.multiple ? "multiple" : ""} ${field.required ? "required" : ""} />
      <span class="video-file-field-icon">${moduleIcon(state.moduleId)}</span>
      <span class="video-file-field-copy">
        <strong>${escapeHtml(field.label)}${field.required ? '<em aria-hidden="true">*</em>' : ""}</strong>
        <span>${files.length ? `已选择 ${files.length} 个文件` : (field.help || "点击选择或将文件拖到这里")}</span>
      </span>
      <span class="video-file-field-action">${files.length ? "重新选择" : "选择文件"}</span>
      ${fileRows ? `<ul class="video-selected-files">${fileRows}</ul>` : ""}
    </label>`;
  }

  function renderInputField(field, value) {
    const common = `data-video-field="${escapeHtml(field.key)}" id="videoField-${escapeHtml(field.key)}"`;
    let control = "";
    if (field.type === "textarea") {
      control = `<textarea ${common} rows="4" ${field.required ? "required" : ""} placeholder="${escapeHtml(field.placeholder)}">${escapeHtml(value)}</textarea>`;
    } else if (isPillSelectField(field)) {
      const labelId = `videoFieldLabel-${escapeHtml(field.key)}`;
      return `<div class="video-form-field video-form-field--wide video-choice-field">
        <span id="${labelId}">${escapeHtml(field.label)}${field.required ? '<em aria-hidden="true">*</em>' : ""}</span>
        <select class="video-choice-native" ${common} aria-labelledby="${labelId}" ${field.required ? "required" : ""}>${optionMarkup(field, value)}</select>
        <div class="video-choice-pills" role="radiogroup" aria-labelledby="${labelId}">
          ${field.options.map((option) => {
            const active = String(option.value) === String(value);
            return `<button type="button" class="video-choice-pill ${active ? "is-active" : ""}" role="radio" aria-checked="${active ? "true" : "false"}" data-video-choice-field="${escapeHtml(field.key)}" data-video-choice-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</button>`;
          }).join("")}
        </div>
        ${field.help ? `<small>${escapeHtml(field.help)}</small>` : ""}
      </div>`;
    } else if (field.type === "select") {
      control = `<select ${common} ${field.required ? "required" : ""}>${optionMarkup(field, value)}</select>`;
    } else if (field.type === "checkbox") {
      return `<label class="video-form-field video-form-field--wide video-toggle-field">
        <input type="checkbox" ${common} ${value ? "checked" : ""} />
        <span class="video-toggle-track" aria-hidden="true"><span></span></span>
        <span><strong>${escapeHtml(field.label)}</strong>${field.help ? `<small>${escapeHtml(field.help)}</small>` : ""}</span>
      </label>`;
    } else {
      const type = field.type === "number" ? "number" : (field.type === "url" ? "url" : "text");
      control = `<input type="${type}" ${common} value="${escapeHtml(value)}" ${field.required ? "required" : ""} ${field.min != null ? `min="${escapeHtml(field.min)}"` : ""} ${field.max != null ? `max="${escapeHtml(field.max)}"` : ""} ${field.step != null ? `step="${escapeHtml(field.step)}"` : ""} placeholder="${escapeHtml(field.placeholder)}" />`;
    }
    return `<label class="video-form-field ${field.wide ? "video-form-field--wide" : ""}" for="videoField-${escapeHtml(field.key)}">
      <span>${escapeHtml(field.label)}${field.required ? '<em aria-hidden="true">*</em>' : ""}</span>
      ${control}
      ${field.help ? `<small>${escapeHtml(field.help)}</small>` : ""}
    </label>`;
  }

  function renderVoiceStudio(module, draft) {
    if (!VOICE_MODULES.has(module.id)) return "";
    const language = String(state.voiceFilter || draft.values.target_language || draft.values.language || "").toLowerCase();
    const filtered = state.voicePresets.filter((voice) => !language || language === "auto" || voice.language.toLowerCase().includes(language));
    const voices = (filtered.length ? filtered : state.voicePresets).slice(0, 24);
    const selectedId = String(draft.values.voice_id || draft.values.speaker || "");
    const selected = state.voicePresets.find((voice) => voice.voiceId === selectedId || voice.id === selectedId);
    const languages = [...new Set(state.voicePresets.map((voice) => voice.language).filter(Boolean))].sort();
    return `<section class="video-advanced-card video-voice-studio" data-video-voice-studio>
      <div class="video-advanced-head">
        <div><span>VOICE CAST</span><strong>音色与试听</strong><small>从服务端音色目录选择；试听不会提交任务。</small></div>
        <button type="button" class="video-mini-button" data-video-reload-voices ${state.voiceLoading ? "disabled" : ""}>${state.voiceLoading ? "加载中…" : "刷新音色"}</button>
      </div>
      ${state.voiceError ? `<div class="video-advanced-notice">${escapeHtml(state.voiceError)}</div>` : ""}
      <div class="video-voice-toolbar">
        <label><span>筛选语言</span><select data-video-voice-filter><option value="">全部语言</option>${languages.map((item) => `<option value="${escapeHtml(item)}" ${item === state.voiceFilter ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select></label>
        <div class="video-selected-voice"><span>当前音色</span><strong>${escapeHtml(selected?.label || selectedId || "未选择")}</strong></div>
      </div>
      ${state.voiceLoading && !voices.length ? `<div class="video-advanced-loading"><span class="video-workbench-loader"></span>正在加载音色列表</div>` : `
        <div class="video-voice-list" role="radiogroup" aria-label="可用音色">${voices.map((voice) => {
          const active = voice.voiceId === selectedId || voice.id === selectedId;
          return `<article class="video-voice-item ${active ? "is-selected" : ""}">
            <button type="button" class="video-voice-select" role="radio" aria-checked="${active ? "true" : "false"}" data-video-voice-select="${escapeHtml(voice.id)}">
              <strong>${escapeHtml(voice.label)}</strong><small>${escapeHtml([voice.language, voice.gender].filter(Boolean).join(" · "))}</small>
            </button>
            ${voice.previewUrl ? `<button type="button" class="video-voice-play" data-video-voice-preview="${escapeHtml(voice.id)}" aria-label="试听 ${escapeHtml(voice.label)}">▶</button>` : `<span class="video-voice-no-preview">无试听</span>`}
          </article>`;
        }).join("")}</div>`}
      <audio id="videoVoicePreview" class="video-voice-audio" controls preload="metadata" ${selected?.previewUrl ? `src="${escapeHtml(selected.previewUrl)}"` : ""}>当前浏览器不支持 audio 试听。</audio>
    </section>`;
  }

  function renderStoryboard(module, draft) {
    if (module.id !== "ecommerce_short_video" || draft.values.content_mode === "advertising") return "";
    const storyboard = Array.isArray(draft.values.storyboard) ? draft.values.storyboard : [];
    const confirmed = Boolean(draft.values.storyboard_confirmed);
    return `<section class="video-advanced-card video-storyboard" data-video-storyboard>
      <div class="video-advanced-head">
        <div><span>PLANTING STORYBOARD</span><strong>种草故事板</strong><small>先预览和编辑镜头，再确认进入生成队列。</small></div>
        <span class="video-confirm-chip ${confirmed ? "is-confirmed" : ""}">${confirmed ? "已确认" : "待确认"}</span>
      </div>
      <div class="video-storyboard-actions">
        <button type="button" class="video-mini-button" data-video-storyboard-generate>${storyboard.length ? "按当前文案重生成" : "生成预览"}</button>
        <button type="button" class="video-mini-button video-mini-button--accent" data-video-storyboard-confirm ${!storyboard.length ? "disabled" : ""}>确认故事板</button>
      </div>
      <div class="video-storyboard-track">${storyboard.map((shot, index) => `<article class="video-storyboard-shot" data-video-storyboard-id="${escapeHtml(shot.id)}">
        <header><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(formatTimecode(shot.start))}–${escapeHtml(formatTimecode(shot.end))}</strong><button type="button" data-video-remove-segment="storyboard" data-video-segment-id="${escapeHtml(shot.id)}" aria-label="删除镜头">×</button></header>
        <label><span>镜头</span><input data-video-storyboard-field="shot" data-video-segment-id="${escapeHtml(shot.id)}" value="${escapeHtml(shot.shot)}"></label>
        <label><span>台词</span><textarea rows="2" data-video-storyboard-field="dialogue" data-video-segment-id="${escapeHtml(shot.id)}">${escapeHtml(shot.dialogue)}</textarea></label>
        <label><span>画面提示词</span><textarea rows="3" data-video-storyboard-field="visual_prompt" data-video-segment-id="${escapeHtml(shot.id)}">${escapeHtml(shot.visual_prompt)}</textarea></label>
        <button type="button" class="video-segment-regenerate" data-video-regenerate-segment="storyboard" data-video-segment-id="${escapeHtml(shot.id)}">重生成此段</button>
      </article>`).join("")}</div>
    </section>`;
  }

  function renderTimelineEditor(module, draft) {
    if (!TIMELINE_MODULES.has(module.id)) return "";
    const rows = normalizeTimelineRows(draft.values.subtitle_segments);
    return `<section class="video-advanced-card video-timeline-editor" data-video-timeline-editor>
      <div class="video-advanced-head">
        <div><span>SCRIPT TIMELINE</span><strong>字幕 / 台词时间轴</strong><small>${module.id === "video_language_replace" ? "支持解析 SRT、[开始-结束] 台词和纯文本。" : "按片段校对时间码和口播台词。"}</small></div>
        <button type="button" class="video-mini-button" data-video-parse-script>解析脚本</button>
      </div>
      <div class="video-timeline-list">${rows.length ? rows.map((row, index) => `<div class="video-timeline-row" data-video-timeline-id="${escapeHtml(row.id)}">
        <span class="video-timeline-index">${String(index + 1).padStart(2, "0")}</span>
        <label><span>开始</span><input inputmode="decimal" data-video-timeline-field="start" data-video-segment-id="${escapeHtml(row.id)}" value="${escapeHtml(formatTimecode(row.start))}"></label>
        <label><span>结束</span><input inputmode="decimal" data-video-timeline-field="end" data-video-segment-id="${escapeHtml(row.id)}" value="${escapeHtml(formatTimecode(row.end))}"></label>
        <label class="video-timeline-copy"><span>字幕 / 台词</span><textarea rows="2" data-video-timeline-field="text" data-video-segment-id="${escapeHtml(row.id)}">${escapeHtml(row.text)}</textarea></label>
        <div class="video-timeline-actions"><button type="button" data-video-regenerate-segment="timeline" data-video-segment-id="${escapeHtml(row.id)}">重生成</button><button type="button" data-video-remove-segment="timeline" data-video-segment-id="${escapeHtml(row.id)}">删除</button></div>
      </div>`).join("") : `<div class="video-advanced-empty">暂无时间轴片段。填写脚本后点击“解析脚本”，或手动添加台词。</div>`}</div>
      <button type="button" class="video-add-segment" data-video-add-timeline>＋ 添加时间轴片段</button>
    </section>`;
  }

  function renderAdvancedSections(module, draft) {
    const sections = [renderVoiceStudio(module, draft), renderStoryboard(module, draft), renderTimelineEditor(module, draft)].filter(Boolean);
    if (!sections.length) return "";
    return `<section class="video-form-section video-form-section--advanced">
      <div class="video-section-heading"><span>03</span><div><strong>高级编排</strong><small>试听、故事板和时间轴内容都会随草稿保存。</small></div></div>
      <div class="video-advanced-stack">${sections.join("")}</div>
    </section>`;
  }

  function renderForm(module) {
    const draft = loadDraft(module);
    ensureAdvancedValues(module, draft);
    const fileFields = module.fields.filter((field) => field.type === "file");
    const inputFields = module.fields.filter((field) => field.type !== "file" && !(VOICE_MODULES.has(module.id) && ["speaker", "voice_id"].includes(field.key)));
    return `<form id="videoWorkbenchForm" class="video-workbench-form" data-video-module-form="${escapeHtml(module.id)}">
      ${fileFields.length ? `<section class="video-form-section">
        <div class="video-section-heading"><span>01</span><div><strong>输入素材</strong><small>文件仅在当前页面保留，草稿会保存其他参数。</small></div></div>
        <div class="video-file-grid">${fileFields.map(renderFileField).join("")}</div>
      </section>` : ""}
      ${inputFields.length ? `<section class="video-form-section">
        <div class="video-section-heading"><span>${fileFields.length ? "02" : "01"}</span><div><strong>生成设置</strong><small>字段沿用原工作台可见参数，可随时暂存。</small></div></div>
        <div class="video-form-grid">${inputFields.map((field) => renderInputField(field, draft.values[field.key])).join("")}</div>
      </section>` : `<div class="video-workbench-state video-workbench-state--empty"><strong>当前模块没有可填写字段</strong><span>模块接口返回了空字段合同，请刷新后重试。</span></div>`}
      ${renderAdvancedSections(module, draft)}
      <div class="video-form-footer">
        <div class="video-draft-status" data-video-draft-status>${draft.savedAt ? `草稿已保存 · ${escapeHtml(formatTime(draft.savedAt))}` : "输入内容将自动保存为草稿"}</div>
        <div class="video-form-actions">
          <button type="button" class="video-button video-button--ghost" data-video-clear-draft>清空草稿</button>
          <button type="submit" class="video-button video-button--primary" ${state.submitting ? "disabled" : ""}>
            ${state.submitting ? '<span class="video-button-spinner" aria-hidden="true"></span>正在提交' : "提交生成任务"}
          </button>
        </div>
      </div>
      ${state.submitError ? `<div class="video-inline-error" role="alert">${escapeHtml(state.submitError)}</div>` : ""}
    </form>`;
  }

  function taskStatus(task) {
    return String(task.status || task.state || task.phase || "unknown").trim().toLowerCase();
  }

  function safeHttpUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const parsed = new URL(raw, window.location.href);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
      return parsed.href;
    } catch {
      return "";
    }
  }

  function inferMediaType(value, declaredType = "") {
    const type = String(declaredType || "").trim().toLowerCase();
    if (["image", "video", "audio"].includes(type)) return type;
    let pathname = "";
    try {
      pathname = new URL(String(value || ""), window.location.href).pathname.toLowerCase();
    } catch {}
    if (/\.(?:png|jpe?g|webp|gif|avif)$/.test(pathname)) return "image";
    if (/\.(?:mp4|webm|mov|m4v|ogv)$/.test(pathname)) return "video";
    if (/\.(?:mp3|wav|ogg|m4a|aac|flac)$/.test(pathname)) return "audio";
    return "";
  }

  function normalizeMediaItems(task) {
    const result = task?.result && typeof task.result === "object" ? task.result : {};
    const output = task?.output_data && typeof task.output_data === "object" ? task.output_data : {};
    const arrays = [task?.media_items, task?.mediaItems, result?.media_items, result?.mediaItems, output?.media_items, output?.mediaItems]
      .filter(Array.isArray);
    const candidates = arrays.flat();
    if (!candidates.length) {
      for (const key of ["result_url", "output_url", "video_url", "image_url", "audio_url"]) {
        if (task?.[key]) candidates.push({ url: task[key], label: "任务结果" });
      }
    }
    const seen = new Set();
    return candidates.map((item, index) => {
      const source = item && typeof item === "object" ? item : { url: item };
      const url = safeHttpUrl(source.url || source.src || source.download_url || source.output_url);
      const type = inferMediaType(url, source.type || source.media_type || source.mediaType);
      const thumbnailUrl = safeHttpUrl(source.thumbnail_url || source.thumbnailUrl);
      if (!url || !type || seen.has(url)) return null;
      seen.add(url);
      return {
        url,
        type,
        thumbnailUrl,
        label: String(source.label || source.name || `结果 ${index + 1}`),
      };
    }).filter(Boolean).slice(0, 8);
  }

  function taskMediaKey(task, source = task?.source) {
    return `${String(source || "regular")}:${String(task?.id || "")}`;
  }

  async function hydrateTaskMedia(tasks) {
    const candidates = tasks.filter((task) => (
      task.source === "regular"
      && task.id
      && task.has_download
      && !task.mediaItems.length
      && !state.taskMediaResolved[taskMediaKey(task)]
      && !state.taskMediaLoading[taskMediaKey(task)]
    )).slice(0, 12);
    await Promise.allSettled(candidates.map(async (task) => {
      const key = taskMediaKey(task);
      state.taskMediaLoading[key] = true;
      try {
        const detail = await request(`/api/tasks/${encodeURIComponent(task.id)}`);
        const mediaItems = normalizeMediaItems(detail);
        state.taskMedia[key] = mediaItems;
        task.mediaItems = mediaItems;
        state.taskMediaResolved[key] = true;
      } finally {
        delete state.taskMediaLoading[key];
      }
    }));
  }

  function renderTaskMedia(task) {
    const mediaItems = Array.isArray(task.mediaItems) ? task.mediaItems : [];
    if (!mediaItems.length) return "";
    return `<div class="video-task-media" aria-label="任务结果预览">${mediaItems.map((item) => {
      const label = escapeHtml(item.label || "任务结果");
      const sourceUrl = escapeHtml(item.url);
      if (item.type === "image") {
        const previewUrl = escapeHtml(item.thumbnailUrl || item.url);
        return `<figure class="video-task-media-item is-image"><img src="${previewUrl}" alt="${label}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><figcaption>${label}</figcaption></figure>`;
      }
      if (item.type === "video") {
        return `<figure class="video-task-media-item is-video"><video src="${sourceUrl}" controls preload="metadata" playsinline referrerpolicy="no-referrer">当前浏览器不支持视频预览。</video><figcaption>${label}</figcaption></figure>`;
      }
      return `<figure class="video-task-media-item is-audio"><audio src="${sourceUrl}" controls preload="metadata">当前浏览器不支持音频预览。</audio><figcaption>${label}</figcaption></figure>`;
    }).join("")}</div>`;
  }

  function statusCopy(status) {
    return {
      queued: "排队中",
      pending: "待处理",
      submitted: "已提交",
      running: "生成中",
      processing: "处理中",
      success: "已完成",
      completed: "已完成",
      finished: "已完成",
      failed: "失败",
      error: "失败",
      cancelled: "已取消",
      canceled: "已取消",
    }[status] || status || "未知";
  }

  function normalizeTask(task, source) {
    const id = String(task?.id || task?.task_id || task?.uuid || "");
    const moduleId = String(task?.module || task?.module_id || task?.video_module || task?.task_type || task?.type || "");
    const result = task?.result && typeof task.result === "object" ? task.result : {};
    const segments = [task?.segments, task?.storyboard, result?.segments, result?.storyboard, task?.output_data?.segments]
      .find((candidate) => Array.isArray(candidate)) || [];
    const mediaKey = taskMediaKey({ id }, source);
    const directMediaItems = normalizeMediaItems(task);
    if (directMediaItems.length) state.taskMedia[mediaKey] = directMediaItems;
    return {
      ...task,
      id,
      moduleId,
      source,
      status: taskStatus(task),
      title: String(task?.title || task?.name || task?.workflow_name || FALLBACK_MODULES[moduleId]?.label || humanize(moduleId) || "视频任务"),
      createdAt: task?.created_at || task?.createdAt || task?.updated_at || task?.updatedAt || "",
      progress: Number(task?.progress ?? task?.progress_percent ?? task?.percent ?? 0),
      mediaItems: directMediaItems.length ? directMediaItems : (state.taskMedia[mediaKey] || []),
      segments: segments.map((segment, index) => ({
        ...segment,
        id: String(segment?.id || segment?.segment_id || segment?.index || index),
        endpointIndex: index + 1,
        label: String(segment?.label || segment?.title || segment?.shot || segment?.text || `片段 ${index + 1}`),
        status: String(segment?.status || segment?.state || "").toLowerCase(),
      })),
    };
  }

  function relevantRegularTask(task) {
    const moduleId = String(task?.moduleId || "");
    if (MODULE_ORDER.includes(moduleId)) return true;
    const legacyTypes = {
      commerce_video: ["digital_human_video", "ecommerce_short_video"],
      create_video: ["digital_human_video", "ecommerce_short_video"],
      image_generate: ["ecommerce_image", "subject_generate"],
      replace_model: ["video_subject_replace", "subject_replace"],
      replace_product: ["video_subject_replace", "subject_replace"],
      replace_productANDmodel: ["video_subject_replace", "subject_replace"],
    };
    return Boolean(legacyTypes[moduleId]?.includes(state.moduleId));
  }

  function renderTaskList() {
    if (state.taskLoading && !state.tasks.length) {
      return `<div class="video-workbench-state video-workbench-state--loading"><span class="video-workbench-loader" aria-hidden="true"></span><strong>正在读取任务</strong><span>同步规划与执行状态...</span></div>`;
    }
    if (state.taskError && !state.tasks.length) {
      return `<div class="video-workbench-state video-workbench-state--error"><span class="video-state-symbol" aria-hidden="true">!</span><strong>任务加载失败</strong><span>${escapeHtml(state.taskError)}</span><button type="button" class="video-button video-button--ghost" data-video-refresh>重新加载</button></div>`;
    }
    const visibleTasks = state.tasks.filter((task) => !task.moduleId || task.moduleId === state.moduleId || relevantRegularTask(task)).slice(0, 12);
    if (!visibleTasks.length) {
      return `<div class="video-workbench-state video-workbench-state--empty"><span class="video-state-symbol" aria-hidden="true">＋</span><strong>暂无任务</strong><span>提交后，规划与执行进度会显示在这里。</span></div>`;
    }
    return `<div class="video-task-list">${visibleTasks.map((task) => {
      const status = task.status;
      const progress = Math.max(0, Math.min(100, Number.isFinite(task.progress) ? task.progress : 0));
      const downloadUrl = safeHttpUrl(task.download_url || task.output_url || (task.id ? `/api/tasks/${encodeURIComponent(task.id)}/download` : ""));
      const canDownload = Boolean(task.has_download || task.download_url || task.output_url) && Boolean(downloadUrl);
      const canCancel = task.id && ACTIVE_STATUSES.has(status);
      const canResume = task.id && ["failed", "cancelled", "canceled"].includes(status);
      const failedSegments = (task.segments || []).filter((segment) => !segment.status || ["failed", "error", "cancelled", "canceled"].includes(segment.status));
      return `<article class="video-task-card" data-video-task-id="${escapeHtml(task.id)}">
        <div class="video-task-card-head">
          <span class="video-task-source">${task.source === "video" ? "视频规划" : "执行队列"}</span>
          <span class="video-task-status is-${escapeHtml(status)}"><i aria-hidden="true"></i>${escapeHtml(statusCopy(status))}</span>
        </div>
        <strong>${escapeHtml(task.title)}</strong>
        <small>${escapeHtml(task.id || "待分配任务 ID")} · ${escapeHtml(formatTime(task.createdAt))}</small>
        ${ACTIVE_STATUSES.has(status) ? `<div class="video-task-progress"><span style="width:${progress || 8}%"></span></div>` : ""}
        ${renderTaskMedia(task)}
        <div class="video-task-actions">
          ${canDownload ? `<a class="video-task-download" href="${escapeHtml(downloadUrl)}">下载结果</a>` : ""}
          ${canCancel ? `<button type="button" class="video-task-action" data-video-task-action="cancel" data-video-task-id="${escapeHtml(task.id)}">取消任务</button>` : ""}
          ${canResume ? `<button type="button" class="video-task-action" data-video-task-action="retry" data-video-task-id="${escapeHtml(task.id)}">失败续跑</button>` : ""}
        </div>
        ${canResume && failedSegments.length ? `<div class="video-task-segments"><span>失败片段</span>${failedSegments.slice(0, 8).map((segment) => `<button type="button" data-video-task-segment-regenerate data-video-task-id="${escapeHtml(task.id)}" data-video-segment-id="${escapeHtml(segment.endpointIndex)}">${escapeHtml(segment.label)} · 重生成</button>`).join("")}</div>` : ""}
      </article>`;
    }).join("")}</div>`;
  }

  function renderTaskPanel() {
    return `<aside class="video-task-panel">
      <div class="video-task-panel-head">
        <div><span>LIVE QUEUE</span><strong>任务动态</strong></div>
        <button type="button" class="video-icon-button" data-video-refresh aria-label="刷新任务" title="刷新任务">↻</button>
      </div>
      ${state.taskWarning ? `<div class="video-task-warning">${escapeHtml(state.taskWarning)}</div>` : ""}
      ${renderTaskList()}
    </aside>`;
  }

  function render() {
    const root = document.getElementById("videoWorkbenchRoot");
    if (!root) return;
    if (state.moduleLoading && !state.initialized) {
      root.innerHTML = `<div class="video-workbench-state video-workbench-state--loading"><span class="video-workbench-loader" aria-hidden="true"></span><strong>正在准备视频工作台</strong><span>读取可用模块与任务规划...</span></div>`;
      return;
    }
    const module = currentModule();
    const moduleGroup = MODULE_ORDER.indexOf(module.id) < 4 ? "视频生成" : "图片素材";
    loadDraft(module);
    root.innerHTML = `<div class="video-workbench-shell">
      <header class="video-workbench-hero">
        <div class="video-workbench-hero-mark">${moduleIcon(module.id)}</div>
        <div class="video-workbench-hero-copy">
          <span>${escapeHtml(module.kicker)}</span>
          <h3>${escapeHtml(module.label)}</h3>
          <p>${escapeHtml(module.description)}</p>
        </div>
        <div class="video-workbench-hero-meta"><span><i></i>${escapeHtml(moduleGroup)}</span><small>草稿自动保存 · 任务统一管理</small></div>
      </header>
      ${renderModuleStrip()}
      ${state.moduleError ? `<div class="video-catalog-notice is-fallback"><strong>已启用本地模块配置</strong><span>在线模块目录暂不可用，当前功能与字段仍可正常使用。</span><button type="button" data-video-retry-modules>重新连接</button></div>` : ""}
      ${state.moduleEmpty ? `<div class="video-catalog-notice"><strong>模块接口返回空列表</strong><span>已显示内置的 8 个模块合同。</span></div>` : ""}
      <div class="video-workbench-grid">
        <main class="video-form-panel">${renderForm(module)}</main>
        ${renderTaskPanel()}
      </div>
    </div>`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatTime(value) {
    if (!value) return "刚刚";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }

  function updateDraftStatus() {
    const node = document.querySelector("[data-video-draft-status]");
    const draft = state.drafts[state.moduleId];
    if (node && draft?.savedAt) node.textContent = `草稿已保存 · ${formatTime(draft.savedAt)}`;
  }

  function readFieldValue(field, input) {
    if (field.type === "checkbox") return Boolean(input.checked);
    if (field.type === "number") return input.value === "" ? "" : Number(input.value);
    return input.value;
  }

  function handleFieldChange(input) {
    const module = currentModule();
    const field = module.fields.find((item) => item.key === input.dataset.videoField);
    if (!field) return;
    if (field.type === "file") {
      state.files[module.id] ||= {};
      state.files[module.id][field.key] = Array.from(input.files || []);
      render();
      return;
    }
    const draft = loadDraft(module);
    draft.values[field.key] = readFieldValue(field, input);
    if (module.id === "ecommerce_short_video" && ["speech_text", "prompt_text", "product_name", "style_hint"].includes(field.key)) {
      draft.values.storyboard_confirmed = false;
    }
    saveDraft(module.id);
    if (isPillSelectField(field)) render();
  }

  function advancedDraft() {
    const module = currentModule();
    const draft = loadDraft(module);
    ensureAdvancedValues(module, draft);
    return { module, draft };
  }

  function selectVoice(voiceId) {
    const { module, draft } = advancedDraft();
    const voice = state.voicePresets.find((item) => item.id === voiceId || item.voiceId === voiceId);
    if (!voice) return;
    draft.values.voice_id = voice.voiceId;
    draft.values.speaker = voice.voiceId;
    draft.values.voice_label = voice.label;
    saveDraft(module.id);
    render();
  }

  function previewVoice(voiceId) {
    const voice = state.voicePresets.find((item) => item.id === voiceId || item.voiceId === voiceId);
    const audio = document.getElementById("videoVoicePreview");
    if (!voice?.previewUrl || !audio) return;
    if (audio.src !== new URL(voice.previewUrl, window.location.href).href) audio.src = voice.previewUrl;
    state.playingVoiceId = voice.id;
    audio.play().catch(() => {});
  }

  function regenerateStoryboard() {
    const { module, draft } = advancedDraft();
    const revision = Number(draft.values.storyboard_revision || 0) + 1;
    draft.values.storyboard = buildStoryboard(module, draft.values, revision);
    draft.values.storyboard_revision = revision;
    draft.values.storyboard_confirmed = false;
    saveDraft(module.id);
    render();
  }

  function confirmStoryboard() {
    const { module, draft } = advancedDraft();
    if (!Array.isArray(draft.values.storyboard) || !draft.values.storyboard.length) return;
    draft.values.storyboard_confirmed = true;
    draft.values.storyboard_confirmed_at = new Date().toISOString();
    saveDraft(module.id);
    render();
  }

  function updateStoryboardField(input) {
    const { module, draft } = advancedDraft();
    const shot = draft.values.storyboard.find((item) => String(item.id) === String(input.dataset.videoSegmentId));
    if (!shot) return;
    shot[input.dataset.videoStoryboardField] = input.value;
    draft.values.storyboard_confirmed = false;
    saveDraft(module.id);
    document.querySelector(".video-confirm-chip")?.classList.remove("is-confirmed");
    const chip = document.querySelector(".video-confirm-chip");
    if (chip) chip.textContent = "待确认";
  }

  function setTimelineRows(module, draft, rows) {
    draft.values.subtitle_segments = normalizeTimelineRows(rows);
    draft.values.script_segments = draft.values.subtitle_segments;
    saveDraft(module.id);
  }

  async function parseCurrentScript() {
    const { module, draft } = advancedDraft();
    const source = scriptSource(module, draft.values);
    let rows = [];
    if (module.id === "video_language_replace" && String(source || "").trim()) {
      try {
        const parsed = await request("/api/video/language-script/parse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script: source }),
        });
        rows = normalizeTimelineRows(parsed?.segments || []);
      } catch {
        rows = [];
      }
    }
    if (!rows.length) rows = parseTimedScript(source);
    if (!rows.length) {
      state.submitError = "请先填写脚本或口播文案，再解析时间轴";
    } else {
      state.submitError = "";
      setTimelineRows(module, draft, rows);
    }
    render();
  }

  function updateTimelineField(input) {
    const { module, draft } = advancedDraft();
    const rows = normalizeTimelineRows(draft.values.subtitle_segments);
    const row = rows.find((item) => String(item.id) === String(input.dataset.videoSegmentId));
    if (!row) return;
    const key = input.dataset.videoTimelineField;
    row[key] = key === "text" ? input.value : parseTimecode(input.value);
    if (row.end <= row.start) row.end = row.start + 0.1;
    setTimelineRows(module, draft, rows);
  }

  function addTimelineRow() {
    const { module, draft } = advancedDraft();
    const rows = normalizeTimelineRows(draft.values.subtitle_segments);
    const start = rows.length ? rows[rows.length - 1].end : 0;
    rows.push({ id: advancedId("line"), start, end: start + 3, text: "" });
    setTimelineRows(module, draft, rows);
    render();
  }

  function removeAdvancedSegment(kind, segmentId) {
    const { module, draft } = advancedDraft();
    if (kind === "storyboard") {
      draft.values.storyboard = (draft.values.storyboard || []).filter((item) => String(item.id) !== String(segmentId));
      draft.values.storyboard_confirmed = false;
      saveDraft(module.id);
    } else {
      setTimelineRows(module, draft, (draft.values.subtitle_segments || []).filter((item) => String(item.id) !== String(segmentId)));
    }
    render();
  }

  function regenerateDraftSegment(kind, segmentId) {
    const { module, draft } = advancedDraft();
    if (kind === "storyboard") {
      const shot = (draft.values.storyboard || []).find((item) => String(item.id) === String(segmentId));
      if (shot) {
        const revision = Number(shot.revision || 0) + 1;
        shot.revision = revision;
        shot.visual_prompt = `${String(draft.values.style_hint || "自然真实的电商场景")}，${String(draft.values.product_name || "商品")}，${shot.shot}，变化镜头 ${revision}`;
        draft.values.storyboard_confirmed = false;
        saveDraft(module.id);
      }
    } else {
      const rows = normalizeTimelineRows(draft.values.subtitle_segments);
      const row = rows.find((item) => String(item.id) === String(segmentId));
      if (row) {
        row.regenerate = true;
        row.regenerate_revision = Number(row.regenerate_revision || 0) + 1;
        setTimelineRows(module, draft, rows);
      }
    }
    render();
  }

  async function regenerateTaskSegment(taskId, segmentId) {
    if (!taskId || !segmentId) return;
    try {
      await request(`/api/video/tasks/${encodeURIComponent(taskId)}/segments/${encodeURIComponent(segmentId)}/regenerate`, { method: "POST" });
    } catch {
      await request(`/api/tasks/${encodeURIComponent(taskId)}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segment_id: segmentId }),
      });
    }
    await loadTasks({ quiet: true });
  }

  function validate(module) {
    const draft = loadDraft(module);
    for (const field of module.fields) {
      if (!field.required) continue;
      if (field.type === "file" && !selectedFiles(module.id, field.key).length) return `请上传${field.label}`;
      if (field.type !== "file" && String(draft.values[field.key] ?? "").trim() === "") return `请填写${field.label}`;
    }
    if (module.id === "ecommerce_image" && draft.values.mode === "model_product" && !selectedFiles(module.id, "model_image").length) {
      return "“模特图 + 商品图”模式需要上传模特图";
    }
    if (module.id === "ecommerce_short_video" && draft.values.content_mode !== "advertising" && !draft.values.storyboard_confirmed) {
      return "请先预览并确认种草故事板";
    }
    return "";
  }

  async function submit(event) {
    event.preventDefault();
    if (state.submitting) return;
    const module = currentModule();
    const validationError = validate(module);
    if (validationError) {
      state.submitError = validationError;
      render();
      return;
    }
    state.submitting = true;
    state.submitError = "";
    render();
    try {
      const draft = loadDraft(module);
      ensureAdvancedValues(module, draft);
      if (module.id === "video_language_replace") {
        const parsed = normalizeTimelineRows(draft.values.subtitle_segments).length
          ? normalizeTimelineRows(draft.values.subtitle_segments)
          : parseTimedScript(scriptSource(module, draft.values));
        if (parsed.length) {
          draft.values.subtitle_segments = parsed;
          draft.values.script_segments = parsed;
          draft.values.target_script = parsed.map((row) => row.text).filter(Boolean).join("\n");
        }
      }
      const submitValues = { ...draft.values };
      if (TIMELINE_MODULES.has(module.id)) {
        const subtitleItems = normalizeTimelineRows(draft.values.subtitle_segments).map((row) => ({
          start_seconds: Number(row.start),
          end_seconds: Number(row.end),
          text: String(row.text || "").trim(),
        })).filter((row) => row.text && row.end_seconds > row.start_seconds);
        submitValues.subtitles = {
          enabled: draft.values.subtitles_enabled !== false,
          template: String(draft.values.subtitle_template || "keyword_focus"),
          items: subtitleItems,
        };
      }
      if (module.id === "video_subject_replace") {
        submitValues.subject_kind = draft.values.subject_kind === "product" ? "product" : "model";
      }
      if (!(await confirmPromptPreview(module, submitValues))) return;
      const fileManifest = [];
      const body = new FormData();
      body.append("module", module.id);
      body.append("module_id", module.id);
      body.append("video_module", module.id);
      body.append("task_type", module.task_type || BACKEND_TASK_TYPES[module.id] || module.id);
      module.fields.filter((field) => field.type === "file").forEach((field) => {
        selectedFiles(module.id, field.key).forEach((selectedFile) => {
          body.append(field.upload_name || "files", selectedFile);
          fileManifest.push({ field: field.key, name: selectedFile.name, size: selectedFile.size, type: selectedFile.type });
        });
      });
      body.append("params_json", JSON.stringify({ ...submitValues, _file_roles: fileManifest }));
      const result = await request("/api/video/tasks", { method: "POST", body });
      const createdTask = normalizeTask(result?.task || result, "video");
      if (createdTask.id || createdTask.moduleId) state.tasks.unshift(createdTask);
      state.files[module.id] = {};
      saveDraft(module.id);
      await loadTasks({ quiet: true });
    } catch (error) {
      state.submitError = error?.message || "任务提交失败";
    } finally {
      state.submitting = false;
      render();
    }
  }

  async function loadModules() {
    state.moduleLoading = true;
    state.moduleError = "";
    state.moduleEmpty = false;
    render();
    try {
      const payload = await request("/api/video/modules");
      const rows = moduleRowsFromPayload(payload);
      state.moduleEmpty = rows.length === 0;
      state.modules = normalizeModules(payload);
    } catch (error) {
      state.moduleError = error?.message || "无法读取模块配置";
      state.modules = MODULE_ORDER.map((id) => FALLBACK_MODULES[id]);
    } finally {
      state.moduleLoading = false;
      state.initialized = true;
      render();
    }
  }

  async function loadTasks({ quiet = false } = {}) {
    if (!quiet) state.taskLoading = true;
    state.taskError = "";
    state.taskWarning = "";
    render();
    const results = await Promise.allSettled([
      request("/api/video/tasks"),
      request("/api/tasks"),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    const videoRows = results[0].status === "fulfilled" ? arrayFromPayload(results[0].value, ["tasks", "items", "data"]) : [];
    const regularRows = results[1].status === "fulfilled" ? arrayFromPayload(results[1].value, ["tasks", "items", "data"]) : [];
    const merged = [
      ...videoRows.map((task) => normalizeTask(task, "video")),
      ...regularRows.map((task) => normalizeTask(task, "regular")),
    ];
    const seen = new Set();
    state.tasks = merged.filter((task) => {
      const key = `${task.source}:${task.id || task.createdAt}:${task.moduleId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
    await hydrateTaskMedia(state.tasks);
    if (failures.length === results.length) {
      state.taskError = failures[0]?.reason?.message || "无法读取任务列表";
    } else if (failures.length) {
      state.taskWarning = "部分任务来源暂时不可用，已显示可读取的任务。";
    }
    state.taskLoading = false;
    render();
    syncPolling();
  }

  function syncPolling() {
    if (state.timer) window.clearInterval(state.timer);
    state.timer = 0;
    if (!state.active || document.hidden) return;
    state.timer = window.setInterval(() => {
      if (!state.active || document.hidden) return;
      loadTasks({ quiet: true }).catch(() => {});
    }, REFRESH_INTERVAL_MS);
  }

  function hasTransientState() {
    if (state.submitting) return true;
    return Object.values(state.files).some((moduleFiles) => (
      Object.values(moduleFiles || {}).some((files) => Array.isArray(files) && files.length > 0)
    ));
  }

  function confirmLeave() {
    if (!hasTransientState()) return true;
    const message = state.submitting
      ? "视频任务正在提交。现在离开可能中断上传，确定继续吗？"
      : "视频工作台中仍有已选文件。文本参数已保存为草稿，但浏览器无法永久保存本地文件，确定离开吗？";
    return window.confirm(message);
  }

  function selectModule(moduleId) {
    if (!MODULE_ORDER.includes(moduleId) || moduleId === state.moduleId) return;
    state.moduleId = moduleId;
    state.submitError = "";
    window.VectoConsoleNavigation?.openVideoWorkspace?.(moduleId);
    render();
    if (VOICE_MODULES.has(moduleId)) loadVoicePresets().catch(() => {});
  }

  function bind() {
    if (document.documentElement.dataset.videoWorkbenchBound === "1") return;
    document.documentElement.dataset.videoWorkbenchBound = "1";
    document.addEventListener("input", (event) => {
      const input = event.target.closest?.("#videoWorkbenchRoot [data-video-field]");
      if (input && input.type !== "file") handleFieldChange(input);
      const storyboardInput = event.target.closest?.("#videoWorkbenchRoot [data-video-storyboard-field]");
      if (storyboardInput) updateStoryboardField(storyboardInput);
      const timelineInput = event.target.closest?.("#videoWorkbenchRoot [data-video-timeline-field]");
      if (timelineInput) updateTimelineField(timelineInput);
    });
    document.addEventListener("change", (event) => {
      const input = event.target.closest?.("#videoWorkbenchRoot [data-video-field]");
      if (input) handleFieldChange(input);
      const voiceFilter = event.target.closest?.("#videoWorkbenchRoot [data-video-voice-filter]");
      if (voiceFilter) {
        state.voiceFilter = voiceFilter.value;
        render();
      }
    });
    document.addEventListener("submit", (event) => {
      if (event.target.id === "videoWorkbenchForm") submit(event);
    });
    document.addEventListener("click", (event) => {
      const choiceButton = event.target.closest?.("#videoWorkbenchRoot [data-video-choice-field]");
      if (choiceButton) {
        const select = document.getElementById(`videoField-${choiceButton.dataset.videoChoiceField}`);
        if (select && select.value !== choiceButton.dataset.videoChoiceValue) {
          select.value = choiceButton.dataset.videoChoiceValue;
          handleFieldChange(select);
        }
      }
      const moduleButton = event.target.closest?.("[data-video-workbench-module]");
      if (moduleButton) selectModule(moduleButton.dataset.videoWorkbenchModule);
      if (event.target.closest?.("[data-video-clear-draft]")) clearDraft(state.moduleId);
      if (event.target.closest?.("[data-video-refresh]")) loadTasks().catch(() => {});
      if (event.target.closest?.("[data-video-retry-modules]")) loadModules().catch(() => {});
      if (event.target.closest?.("[data-video-reload-voices]")) loadVoicePresets({ force: true }).catch(() => {});
      const voiceSelect = event.target.closest?.("[data-video-voice-select]");
      if (voiceSelect) selectVoice(voiceSelect.dataset.videoVoiceSelect);
      const voicePreview = event.target.closest?.("[data-video-voice-preview]");
      if (voicePreview) previewVoice(voicePreview.dataset.videoVoicePreview);
      if (event.target.closest?.("[data-video-storyboard-generate]")) regenerateStoryboard();
      if (event.target.closest?.("[data-video-storyboard-confirm]")) confirmStoryboard();
      if (event.target.closest?.("[data-video-parse-script]")) void parseCurrentScript();
      if (event.target.closest?.("[data-video-add-timeline]")) addTimelineRow();
      const removeSegment = event.target.closest?.("[data-video-remove-segment]");
      if (removeSegment) removeAdvancedSegment(removeSegment.dataset.videoRemoveSegment, removeSegment.dataset.videoSegmentId);
      const regenerateSegment = event.target.closest?.("[data-video-regenerate-segment]");
      if (regenerateSegment) regenerateDraftSegment(regenerateSegment.dataset.videoRegenerateSegment, regenerateSegment.dataset.videoSegmentId);
      const taskSegment = event.target.closest?.("[data-video-task-segment-regenerate]");
      if (taskSegment) {
        taskSegment.disabled = true;
        regenerateTaskSegment(taskSegment.dataset.videoTaskId, taskSegment.dataset.videoSegmentId).catch((error) => {
          state.taskError = error?.message || "片段重生成失败";
          render();
        });
      }
      const taskButton = event.target.closest?.("[data-video-task-action]");
      if (taskButton) {
        taskButton.disabled = true;
        taskAction(taskButton.dataset.videoTaskId, taskButton.dataset.videoTaskAction).catch((error) => {
          state.taskError = error?.message || "任务操作失败";
          render();
        });
      }
    });
    document.addEventListener("visibilitychange", syncPolling);
    window.addEventListener("beforeunload", (event) => {
      if (!hasTransientState()) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  async function activate({ moduleId } = {}) {
    bind();
    state.active = true;
    if (MODULE_ORDER.includes(moduleId)) state.moduleId = moduleId;
    render();
    const token = ++state.requestToken;
    const jobs = [];
    if (!state.initialized) jobs.push(loadModules());
    jobs.push(loadTasks());
    jobs.push(loadVoicePresets());
    await Promise.allSettled(jobs);
    if (token !== state.requestToken) return;
    syncPolling();
  }

  function deactivate() {
    state.active = false;
    state.requestToken += 1;
    syncPolling();
  }

  window.VideoWorkbench = { activate, deactivate, refresh: loadTasks, confirmLeave, hasTransientState };
}());
