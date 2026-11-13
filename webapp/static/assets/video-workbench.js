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
  // Mirrors the original workbench's VIDEO_PROMPT_TASK_KEYS. Other modules
  // submit the user's input directly and must never have it replaced by LLM preview output.
  const VIDEO_PROMPT_MODULES = new Set(["digital_human_video", "ecommerce_short_video"]);
  const BACKEND_TASK_TYPES = {
    digital_human_video: "create_video",
    ecommerce_short_video: "ecommerce_short_video",
    video_language_replace: "video_language_replace",
    video_subject_replace: "replace_model",
    ecommerce_image: "image_generate",
    subject_replace: "image_generate",
    poster_translate: "image_generate",
    subject_generate: "image_generate",
  };
  const REFRESH_INTERVAL_MS = 5000;
  const TASK_MONITOR_INTERVAL_MS = 2000;
  const TASK_MONITOR_TIMEOUT_MS = 30 * 60 * 1000;
  const VOICE_PRESETS_ENDPOINT = "/api/video/voice-presets";
  const VOICE_PRESETS_MANIFEST_URL = "/assets/voice_presets_manifest.json";
  const VOICE_MODULES = new Set(["digital_human_video", "ecommerce_short_video", "video_language_replace"]);
  const VOICE_PRESET_DRAFT_KEYS = [
    "voice_id",
    "voice_name",
    "voice_label",
    "speaker",
    "preset_dry_voice",
    "elevenlabs_tts_preset_key",
    "elevenlabs_tts_voice_id",
    "minimax_tts_voice_id",
  ];
  const TIMELINE_MODULES = new Set(["video_language_replace"]);
  const VIDEO_OUTPUT_TASK_TYPES = new Set(["create_video", "ecommerce_short_video", "video_language_replace", "replace_model", "replace_product", "replace_productANDmodel"]);
  const SUBTITLE_TEMPLATE_OPTIONS = [
    ["split_hook", "模板 1 · 强钩子分屏"],
    ["handwritten_quote", "模板 2 · 手写金句"],
    ["bilingual_dual", "模板 3 · 双语字幕"],
    ["keyword_focus", "模板 4 · 关键词焦点"],
  ];
  const PILL_SELECT_KEYS = new Set(["digital_human_content_mode", "ecommerce_video_mode", "replace_mode", "subject_generate_mode"]);
  const DYNAMIC_SELECT_KEYS = new Set(["character_gender", "character_age"]);
  const ADMIN_WORKSPACE_USER_ID = String(document.querySelector('meta[name="admin-workspace-user-id"]')?.content || "").trim();
  const ADMIN_CONSOLE_SESSION = document.querySelector('meta[name="admin-console-session"]')?.content === "1";

  const LANGUAGE_OPTIONS = [
    { value: "Chinese", label: "中文" },
    { value: "English", label: "英文" },
    { value: "Japanese", label: "日语" },
    { value: "Spanish", label: "西班牙语" },
    { value: "Thai", label: "泰语" },
    { value: "Malay", label: "马来西亚" },
  ];
  const RUNNINGHUB_SPEECH_MODEL_OPTIONS = [
    { value: "speech-2.8-hd", label: "speech-2.8-hd（高清，推荐）" },
    { value: "speech-2.8-turbo", label: "speech-2.8-turbo（快速）" },
    { value: "speech-2.6-hd", label: "speech-2.6-hd" },
    { value: "speech-2.6-turbo", label: "speech-2.6-turbo" },
    { value: "speech-02-hd", label: "speech-02-hd" },
    { value: "speech-02-turbo", label: "speech-02-turbo" },
  ];
  const RUNNINGHUB_SPEECH_MODEL_DEFAULT = "speech-2.8-hd";

  function speechModelCatalog() {
    const live = Array.isArray(state.runtimeDefaults?.speech_models)
      ? state.runtimeDefaults.speech_models.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const allowed = live.length
      ? RUNNINGHUB_SPEECH_MODEL_OPTIONS.filter((item) => live.includes(item.value))
      : RUNNINGHUB_SPEECH_MODEL_OPTIONS;
    return allowed.length ? allowed : RUNNINGHUB_SPEECH_MODEL_OPTIONS;
  }

  function clampSpeechModel(value) {
    const allowed = speechModelCatalog().map((item) => item.value);
    const text = String(value || "").trim();
    if (allowed.includes(text)) return text;
    const runtimeValue = String(
      state.runtimeDefaults?.minimax_tts_model
      || state.runtimeDefaults?.video_tts_model
      || ""
    ).trim();
    return allowed.includes(runtimeValue) ? runtimeValue : RUNNINGHUB_SPEECH_MODEL_DEFAULT;
  }

  const VIDEO_RATIO_OPTIONS = ["16:9", "4:3", "1:1", "3:4", "9:16"];
  const VIDEO_RESOLUTION_OPTIONS = ["480p", "720p", "1080p", { value: "2k", label: "2K" }, { value: "4k", label: "4K" }];
  const IMAGE_RESOLUTION_OPTIONS = ["1K", "2K", "4K"];
  const VIDEO_STYLE_OPTIONS = [
    { value: "standard_ecommerce", label: "标准电商广告" },
    { value: "story", label: "剧情式广告" },
    { value: "documentary", label: "纪录片广告" },
    { value: "animation", label: "动画广告" },
  ];
  const AUTOMATIC_OPTION = { value: "", label: "自动" };
  const CHARACTER_HAIRSTYLES = {
    default: [AUTOMATIC_OPTION, { value: "short_clean", label: "利落短发" }, { value: "shoulder_length", label: "中长发" }, { value: "long_straight", label: "长直发" }],
    female: [AUTOMATIC_OPTION, { value: "bob", label: "波波头" }, { value: "shoulder_length", label: "中长发" }, { value: "long_straight", label: "长直发" }, { value: "soft_wave", label: "微卷发" }, { value: "ponytail", label: "马尾" }, { value: "bun", label: "盘发" }, { value: "air_bangs_long", label: "刘海长发" }],
    male: [AUTOMATIC_OPTION, { value: "short_clean", label: "利落短发" }, { value: "side_part", label: "偏分短发" }, { value: "crew_cut", label: "寸头" }, { value: "textured_short", label: "纹理短发" }, { value: "slick_back", label: "背头" }, { value: "medium_layered", label: "中短层次发" }],
  };
  const CHARACTER_TEMPERAMENTS = {
    default: [AUTOMATIC_OPTION, { value: "gentle", label: "亲和自然" }, { value: "business", label: "商务干练" }, { value: "elegant", label: "优雅知性" }, { value: "lively", label: "活力外向" }, { value: "adult_glamour", label: "妩媚性感" }],
    female: [AUTOMATIC_OPTION, { value: "elegant", label: "优雅知性" }, { value: "gentle", label: "亲和自然" }, { value: "sweet", label: "清新亲切" }, { value: "cool", label: "高级冷感" }, { value: "business", label: "干练专业" }, { value: "adult_glamour", label: "妩媚性感" }],
    female_young: [AUTOMATIC_OPTION, { value: "sweet", label: "清新甜美" }, { value: "lively", label: "活力外向" }, { value: "gentle", label: "亲和自然" }, { value: "cool", label: "高级冷感" }, { value: "elegant", label: "优雅知性" }, { value: "adult_glamour", label: "妩媚性感" }],
    female_mature: [AUTOMATIC_OPTION, { value: "elegant", label: "优雅知性" }, { value: "business", label: "商务干练" }, { value: "gentle", label: "亲和自然" }, { value: "cool", label: "高级冷感" }, { value: "calm", label: "沉稳大气" }, { value: "adult_glamour", label: "妩媚性感" }],
    male: [AUTOMATIC_OPTION, { value: "business", label: "干练专业" }, { value: "calm", label: "沉稳大气" }, { value: "sunny", label: "阳光亲和" }, { value: "elite", label: "精英专业" }, { value: "elegant", label: "儒雅稳重" }],
    male_young: [AUTOMATIC_OPTION, { value: "lively", label: "活力外向" }, { value: "business", label: "商务干练" }, { value: "sunny", label: "阳光亲和" }, { value: "cool", label: "高级冷感" }, { value: "street", label: "潮流自信" }],
    male_mature: [AUTOMATIC_OPTION, { value: "business", label: "商务干练" }, { value: "calm", label: "沉稳大气" }, { value: "gentle", label: "亲和自然" }, { value: "elite", label: "精英专业" }, { value: "elegant", label: "儒雅稳重" }],
  };
  const CHARACTER_CLOTHING = {
    default: [AUTOMATIC_OPTION, { value: "formal_suit", label: "正式西装套装" }, { value: "smart_casual_set", label: "通勤休闲套装" }, { value: "soft_knit_set", label: "针织舒适套装" }, { value: "casual_jacket_set", label: "休闲夹克套装" }, { value: "sporty", label: "运动套装" }, { value: "intimate_glamour_female", label: "福利诱惑套装" }],
    female: [AUTOMATIC_OPTION, { value: "tailored_suit_female", label: "女士西装套装" }, { value: "business_dress_female", label: "轻商务裙装套装" }, { value: "elegant_commute_female", label: "优雅通勤套装" }, { value: "soft_knit_set_female", label: "温柔针织套装" }, { value: "sporty_female", label: "运动休闲套装" }, { value: "intimate_glamour_female", label: "福利诱惑套装" }],
    female_young: [AUTOMATIC_OPTION, { value: "blazer_dress_female", label: "轻商务连衣裙套装" }, { value: "shirt_skirt_female", label: "学院感半裙套装" }, { value: "knit_jeans_female", label: "针织休闲套装" }, { value: "sweet_female", label: "清新甜美裙装套装" }, { value: "sporty_female", label: "运动休闲套装" }, { value: "intimate_glamour_female", label: "福利诱惑套装" }],
    female_mature: [AUTOMATIC_OPTION, { value: "tailored_suit_female", label: "修身西装套装" }, { value: "silk_blouse_trousers_female", label: "高级通勤套装" }, { value: "elegant_female", label: "优雅知性裙装套装" }, { value: "knit_cardigan_female", label: "温柔针织裙装套装" }, { value: "daily_female", label: "简洁日常套装" }, { value: "intimate_glamour_female", label: "福利诱惑套装" }],
    male: [AUTOMATIC_OPTION, { value: "dark_suit_male", label: "男士西装套装" }, { value: "smart_commute_male", label: "商务通勤套装" }, { value: "polo_casual_male", label: "商务休闲套装" }, { value: "casual_jacket_male", label: "成熟休闲套装" }, { value: "sporty_male", label: "运动休闲套装" }],
    male_young: [AUTOMATIC_OPTION, { value: "shirt_chinos_male", label: "清爽通勤套装" }, { value: "polo_chinos_male", label: "轻商务休闲套装" }, { value: "street_male", label: "潮流街头套装" }, { value: "knit_male", label: "简约针织套装" }, { value: "sporty_male", label: "运动休闲套装" }],
    male_mature: [AUTOMATIC_OPTION, { value: "dark_suit_male", label: "深色商务西装" }, { value: "shirt_trousers_male", label: "稳重通勤套装" }, { value: "polo_casual_male", label: "商务休闲套装" }, { value: "casual_jacket_male", label: "成熟休闲套装" }, { value: "knit_cardigan_male", label: "温和针织套装" }],
  };

  function characterProfile(values = {}) {
    const gender = values.character_gender === "female" || values.character_gender === "male" ? values.character_gender : "";
    const age = String(values.character_age || "");
    if (!gender) return "default";
    if (["18_22", "23_27", "28_32"].includes(age)) return `${gender}_young`;
    if (age) return `${gender}_mature`;
    return gender;
  }

  function videoCharacterOptionIsAvailable(options, value) {
    const current = String(value || "");
    return !current || options.some((option) => String(option.value) === current);
  }

  function reconcileVideoCharacterOptions(values, changedKey) {
    if (!["character_gender", "character_age"].includes(changedKey)) return false;
    const profile = characterProfile(values);
    const dependentOptions = [
      ...(changedKey === "character_gender"
        ? [["character_hairstyle", CHARACTER_HAIRSTYLES[values.character_gender] || CHARACTER_HAIRSTYLES.default]]
        : []),
      ["character_temperament", CHARACTER_TEMPERAMENTS[profile] || CHARACTER_TEMPERAMENTS.default],
      ["character_clothing", CHARACTER_CLOTHING[profile] || CHARACTER_CLOTHING.default],
    ];
    dependentOptions.forEach(([key, options]) => {
      if (!videoCharacterOptionIsAvailable(options, values[key])) values[key] = "";
    });
    return true;
  }
  const SPEAKER_OPTIONS = ["Aiden", "Dylan", "Eric", "Ono_anna", "Ryan", "Serena", "Sohee", "Uncle_fu", "Vivian", "zhenzhen"];
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
      description: "上传人物/模特图和产品图，生成数字人口播视频。",
      fields(values = {}) {
        const oral = values.digital_human_content_mode === "oral_broadcast";
        return [
          select("digital_human_content_mode", "内容模式", [{ value: "product_intro", label: "商品介绍模式" }, { value: "oral_broadcast", label: "口播模式" }], { default: "product_intro", placement: "uploadTop" }),
          file("model", "人物/模特图", "image/*", { required: true, multiple: true, minFiles: 1, maxFiles: 2, previewSlots: 2, help: "可上传 1-2 张；上传 2 张会启用双人对讲，上传 1 张按单人生成" }),
          file("product", oral ? "场景图" : "产品图", "image/*", { required: true, multiple: !oral, maxFiles: oral ? 1 : 3, previewSlots: oral ? 1 : 3, help: oral ? "上传 1 张口播背景/场景图；口播模式固定单镜头，不生成分镜图" : "点击素材位逐个上传；最多保留 3 个素材位" }),
          file("audio", "参考音频/干音", "audio/*", { required: true }),
          text("product_name", oral ? "口播主题" : "产品/项目名称", { placeholder: oral ? "例如：东京租房避坑 / AI 工具干货 / 职场沟通技巧" : "例如：海景公寓 / 鱼油 / 汽车" }),
          textarea("product_details", oral ? "文案需求" : "产品相关简介", { placeholder: oral ? "可选：说明口播主题、受众、核心观点、段落方向、语气风格；AI 会据此生成口播文案" : "可选：补充产品卖点、适用人群、使用场景、价格/参数等详情；只用于 AI 生成文案或提示词", help: oral ? "仅作为 AI 生成口播文案的方向参考；填写口播文案后不会自动拼接" : "可选的 AI 事实参考；可以留空，已填写口播文案时不会影响最终配音", wide: true }),
          ...(oral ? [number("oral_target_duration_seconds", "目标口播时长（秒）", { default: 30, min: 5, max: 180, step: 1 })] : []),
          select("target_language", "口播语言", LANGUAGE_OPTIONS, { default: "Chinese", placement: "voice" }),
          textarea("speech_text", "口播文案", { placeholder: oral ? "可手动输入成稿，也可留空让 AI 根据文案需求和场景图生成" : "可手动输入，也可留空让 AI 根据图片生成", help: oral ? "有内容时按此文案直接配音；留空时先生成 AI 文案，预览修改并确认后再提交" : "有内容时按此文案直接配音；留空时根据产品简介和图片生成 AI 文案，预览修改并确认后再提交", wide: true }),
          select("minimax_tts_model", "音频模型", RUNNINGHUB_SPEECH_MODEL_OPTIONS, { default: "speech-2.8-hd" }),
          select("ratio", "画面比例", VIDEO_RATIO_OPTIONS, { default: "9:16" }),
          select("image_resolution", "图片分辨率", IMAGE_RESOLUTION_OPTIONS, { default: "2K" }),
          ...(!oral ? [select("digital_human_short_mode", "分镜模式", [{ value: "storyboard", label: "多分镜" }, { value: "single", label: "单镜头" }], { default: "storyboard" })] : []),
        ];
      },
    },
    ecommerce_short_video: {
      id: "ecommerce_short_video",
      label: "广告短视频",
      shortLabel: "短视频",
      kicker: "COMMERCE VIDEO",
      description: "上传商品素材，按广告视频或种草视频原流程生成短视频。",
      fields(values = {}) {
        const seeding = values.ecommerce_video_mode === "seeding_video";
        return [
          select("ecommerce_video_mode", "视频模式", [{ value: "ad_video", label: "广告视频模式" }, { value: "seeding_video", label: "种草视频模式" }], { default: "ad_video", placement: "uploadTop" }),
          ...(seeding ? [select("ecommerce_seeding_template", "种草分镜模板", [
            { value: "", label: "请选择种草分镜模板" },
            { value: "template_b", label: "模板 B · 中心图窗 + 右侧讲述栏" },
            { value: "template_d", label: "模板 D · 左侧文案 + 右侧主视觉" },
            { value: "template_f", label: "模板 F · 近景主图 + 左侧信息栏" },
          ], { required: true, placement: "uploadTop" })] : []),
          file("product", seeding ? "商品主体图" : "产品图", "image/*", { required: true, multiple: true, maxFiles: 3, previewSlots: 3, help: seeding ? "上传 1-3 张商品主体、包装、细节或生活场景参考图" : "点击素材位逐个上传；最多保留 3 个素材位" }),
          file("model", "人物参考图", "image/*", { help: seeding ? "可选：上传 1 张人物参考图，用于约束人设、穿搭和镜头角色" : "可选：上传 1 张人物参考图" }),
          ...(seeding ? [file("video", "节奏参考视频", "video/*", { help: "可选：仅用于分析镜头节奏、构图和风格，不会直接作为最终画面" })] : []),
          file("audio", seeding ? "分享口播/参考人声" : "旁白/干音", "audio/*", { help: seeding ? "可选：选择预设声音试听，或上传自己的干音" : "可选：选择预设干音并试听，或上传自己的干音" }),
          text("product_name", seeding ? "产品/分享主题" : "产品名称", { placeholder: seeding ? "例如：东京租房 / 深海鱼油 / 夏日通勤穿搭" : "例如：EX31A 热水器" }),
          textarea("product_details", seeding ? "分享角度补充" : "产品相关简介", { placeholder: seeding ? "可选：补充真实体验、使用场景、目标人群、核心感受或分享角度" : "可选：补充产品卖点、适用人群、使用场景、价格/参数等详情", wide: true }),
          select("target_language", seeding ? "分享口播语言" : "台词/字幕语言", LANGUAGE_OPTIONS, { default: "Chinese", placement: "voice" }),
          number("duration", seeding ? "成片时长（秒，4~120）" : "视频时长（秒，4~120）", { default: 15, min: 4, max: 120, step: 1 }),
          select("ratio", seeding ? "成片比例" : "画面比例", VIDEO_RATIO_OPTIONS, { default: "9:16" }),
          select("resolution", seeding ? "输出分辨率" : "视频分辨率", VIDEO_RESOLUTION_OPTIONS, { default: "720p" }),
          ...(!seeding ? [
            select("ecommerce_short_video_model", "视频模型", [{ value: "seedance2.0", label: "Seedance2.0 标准版" }, { value: "seedance2.0fast", label: "Seedance2.0 Fast" }], { default: "seedance2.0" }),
            select("ecommerce_ad_style", "风格方向", VIDEO_STYLE_OPTIONS, { default: "standard_ecommerce" }),
          ] : []),
          textarea(seeding ? "copy_text" : "prompt_text", seeding ? "视频口播文案" : "视频提示词", { placeholder: seeding ? "生成后仅显示视频口播文案；完整分镜脚本由系统在后台用于生图和合成" : "请先点击生成提示词，确认后再生成视频", wide: true }),
        ];
      },
    },
    video_language_replace: {
      id: "video_language_replace",
      label: "视频语种更换",
      shortLabel: "语言替换",
      kicker: "VIDEO LOCALIZATION",
      description: "保留原视频节奏与画面，将口播替换为目标语言。",
      fields: [
        file("video", "原视频", "video/*", { required: true }),
        file("audio", "参考音频/干音", "audio/*", { help: "可选；用于目标语言配音" }),
        select("target_language", "目标语言", LANGUAGE_OPTIONS, { default: "English", placement: "voice" }),
        select("minimax_tts_model", "音频模型", RUNNINGHUB_SPEECH_MODEL_OPTIONS, { default: "speech-2.8-hd" }),
        textarea("script_text", "原文台词", { placeholder: "第一步会自动解析原视频台词和时间戳；如已手动填写且自带时间戳，会直接跳过这一步", wide: true }),
        textarea("opening_insert_text", "开场插入台词", { placeholder: "可选：在原视频第一句开始前额外插入一句台词", wide: true }),
        textarea("ending_insert_text", "结尾插入台词", { placeholder: "可选：在原视频最后一句之后额外插入一句台词", wide: true }),
      ],
    },
    video_subject_replace: {
      id: "video_subject_replace",
      label: "视频模特 / 商品替换",
      shortLabel: "视频换主体",
      kicker: "VIDEO SUBJECT",
      description: "保留原视频动作和镜头，替换人物、商品，或同时替换两者。",
      fields(values = {}) {
        const union = values.replace_mode === "union";
        return [
          select("replace_mode", "替换模式", [{ value: "model", label: "模特替换" }, { value: "product", label: "商品替换" }, { value: "union", label: "联合替换" }], { default: "model", placement: "uploadTop" }),
          file("video", "原视频", "video/*", { required: true }),
          ...(union
            ? [
                file("model", "目标人物/模特图", "image/*", { required: true }),
                file("product", "目标商品图", "image/*", { required: true }),
              ]
            : [file("image", values.replace_mode === "product" ? "目标商品图" : "目标人物/模特图", "image/*", { required: true, dynamicLabel: true })]),
        ];
      },
    },
    ecommerce_image: {
      id: "ecommerce_image",
      label: "电商广告图",
      shortLabel: "电商图片",
      kicker: "COMMERCE IMAGE",
      description: "从商品或模特参考图生成干净、统一的电商展示图。",
      fields: [
        file("product", "产品/详情图", "image/*", { required: true, multiple: true, maxFiles: 3, previewSlots: 3, help: "可上传产品主图、细节图、包装图或参数/卖点详情图" }),
        file("model", "模特图", "image/*", { help: "可选；上传后自动按模特图 + 商品图模式生成" }),
        text("product_name", "产品名称", { placeholder: "例如：公寓 / 鱼油 / 沙发 / 汽车" }),
        textarea("product_details", "产品相关简介", { placeholder: "可选：补充产品卖点、适用人群、使用场景、价格/参数等详情；不填则由 AI 根据图片判断", wide: true }),
        select("output_size", "输出规格", ["2K", "1K", "4K"], { default: "2K" }),
        select("nano_images", "生成张数", ["1", "2", "3", "4"], { default: "4" }),
      ],
    },
    subject_replace: {
      id: "subject_replace",
      label: "人物 / 商品替换",
      shortLabel: "图片换主体",
      kicker: "IMAGE SUBJECT",
      description: "替换图片中的人物或商品，同时保留原构图与光影关系。",
      fields: [
        file("original", "原始图片", "image/*", { required: true }),
        file("replacement_product", "商品图", "image/*"),
        file("replacement_model", "模特图", "image/*"),
        textarea("prompt", "替换要求", { default: "请根据原始图片和目标商品/人物图精准判断替换区域；只替换原图中对应的人物或商品主体，原图中的建筑、背景、光影、构图、招牌、Logo、包装文字、门头文字、海报文字和其他可读文字必须完整保留。", wide: true }),
      ],
    },
    poster_translate: {
      id: "poster_translate",
      label: "电商图语种切换",
      shortLabel: "海报翻译",
      kicker: "POSTER TRANSLATE",
      description: "识别海报文字并翻译，尽量保持原版式、字体层级与视觉节奏。",
      fields: [
        file("poster", "原始电商海报图", "image/*", { required: true }),
        select("target_language", "目标市场语言", LANGUAGE_OPTIONS, { default: "English" }),
      ],
    },
    subject_generate: {
      id: "subject_generate",
      label: "主体生成",
      shortLabel: "主体生成",
      kicker: "SUBJECT GENERATE",
      description: "根据参考图与描述生成可用于后续图片或视频制作的新主体。",
      fields(values = {}) {
        const product = values.subject_generate_mode === "product";
        return [
          select("subject_generate_mode", "生成模式", [{ value: "character", label: "数字人生成" }, { value: "product", label: "产品图生成" }], { default: "character", placement: "uploadFooter" }),
          ...(product ? [
            file("product", "产品角度图（最多3张）", "image/*", { required: true, multiple: true, minFiles: 1, maxFiles: 3, previewSlots: 3, previewLabels: ["角度一", "角度二（选填）", "角度三（选填）"] }),
            textarea("prompt", "补充要求", { placeholder: "可留空，例如：综合多个角度还原产品形态，保持包装细节，白底三视图", wide: true }),
          ] : [
            file("reference", "人设参考图（最多3张）", "image/*", { multiple: true, maxFiles: 3, previewSlots: 3, previewLabels: ["参考图/正面", "侧面（选填）", "背面（选填）"], help: "可上传 1 张人物参考图或 3 张人设三视图；上传后性别、年龄段、气质风格由参考图判断" }),
            select("digital_human_character_region", "地区特征", [{ value: "china", label: "中国" }, { value: "europe_america", label: "欧美" }, { value: "indonesia", label: "印尼" }, { value: "thailand", label: "泰国" }, { value: "japan", label: "日本" }, { value: "malaysia", label: "马来西亚" }], { default: "china" }),
            select("character_gender", "性别", [{ value: "", label: "自动" }, { value: "female", label: "女性" }, { value: "male", label: "男性" }], { default: "" }),
            select("character_age", "年龄段", [{ value: "", label: "自动" }, { value: "18_22", label: "18-22岁" }, { value: "23_27", label: "23-27岁" }, { value: "28_32", label: "28-32岁" }, { value: "33_38", label: "33-38岁" }, { value: "39_45", label: "39-45岁" }, { value: "46_55", label: "46-55岁" }, { value: "56_plus", label: "56岁以上" }], { default: "" }),
            select("character_hairstyle", "发型", CHARACTER_HAIRSTYLES[values.character_gender] || CHARACTER_HAIRSTYLES.default, { default: "" }),
            select("character_temperament", "气质风格", CHARACTER_TEMPERAMENTS[characterProfile(values)] || CHARACTER_TEMPERAMENTS.default, { default: "" }),
            select("character_clothing", "服装风格", CHARACTER_CLOTHING[characterProfile(values)] || CHARACTER_CLOTHING.default, { default: "" }),
            textarea("prompt", "补充特征", { placeholder: "可留空，例如：亲和笑容、商务穿搭、五官立体", wide: true }),
          ]),
        ];
      },
    },
  };

  const state = {
    active: false,
    initialized: false,
    moduleId: MODULE_ORDER[0],
    modules: MODULE_ORDER.map((id) => FALLBACK_MODULES[id]),
    runtimeDefaults: {},
    moduleLoading: false,
    moduleError: "",
    moduleEmpty: false,
    tasks: [],
    taskLoading: false,
    taskError: "",
    taskWarning: "",
    taskPage: 1,
    taskMedia: {},
    taskMediaResolved: {},
    taskMediaLoading: {},
    submitError: "",
    submitting: false,
    promptGenerating: false,
    drafts: {},
    files: {},
    voicePresets: [],
    voiceLoading: false,
    voiceLoaded: false,
    voiceError: "",
    playingVoiceId: "",
    voiceRefreshToken: 0,
    voiceModalOpen: false,
    subtitleModalTaskId: "",
    subtitleTemplate: "split_hook",
    subtitleSubmitting: false,
    subtitleError: "",
    imagePreview: null,
    imageHistoryOpen: false,
    assetPickerField: "",
    fusionViewBusy: {},
    fusionHistory: {},
    workflowBusy: {},
    seedingSceneBusy: {},
    seedingHistory: {},
    advancedBusy: "",
    timer: 0,
    requestToken: 0,
    filesRestored: false,
  };
  const submittedTaskMonitors = new Map();
  const localFilePreviewUrls = new Map();
  const FILE_DRAFT_DB_NAME = "wk-video-workbench-files-v1";
  const FILE_DRAFT_STORE = "files";
  let fileDraftDbPromise = null;

  function openFileDraftDb() {
    if (!window.indexedDB) return Promise.resolve(null);
    if (fileDraftDbPromise) return fileDraftDbPromise;
    fileDraftDbPromise = new Promise((resolve) => {
      const request = window.indexedDB.open(FILE_DRAFT_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(FILE_DRAFT_STORE)) db.createObjectStore(FILE_DRAFT_STORE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    return fileDraftDbPromise;
  }

  function fileDraftPrefix(moduleId = "") {
    return `${draftScope()}:${String(moduleId || "")}:`;
  }

  async function persistFileSlots(moduleId, fieldKey, slots) {
    const db = await openFileDraftDb();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(FILE_DRAFT_STORE, "readwrite");
      const store = tx.objectStore(FILE_DRAFT_STORE);
      const prefix = `${fileDraftPrefix(moduleId)}${String(fieldKey)}:`;
      const keysRequest = store.getAllKeys();
      keysRequest.onsuccess = () => {
        keysRequest.result.filter((key) => String(key).startsWith(prefix)).forEach((key) => store.delete(key));
        (slots || []).forEach((file, index) => {
          if (!file) return;
          store.put({
            key: `${prefix}${index}`,
            scope: draftScope(),
            moduleId,
            fieldKey,
            slotIndex: index,
            name: String(file.name || `file-${index + 1}`),
            type: String(file.type || "application/octet-stream"),
            lastModified: Number(file.lastModified || Date.now()),
            blob: file,
          });
        });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  }

  async function clearPersistedModuleFiles(moduleId) {
    const db = await openFileDraftDb();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(FILE_DRAFT_STORE, "readwrite");
      const store = tx.objectStore(FILE_DRAFT_STORE);
      const request = store.getAllKeys();
      const prefix = fileDraftPrefix(moduleId);
      request.onsuccess = () => request.result.filter((key) => String(key).startsWith(prefix)).forEach((key) => store.delete(key));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  }

  async function restorePersistedFiles() {
    if (state.filesRestored) return;
    state.filesRestored = true;
    const db = await openFileDraftDb();
    if (!db) return;
    const records = await new Promise((resolve) => {
      const tx = db.transaction(FILE_DRAFT_STORE, "readonly");
      const request = tx.objectStore(FILE_DRAFT_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });
    for (const item of records) {
      if (String(item?.scope || "") !== draftScope() || !MODULE_ORDER.includes(String(item?.moduleId || "")) || !item?.blob) continue;
      const moduleId = String(item.moduleId);
      const fieldKey = String(item.fieldKey || "");
      const slotIndex = Math.max(Number(item.slotIndex) || 0, 0);
      state.files[moduleId] ||= {};
      state.files[moduleId][fieldKey] ||= [];
      state.files[moduleId][fieldKey][slotIndex] = new File([item.blob], String(item.name || "restored-file"), {
        type: String(item.type || item.blob.type || "application/octet-stream"),
        lastModified: Number(item.lastModified || Date.now()),
      });
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character]));
  }

  function videoErrorMessage(error, fallback = "操作失败，请稍后重试。") {
    const localized = window.VectoPublicPrompt?.localizeError?.(error, fallback);
    if (localized) return localized;
    const raw = String(error?.message || "").trim();
    if (/failed to fetch|networkerror/i.test(raw)) return "网络连接失败：请检查网络后重试。";
    if (/timeout|timed out|超时/i.test(raw)) return "处理超时：任务可能仍在后台运行，请稍后查看任务列表。";
    return raw && /[\u4e00-\u9fff]/.test(raw) ? raw : fallback;
  }

  const VIDEO_PROGRESS_STEP_DEFINITIONS = [
    { key: "prepare", label: "准备", description: "校验素材和参数" },
    { key: "prompt", label: "文案", description: "确认口播与画面提示" },
    { key: "submit", label: "提交", description: "创建服务器任务" },
    { key: "generate", label: "生成", description: "生成画面与语音" },
    { key: "compose", label: "合成", description: "合成最终视频" },
    { key: "archive", label: "归档", description: "同步到视频记录" },
  ];

  const VIDEO_PROGRESS_MODULE_COPY = {
    digital_human_video: {
      name: "数字人口播视频",
      prepare: ["素材", "校验人物、产品图与参考音频"],
      prompt: ["口播/分镜", "确认口播文案和分镜方式"],
      submit: ["提交", "创建数字人口播任务"],
      generate: ["生成", "生成数字人画面与配音"],
      compose: ["合成", "合成最终数字人口播视频"],
      archive: ["归档", "同步数字人视频记录"],
    },
    ecommerce_short_video: {
      name: "广告短视频",
      prepare: ["素材", "校验商品、人物和参考素材"],
      prompt: ["脚本/提示词", "确认广告脚本和画面提示"],
      submit: ["提交", "创建广告短视频任务"],
      generate: ["生成", "生成画面、音频和分镜片段"],
      compose: ["合成", "合成最终广告短视频"],
      archive: ["归档", "同步广告短视频记录"],
    },
    video_language_replace: {
      name: "视频语种更换",
      prepare: ["准备", "校验源视频和目标语言"],
      prompt: ["台词", "解析并确认原视频台词"],
      submit: ["提交", "创建语音替换任务"],
      generate: ["配音", "生成目标语言音频"],
      compose: ["替换", "合成替换后的音轨"],
      archive: ["归档", "同步语种更换结果"],
    },
    video_subject_replace: {
      name: "视频模特/商品替换",
      prepare: ["素材", "校验源视频和替换素材"],
      prompt: ["方案", "确认替换对象和处理参数"],
      submit: ["提交", "创建视频替换任务"],
      generate: ["处理", "生成替换后的视频片段"],
      compose: ["合成", "合并替换后的视频"],
      archive: ["归档", "同步视频替换记录"],
    },
    ecommerce_image: {
      name: "电商广告图",
      prepare: ["素材", "校验商品和人物参考图"],
      prompt: ["画面方案", "确认商品广告画面参数"],
      submit: ["提交", "创建电商广告图任务"],
      generate: ["生图", "生成商品广告图片"],
      compose: ["处理", "整理并校验生成图片"],
      archive: ["归档", "同步图片素材记录"],
    },
    subject_replace: {
      name: "图片主体替换",
      prepare: ["素材", "校验原图和替换主体"],
      prompt: ["方案", "确认主体替换参数"],
      submit: ["提交", "创建图片替换任务"],
      generate: ["生图", "生成替换后的图片"],
      compose: ["处理", "整理生成结果"],
      archive: ["归档", "同步图片记录"],
    },
    poster_translate: {
      name: "海报翻译",
      prepare: ["素材", "校验海报和目标语言"],
      prompt: ["版式", "确认翻译文本和版式参数"],
      submit: ["提交", "创建海报翻译任务"],
      generate: ["翻译", "生成目标语言海报"],
      compose: ["处理", "校验翻译后的版式"],
      archive: ["归档", "同步海报素材记录"],
    },
    subject_generate: {
      name: "主体生成",
      prepare: ["素材", "校验生成方向和参考素材"],
      prompt: ["方案", "确认主体生成提示词"],
      submit: ["提交", "创建主体生成任务"],
      generate: ["生图", "生成主体图片"],
      compose: ["处理", "整理生成结果"],
      archive: ["归档", "同步主体素材记录"],
    },
  };

  function videoProgressInput(context = {}) {
    const taskInput = context?.task?.input && typeof context.task.input === "object" ? context.task.input : {};
    const values = context?.values && typeof context.values === "object" ? context.values : {};
    const eventData = context?.progressEvent?.data && typeof context.progressEvent.data === "object" ? context.progressEvent.data : {};
    return { ...eventData, ...values, ...taskInput };
  }

  function videoProgressModuleId(context = {}) {
    const task = context?.task && typeof context.task === "object" ? context.task : {};
    const fallback = String(context?.moduleId || state.moduleId || "").trim();
    const candidate = String(
      context?.moduleId
      || task.moduleId
      || task.video_module
      || task.module
      || task.module_id
      || "",
    ).trim();
    if (MODULE_ORDER.includes(candidate)) return candidate;
    if (candidate === "create_video") return "digital_human_video";
    if (candidate === "image_generate") return fallback === "subject_generate" ? fallback : "ecommerce_image";
    if (["replace_model", "replace_product", "replace_productANDmodel"].includes(candidate)) return "video_subject_replace";
    return MODULE_ORDER.includes(fallback) ? fallback : "digital_human_video";
  }

  function videoProgressModuleCopy(context = {}) {
    const moduleId = videoProgressModuleId(context);
    const input = videoProgressInput(context);
    const source = VIDEO_PROGRESS_MODULE_COPY[moduleId] || VIDEO_PROGRESS_MODULE_COPY.digital_human_video;
    if (moduleId === "ecommerce_short_video" && String(input.ecommerce_video_mode || "") === "seeding_video") {
      return {
        ...source,
        name: "种草视频",
        prompt: ["分享脚本", "确认种草口播和分镜方案"],
        submit: ["提交", "创建种草视频任务"],
        generate: ["分镜生成", "生成口播音频和种草分镜"],
        compose: ["合成", "合成最终种草视频"],
        archive: ["归档", "同步种草视频记录"],
      };
    }
    return source;
  }

  function videoProgressSegments(context = {}) {
    const task = context?.task && typeof context.task === "object" ? context.task : {};
    const input = videoProgressInput(context);
    const progressEvent = context?.progressEvent && typeof context.progressEvent === "object" ? context.progressEvent : {};
    const eventData = progressEvent.data && typeof progressEvent.data === "object" ? progressEvent.data : {};
    const output = taskOutput(task);
    const raw = output?.raw_result && typeof output.raw_result === "object" ? output.raw_result : {};
    const checkpoint = output?.video_checkpoint && typeof output.video_checkpoint === "object" ? output.video_checkpoint : {};
    const candidates = [
      context?.segmentCount,
      task.segment_count,
      task.segmentCount,
      task.input?.segment_count,
      output.segment_count,
      raw.segment_count,
      checkpoint.segment_count,
      progressEvent.segmentCount,
      eventData.segment_count,
      eventData.segmentCount,
    ];
    let count = candidates.map((value) => Number(value)).find((value) => Number.isInteger(value) && value > 0) || 0;
    const planned = [
      task.segments,
      task.storyboard?.items,
      task.segment_scripts,
      task.prompt_segments,
      checkpoint.segment_scripts,
      eventData.segments,
      eventData.segment_scripts,
      eventData.prompt_segments,
    ]
      .find((value) => Array.isArray(value) && value.length) || [];
    const completed = [task.completed_segments, eventData.completed_segments, eventData.completedSegments]
      .find((value) => Array.isArray(value)) || [];
    if (!count && planned.length > 1) count = planned.length;
    if (!count && completed.length > 1) count = completed.length;
    const completedIndices = new Set(
      completed.map((item, index) => Number(item?.index ?? item?.segment_index ?? index + 1))
        .filter((value) => Number.isInteger(value) && value > 0),
    );
    const moduleId = videoProgressModuleId(context);
    const inputMode = String(input.digital_human_content_mode || "").trim();
    const isOral = moduleId === "digital_human_video" && inputMode === "oral_broadcast";
    return {
      count,
      completedIndices,
      isOral,
      isMulti: count > 1,
      mode: String(input.digital_human_short_mode || "").trim().toLowerCase(),
    };
  }

  function videoProgressStageFromName(value, fallback = "generate") {
    const stage = String(value || "").trim().toLowerCase();
    if (!stage) return fallback;
    if (["queued", "pending", "submitted", "queue", "start"].includes(stage)) return "submit";
    if (stage === "finished" || stage === "complete" || stage === "completed") return "compose";
    if (stage.includes("script") || stage.includes("prompt") || stage.includes("copy") || stage.includes("transcrib")) return "prompt";
    if (stage.includes("merge") || stage.includes("subtitle") || stage.includes("final") || stage.includes("concat") || stage.includes("compose") || stage.includes("render")) return "compose";
    if (stage.includes("archive") || stage.includes("record")) return "archive";
    if (stage.includes("adapter")) return "submit";
    return "generate";
  }

  function videoProgressStageFromTask(task, fallback = "generate", progressEvent = null) {
    const output = taskOutput(task);
    const raw = output?.raw_result && typeof output.raw_result === "object" ? output.raw_result : {};
    const checkpoint = output?.video_checkpoint && typeof output.video_checkpoint === "object" ? output.video_checkpoint : {};
    const eventData = progressEvent?.data && typeof progressEvent.data === "object" ? progressEvent.data : {};
    const stage = progressEvent?.stage
      || task?.progress_stage
      || task?.stage
      || task?.phase
      || task?.video_stage
      || raw.digital_human_stage
      || raw.seeding_stage
      || checkpoint.stage
      || "";
    if (String(stage).trim().toLowerCase() === "visual_review" || String(stage).trim().toLowerCase() === "images_only") return "compose";
    if (eventData.stage && !progressEvent?.stage) return videoProgressStageFromName(eventData.stage, fallback);
    return videoProgressStageFromName(stage, fallback);
  }

  function videoProgressMessage(monitor, task, stage, status) {
    const context = { moduleId: monitor?.moduleId, values: monitor?.values, task };
    const copy = videoProgressModuleCopy(context);
    const segments = videoProgressSegments(context);
    const event = monitor?.latestProgress;
    const eventStage = String(event?.stage || "").toLowerCase();
    const completedCount = segments.completedIndices.size;
    const eventIndex = Number(event?.segmentIndex || event?.data?.segment_index || event?.data?.segmentIndex || 0);
    if (["queued", "pending", "submitted"].includes(String(status || "").toLowerCase())) {
      return `${copy.name}任务已提交，正在排队等待生成服务…`;
    }
    if (segments.isMulti && (eventStage.includes("segment") || eventStage.includes("video") || stage === "generate")) {
      const current = Math.min(Math.max(eventIndex || completedCount + 1, 1), segments.count);
      return `${copy.name}正在生成第 ${current}/${segments.count} 段${segments.isOral ? "口播" : "画面与音频"}…`;
    }
    if (segments.isOral && stage === "generate") return `${copy.name}正在生成单段口播画面与音频…`;
    if (stage === "prompt") return `${copy.name}正在整理${segments.isOral ? "口播文案" : "文案和画面提示"}…`;
    if (stage === "submit") return `${copy.name}正在创建服务器任务…`;
    if (stage === "compose") return `${copy.name}正在合成最终结果…`;
    if (stage === "archive") return `${copy.name}已生成，正在同步结果记录…`;
    return `${copy.name}${copy[stage]?.[0] || "生成"}处理中…`;
  }

  function videoProgressSteps(stage = "prepare", context = {}) {
    const requested = String(stage || "prepare").trim().toLowerCase();
    const copy = videoProgressModuleCopy(context);
    const definitions = VIDEO_PROGRESS_STEP_DEFINITIONS.map((step) => {
      const replacement = copy[step.key];
      return replacement ? { ...step, label: replacement[0], description: replacement[1] } : { ...step };
    });
    const forceComplete = requested === "complete";
    const errorIndex = requested === "error"
      ? definitions.findIndex((step) => step.key === "generate")
      : -1;
    const activeIndex = errorIndex >= 0
      ? errorIndex
      : Math.max(0, definitions.findIndex((step) => step.key === requested));
    const steps = definitions.map((step, index) => ({
      ...step,
      status: forceComplete
        ? "complete"
        : errorIndex >= 0
        ? (index < activeIndex ? "complete" : index === activeIndex ? "error" : "pending")
        : (index < activeIndex ? "complete" : index === activeIndex ? "active" : "pending"),
    }));
    const segments = videoProgressSegments(context);
    if (!segments.isMulti) {
      if (segments.isOral) {
        const generate = steps.find((step) => step.key === "generate");
        if (generate) {
          generate.label = "单段口播";
          generate.description = "生成单段口播画面与配音";
        }
      }
      return steps;
    }
    const stageIsComplete = ["compose", "archive", "complete"].includes(requested);
    const nextIndex = Math.min(Math.max(segments.completedIndices.size + 1, 1), segments.count);
    const segmentLabel = segments.isOral ? "口播" : (videoProgressModuleId(context) === "ecommerce_short_video" ? "分镜" : "片段");
    const segmentSteps = Array.from({ length: segments.count }, (_, offset) => {
      const index = offset + 1;
      const complete = stageIsComplete || segments.completedIndices.has(index);
      const active = !complete && requested === "generate" && index === nextIndex;
      return {
        key: `segment-${index}`,
        label: `${segmentLabel} ${index}/${segments.count}`,
        description: complete ? "已完成" : active ? "正在处理" : "等待处理",
        status: errorIndex >= 0 && active ? "error" : complete ? "complete" : active ? "active" : "pending",
      };
    });
    const generateIndex = steps.findIndex((step) => step.key === "generate");
    if (generateIndex >= 0) {
      steps[generateIndex].label = segments.isOral ? "多段口播" : "分段生成";
      steps[generateIndex].description = segments.isOral
        ? `按 ${segments.count} 段口播依次生成`
        : `按 ${segments.count} 个片段依次生成`;
      steps.splice(generateIndex + 1, 0, ...segmentSteps);
    }
    return steps;
  }

  function progressStepsForMonitor(monitor, stage = monitor?.stage || "generate", task = monitor?.task || null) {
    return videoProgressSteps(stage, {
      moduleId: monitor?.moduleId,
      values: monitor?.values,
      task,
      progressEvent: monitor?.latestProgress,
    });
  }

  function openVideoProgress(title, messages, options = {}) {
    const promptOptions = options && typeof options === "object" ? options : {};
    const stage = String(promptOptions.stage || "prepare");
    const progressContext = promptOptions.progressContext && typeof promptOptions.progressContext === "object"
      ? promptOptions.progressContext
      : {};
    return window.VectoPublicPrompt?.open?.({
      ...promptOptions,
      title,
      message: Array.isArray(messages) ? messages[0] : messages,
      messages,
      steps: promptOptions.steps || videoProgressSteps(stage, {
        moduleId: promptOptions.moduleId || progressContext.moduleId,
        values: promptOptions.values || progressContext.values,
        task: progressContext.task,
      }),
      status: "progress",
      busy: true,
      rotateMessages: false,
      allowMinimize: true,
      showClose: false,
      showConfirm: false,
      showCancel: false,
      dismissOnBackdrop: false,
      dismissOnEscape: false,
    }) || null;
  }

  function showVideoError(error, fallback, title = "操作失败", existingPrompt = null) {
    const message = videoErrorMessage(error, fallback);
    const code = String(error?.payload?.detail?.code || error?.payload?.code || error?.code || "").trim().toUpperCase();
    if (Number(error?.status) === 402 || code === "INSUFFICIENT_POINTS") {
      window.VectoPublicPrompt?.showInsufficientPoints?.(existingPrompt);
      return message;
    }
    if (existingPrompt?.isOpen?.()) {
      existingPrompt.update({
        title,
        message,
        detail: "请根据提示处理后重新尝试。",
        status: "error",
        busy: false,
        messages: [message],
        steps: videoProgressSteps("error"),
        showClose: true,
        showConfirm: false,
        showCancel: false,
      });
    } else {
      window.VectoPublicPrompt?.showError?.({ title, message, error });
    }
    return message;
  }

  function updateVideoSuccess(prompt, title, message, detail = "", actions = []) {
    if (prompt?.isOpen?.()) {
      prompt.update({
        title,
        message,
        detail,
        status: "success",
        busy: false,
        messages: [message],
        steps: videoProgressSteps("complete"),
        showClose: true,
        showConfirm: false,
        showCancel: false,
        actions: Array.isArray(actions) ? actions : [],
      });
    }
  }

  function taskIdFromResponse(payload) {
    return String(payload?.id || payload?.task_id || payload?.task?.id || payload?.task?.task_id || "").trim();
  }

  function videoModuleForTask(task, fallback = "") {
    const candidate = String(task?.moduleId || task?.video_module || task?.module || fallback || "").trim();
    return MODULE_ORDER.includes(candidate) ? candidate : fallback;
  }

  function taskNeedsVisualConfirmation(task) {
    const digitalStage = digitalHumanStageFromTask(task);
    if (digitalStage === "visual_review" || digitalStage === "digital_human_visual_review") return "digital-human";
    const seedingStage = seedingStageFromTask(task);
    return seedingStage === "images_only" ? "seeding" : "";
  }

  function dispatchVideoTaskEvent(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
  }

  function openVideoTaskWorkbench(moduleId) {
    const target = videoModuleForTask({ moduleId }, state.moduleId) || state.moduleId;
    void window.VideoPage?.navigate?.(target);
    window.setTimeout(() => document.querySelector("#videoWorkbenchRoot .video-task-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 250);
  }

  function openVideoTaskRecords() {
    void window.VideoPage?.navigate?.("video_editor", { tab: "records" });
  }

  function taskExpectsVideoRecord(task) {
    const type = String(task?.type || task?.task_type || task?.moduleId || "").trim();
    return VIDEO_OUTPUT_TASK_TYPES.has(type) || ["digital_human_video", "ecommerce_short_video", "video_language_replace"].includes(String(task?.moduleId || ""));
  }

  async function generatedRecordExists(taskId) {
    try {
      const payload = await request("/api/video/editor/assets?page=1&page_size=100&sync_generated=true&source_type=generated");
      return (Array.isArray(payload?.items) ? payload.items : []).some((item) => String(item?.source_task_id || "") === String(taskId || ""));
    } catch (_) {
      return null;
    }
  }

  function normalizeVideoProgressEvent(payload) {
    const source = payload && typeof payload === "object" ? payload : {};
    const data = source.data && typeof source.data === "object" ? source.data : {};
    const nested = data.data && typeof data.data === "object" ? data.data : {};
    return {
      id: Number(source.id || 0),
      stage: String(data.stage || nested.stage || source.stage || "").trim(),
      state: String(data.state || nested.state || source.state || data.status || "").trim().toLowerCase(),
      message: String(source.message || data.status || nested.status || source.status || "").trim(),
      progress: Number(data.progress ?? nested.progress ?? source.progress ?? 0),
      segmentIndex: Number(data.segment_index ?? nested.segment_index ?? source.segment_index ?? 0),
      data: { ...data, ...nested },
    };
  }

  function monitorProgressStage(monitor, task) {
    return videoProgressStageFromTask(task, monitor?.stage || "generate", monitor?.latestProgress);
  }

  function updateSubmittedTaskPrompt(monitor, task) {
    if (!monitor.prompt?.isOpen?.()) return;
    const status = String(task?.status || "queued").toLowerCase();
    const progress = Math.max(0, Math.min(100, Number(task?.progress || 0)));
    const statusText = statusCopy(status, task);
    const taskLabel = monitor.taskId ? `任务编号：${monitor.taskId}` : "任务编号正在分配";
    monitor.stage = status === "queued" || status === "pending" ? "submit" : monitorProgressStage(monitor, task);
    const context = { moduleId: monitor.moduleId, values: monitor.values, task };
    const copy = videoProgressModuleCopy(context);
    const messages = [videoProgressMessage(monitor, task, monitor.stage, status)];
    const eventMessage = String(monitor.latestProgress?.message || "").trim();
    const detailMessage = /[\u4e00-\u9fff]/.test(eventMessage) ? eventMessage : "";
    const stageDescription = copy[monitor.stage]?.[1] || "系统会持续同步任务状态";
    const segmentInfo = videoProgressSegments(context);
    monitor.task = task;
    monitor.prompt.update({
      title: `${copy.name}任务${statusText}`,
      message: messages[0],
      detail: `${taskLabel}${progress > 0 ? ` · 当前进度约 ${progress}%` : ""} · ${detailMessage || stageDescription}${segmentInfo.isMulti ? ` · 已完成 ${segmentInfo.completedIndices.size}/${segmentInfo.count} 段` : ""}`,
      status: "progress",
      busy: true,
      messages,
      steps: progressStepsForMonitor(monitor, monitor.stage, task),
      showClose: false,
      showConfirm: false,
      showCancel: false,
      actions: [],
    });
  }

  async function submitVisualFinalizeTask(taskId, kind, progress, moduleId, label = "最终视频", options = {}) {
    const id = String(taskId || "").trim();
    if (!id) throw new Error("缺少待确认的源任务编号，无法继续生成视频。");
    const suffix = kind === "seeding" ? "seeding/finalize" : "digital-human/finalize";
    const result = await request(`/api/video/tasks/${encodeURIComponent(id)}/${suffix}`, { method: "POST" });
    await loadTasks({ quiet: true });
    const childTaskId = taskIdFromResponse(result);
    if (childTaskId) {
      monitorSubmittedTask(childTaskId, progress, moduleId, label, options.monitorContext || {});
      return childTaskId;
    }
    if (options.requireTaskId) {
      const missingTaskId = new Error("服务器未返回最终视频任务编号，暂时无法自动追踪生成进度。");
      missingTaskId.code = "VIDEO_FINAL_TASK_ID_MISSING";
      throw missingTaskId;
    }
    updateVideoSuccess(
      progress,
      "视频任务已提交",
      "视频生成任务已提交，系统正在处理。",
      `源任务编号：${id}。请在任务动态查看进度。`,
      [{
        value: "view-workbench",
        text: "查看任务动态",
        primary: true,
        onSelect: () => openVideoTaskWorkbench(moduleId),
      }],
    );
    return "";
  }

  function monitorSubmittedTask(taskId, prompt, moduleId = "", label = "视频", options = {}) {
    const cleanId = String(taskId || "").trim();
    if (!cleanId) return;
    const existing = submittedTaskMonitors.get(cleanId);
    if (existing) {
      existing.prompt = prompt || existing.prompt;
      return;
    }
    const monitor = {
      taskId: cleanId,
      prompt,
      moduleId: String(moduleId || state.moduleId || ""),
      label: String(label || "视频"),
      values: options?.values && typeof options.values === "object" ? { ...options.values } : {},
      startedAt: Date.now(),
      timer: 0,
      done: false,
      archiveAttempts: 0,
      stage: "submit",
      task: null,
      latestProgress: null,
      eventSource: null,
    };
    submittedTaskMonitors.set(cleanId, monitor);
    const finish = () => {
      monitor.done = true;
      if (monitor.timer) window.clearTimeout(monitor.timer);
      monitor.timer = 0;
      if (monitor.eventSource) monitor.eventSource.close();
      monitor.eventSource = null;
      submittedTaskMonitors.delete(cleanId);
    };
    const schedule = () => {
      if (!monitor.done) monitor.timer = window.setTimeout(() => { void poll(); }, TASK_MONITOR_INTERVAL_MS);
    };
    const startEventStream = () => {
      if (monitor.done || monitor.eventSource || typeof window.EventSource !== "function") return;
      const source = new window.EventSource(`/api/tasks/${encodeURIComponent(cleanId)}/events`);
      monitor.eventSource = source;
      source.addEventListener("progress", (event) => {
        if (monitor.done) return;
        try {
          const payload = JSON.parse(String(event.data || "{}"));
          const progressEvent = normalizeVideoProgressEvent(payload);
          if (progressEvent.id) monitor.lastEventId = progressEvent.id;
          monitor.latestProgress = progressEvent;
          if (progressEvent.state === "failed" || progressEvent.state === "success") {
            void poll();
            return;
          }
          const task = monitor.task || { id: cleanId, status: "running", moduleId: monitor.moduleId };
          monitor.stage = monitorProgressStage(monitor, task);
          updateSubmittedTaskPrompt(monitor, task);
        } catch (_) {}
      });
      source.addEventListener("done", () => { void poll(); });
      source.onerror = () => {
        if (monitor.eventSource === source) monitor.eventSource = null;
        source.close();
      };
    };
    const poll = async () => {
      if (monitor.done) return;
      if (Date.now() - monitor.startedAt > TASK_MONITOR_TIMEOUT_MS) {
        monitor.prompt?.update?.({
          title: `${monitor.label}任务响应时间较长`,
          message: "任务仍未返回最终状态，后台可能仍在处理。",
          detail: `${cleanId}。请稍后到任务动态查看，或刷新页面重试。`,
          status: "warning",
          busy: false,
          messages: ["任务仍未返回最终状态，后台可能仍在处理。"],
          steps: progressStepsForMonitor(monitor, "error"),
          showClose: true,
          actions: [{ value: "view-workbench", text: "查看任务动态", primary: true, onSelect: () => openVideoTaskWorkbench(monitor.moduleId) }],
          showConfirm: false,
          showCancel: false,
        });
        finish();
        return;
      }
      try {
        await loadTasks({ quiet: true });
        const task = state.tasks.find((item) => item.id === cleanId && item.source === "video")
          || state.tasks.find((item) => item.id === cleanId);
        if (!task) {
          monitor.stage = "submit";
          const copy = videoProgressModuleCopy({ moduleId: monitor.moduleId, values: monitor.values });
          monitor.prompt?.update?.({
            title: `${copy.name}任务已提交`,
            message: `${copy.name}任务已提交，正在等待服务器接收…`,
            detail: `任务编号：${cleanId}。系统会自动重试查询，不会丢失。`,
            status: "progress",
            busy: true,
            messages: [`${copy.name}任务已提交，正在等待服务器接收…`],
            steps: progressStepsForMonitor(monitor, monitor.stage),
            showClose: false,
            showConfirm: false,
            showCancel: false,
            actions: [],
          });
          schedule();
          return;
        }
        monitor.task = task;
        const status = String(task.status || "").toLowerCase();
        if (["failed", "error", "cancelled", "canceled"].includes(status)) {
          showVideoError(
            { message: task.error || `${monitor.label}任务执行失败。` },
            `${monitor.label}任务执行失败：请根据任务详情处理后重试。`,
            `${monitor.label}生成失败`,
            monitor.prompt,
          );
          dispatchVideoTaskEvent("vecto:video-task-finished", { taskId: cleanId, status, moduleId: monitor.moduleId, error: task.error || "" });
          finish();
          return;
        }
        const reviewKind = taskNeedsVisualConfirmation(task);
        if (["success", "completed", "finished"].includes(status) && reviewKind) {
          const isDigitalHuman = reviewKind === "digital-human";
          monitor.stage = "compose";
          if (monitor.finalizePromise) {
            await monitor.finalizePromise;
            return;
          }
          const finalModuleId = videoModuleForTask(task, monitor.moduleId);
          const finalCopy = videoProgressModuleCopy({ moduleId: finalModuleId, values: monitor.values, task });
          monitor.prompt?.update?.({
            title: `正在自动合成${finalCopy.name}`,
            message: `${finalCopy.name}画面已生成，系统正在自动确认并合成最终视频…`,
            detail: `任务编号：${cleanId}。无需人工点击，系统会自动提交最终视频并继续追踪。`,
            status: "progress",
            busy: true,
            messages: [`${finalCopy.name}画面已生成，系统正在自动确认并合成最终视频…`],
            steps: progressStepsForMonitor(monitor, "compose", task),
            showClose: false,
            showConfirm: false,
            showCancel: false,
            actions: [],
          });
          dispatchVideoTaskEvent("vecto:video-task-stage", { taskId: cleanId, status, stage: "auto_finalizing", sourceStage: reviewKind, moduleId: finalModuleId });
          monitor.finalizePromise = (async () => {
            try {
              await submitVisualFinalizeTask(cleanId, reviewKind, monitor.prompt, finalModuleId, "最终视频", {
                requireTaskId: true,
                monitorContext: { values: monitor.values },
              });
              finish();
            } catch (error) {
              showVideoError(
                error,
                "画面已生成，但自动合成最终视频失败：请检查素材和算力余额后重试。",
                "自动合成最终视频失败",
                monitor.prompt,
              );
              finish();
            }
          })();
          await monitor.finalizePromise;
          return;
        }
        if (["success", "completed", "finished"].includes(status)) {
          const archived = taskExpectsVideoRecord(task) ? await generatedRecordExists(cleanId) : true;
          if (archived !== true) {
            monitor.archiveAttempts += 1;
            if (monitor.archiveAttempts <= 5) {
              monitor.stage = "archive";
              const copy = videoProgressModuleCopy({ moduleId: monitor.moduleId, values: monitor.values, task });
              monitor.prompt?.update?.({
                title: `${copy.name}已生成，正在同步记录`,
                message: `${copy.name}已成功返回，系统正在自动同步到记录…`,
                detail: `任务编号：${cleanId}。正在进行第 ${monitor.archiveAttempts} 次同步校验，无需人工操作。`,
                status: "progress",
                busy: true,
                messages: [`${copy.name}已成功返回，系统正在自动同步到记录…`],
                steps: progressStepsForMonitor(monitor, monitor.stage, task),
                showClose: false,
                showConfirm: false,
                showCancel: false,
                actions: [],
              });
              schedule();
              return;
            }
            monitor.prompt?.update?.({
              title: "视频任务已完成，记录同步中",
              message: "视频已成功返回，但暂未出现在视频记录中。",
              detail: `任务编号：${cleanId}。系统已自动重试 ${monitor.archiveAttempts} 次，记录服务仍未返回该视频，请稍后刷新视频记录。`,
              status: "warning",
              busy: false,
              messages: ["视频已成功返回，但暂未出现在视频记录中。"],
              steps: progressStepsForMonitor(monitor, "archive", task).map((step) => ({
                ...step,
                status: step.key === "archive" ? "error" : step.status,
              })),
              showClose: true,
              showConfirm: false,
              showCancel: false,
              actions: [{ value: "view-records", text: "查看视频记录", primary: true, onSelect: openVideoTaskRecords }],
            });
          } else {
            monitor.stage = "complete";
            const copy = videoProgressModuleCopy({ moduleId: monitor.moduleId, values: monitor.values, task });
            monitor.prompt?.update?.({
              title: `${copy.name}生成完成`,
              message: `${copy.name}已生成并同步到视频记录。`,
              detail: `任务编号：${cleanId}。可在视频记录中预览、下载或继续剪辑。`,
              status: "success",
              busy: false,
              messages: [`${copy.name}已生成并同步到视频记录。`],
              steps: progressStepsForMonitor(monitor, monitor.stage, task),
              showClose: true,
              showConfirm: false,
              showCancel: false,
              actions: [{ value: "view-records", text: "打开视频记录", primary: true, onSelect: openVideoTaskRecords }],
            });
          }
          dispatchVideoTaskEvent("vecto:video-task-finished", { taskId: cleanId, status, moduleId: videoModuleForTask(task, monitor.moduleId), archived });
          finish();
          return;
        }
        updateSubmittedTaskPrompt(monitor, task);
      } catch (error) {
        monitor.prompt?.update?.({
          title: `${monitor.label}任务同步中`,
          message: "暂时无法读取最新状态，系统正在自动重试…",
          detail: `${cleanId}。网络恢复后会继续更新，不需要重复提交。`,
          status: "progress",
          busy: true,
          messages: ["暂时无法读取最新状态，系统正在自动重试…", "正在重新连接任务服务…", "不会重复扣除本次任务的算力点…"],
          steps: progressStepsForMonitor(monitor, monitor.stage || "generate", monitor.task),
          showClose: false,
          showConfirm: false,
          showCancel: false,
          actions: [],
        });
      }
      schedule();
    };
    startEventStream();
    void poll();
  }

  async function confirmVideoSubmit(module) {
    const message = "请确认当前输入内容无误，确认后系统会提交生成任务并扣除相应算力点。";
    if (window.VectoPublicPrompt?.confirm) {
      return window.VectoPublicPrompt.confirm({ title: `确认${submitButtonLabel(module)}吗？`, message });
    }
    state.submitError = "页面提示组件加载失败：请刷新页面后再提交生成任务。";
    render();
    return false;
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
      if (response.status === 401 && /video\.html$/.test(window.location.pathname)) {
        const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        window.location.replace(`/video-login.html?return_url=${encodeURIComponent(here)}`);
      }
      const code = String(payload?.detail?.code || payload?.code || "").trim();
      if (response.status === 402 && code === "INSUFFICIENT_POINTS") {
        window.dispatchEvent(new CustomEvent("vecto:billing-insufficient", { detail: { code } }));
      }
      const detail = payload?.detail?.message || payload?.detail || payload?.message || `请求失败（${response.status}）`;
      const error = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function editGeneratedPromptPreview(preview) {
    const source = preview && typeof preview === "object" ? preview : {};
    const candidates = Array.isArray(source.speech_candidates)
      ? source.speech_candidates.filter((item) => item && String(item.speech_text || "").trim()).slice(0, 3)
      : [];
    const hasSpeech = Boolean(candidates.length || String(source.speech_text || "").trim());
    const hasPrompt = Boolean(String(source.prompt_text || source.prompt || "").trim());
    if (!hasSpeech && !hasPrompt) return Promise.resolve(source);
    const preferred = Number(source.selected_speech_candidate_index);
    let selectedIndex = Number.isInteger(preferred) && preferred >= 0 && preferred < candidates.length ? preferred : 0;
    let editedSpeech = String(candidates[selectedIndex]?.speech_text || source.speech_text || "").trim();
    let editedPrompt = String(source.prompt_text || source.prompt || "").trim();
    let errorMessage = "";
    return new Promise((resolve) => {
      const host = document.createElement("div");
      const render = () => {
        const cards = candidates.map((candidate, index) => `
          <button type="button" class="video-speech-candidate ${index === selectedIndex ? "is-selected" : ""}" data-video-speech-candidate="${index}">
            <span class="video-speech-candidate-top"><strong>方案 ${index + 1}</strong>${index === selectedIndex ? "<em>已选择</em>" : ""}</span>
            <span class="video-speech-candidate-title">${escapeHtml(candidate.title || `方案 ${index + 1}`)}</span>
            ${candidate.angle ? `<span class="small">${escapeHtml(candidate.angle)}</span>` : ""}
            ${candidate.summary ? `<span>${escapeHtml(candidate.summary)}</span>` : ""}
            <span class="video-speech-candidate-copy">${escapeHtml(String(candidate.speech_text || ""))}</span>
          </button>`).join("");
        host.innerHTML = `<div class="console-modal video-speech-modal">
          <div class="console-modal-backdrop" data-video-speech-cancel></div>
          <section class="console-modal-dialog video-speech-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="videoSpeechCandidateTitle">
            <div class="console-modal-head"><div><strong id="videoSpeechCandidateTitle">AI 文案预览与确认</strong><div class="small">${candidates.length ? `已生成 ${candidates.length} 条候选口播文案，可先选择再修改。` : "AI 已生成以下内容，请先检查和修改。"} 确认后才会提交最终视频任务。</div></div><button type="button" class="console-modal-close" data-video-speech-cancel aria-label="关闭">&times;</button></div>
            <div class="console-modal-content">
              ${candidates.length ? `<div class="video-speech-candidate-grid">${cards}</div>` : ""}
              <div class="video-prompt-preview-editor">
                ${hasSpeech ? `<label class="video-prompt-preview-field"><span>AI 口播文案</span><textarea rows="7" data-video-prompt-preview-speech>${escapeHtml(editedSpeech)}</textarea><small>可以直接修改；确认后按这里的最终文本配音，不会再自动拼接产品简介。</small></label>` : ""}
                ${hasPrompt ? `<label class="video-prompt-preview-field"><span>画面提示词</span><textarea rows="5" data-video-prompt-preview-prompt>${escapeHtml(editedPrompt)}</textarea><small>用于生成画面，可在提交前调整。</small></label>` : ""}
                ${errorMessage ? `<div class="video-inline-error" role="alert">${escapeHtml(errorMessage)}</div>` : ""}
              </div>
            </div>
            <div class="console-modal-actions"><button type="button" class="primary" data-video-prompt-preview-confirm>确认并继续生成</button><button type="button" data-video-speech-cancel>取消</button></div>
          </section></div>`;
      };
      const finish = (value) => {
        host.remove();
        resolve(value);
      };
      host.addEventListener("input", (event) => {
        if (event.target.matches?.("[data-video-prompt-preview-speech]")) editedSpeech = event.target.value;
        if (event.target.matches?.("[data-video-prompt-preview-prompt]")) editedPrompt = event.target.value;
      });
      host.addEventListener("click", (event) => {
        const card = event.target.closest("[data-video-speech-candidate]");
        if (card) {
          selectedIndex = Number(card.dataset.videoSpeechCandidate) || 0;
          editedSpeech = String(candidates[selectedIndex]?.speech_text || "").trim();
          errorMessage = "";
          render();
          return;
        }
        if (event.target.closest("[data-video-prompt-preview-confirm]")) {
          editedSpeech = String(host.querySelector("[data-video-prompt-preview-speech]")?.value ?? editedSpeech).trim();
          editedPrompt = String(host.querySelector("[data-video-prompt-preview-prompt]")?.value ?? editedPrompt).trim();
          if (hasSpeech && !editedSpeech) {
            errorMessage = "口播文案不能为空；请补充内容或取消本次生成。";
            render();
            return;
          }
          const result = {
            ...source,
            speech_text: editedSpeech,
            prompt_text: editedPrompt,
            ...(candidates.length ? {
              speech_candidates: candidates.map((candidate, index) => index === selectedIndex ? { ...candidate, speech_text: editedSpeech } : candidate),
              selected_speech_candidate_index: selectedIndex,
            } : {}),
          };
          finish(result);
          return;
        }
        if (event.target.closest("[data-video-speech-cancel]")) finish(null);
      });
      render();
      document.body.appendChild(host);
      window.requestAnimationFrame(() => host.querySelector("[data-video-prompt-preview-speech], [data-video-prompt-preview-confirm]")?.focus());
    });
  }

  function chooseSpeechCandidate(preview) {
    return editGeneratedPromptPreview(preview);
  }

  async function confirmPromptPreview(module, values) {
    const body = new FormData();
    const requestNonce = window.crypto?.randomUUID?.() || `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    body.append("module", module.id);
    body.append("request_nonce", requestNonce);
    const fileManifest = [];
    resolvedFields(module, values).filter((field) => field.type === "file").forEach((field) => {
      selectedFiles(module.id, field.key).forEach((file) => {
        if (String(file.type || "").toLowerCase().startsWith("image/") || /\.(?:png|jpe?g|webp|bmp)$/i.test(file.name || "")) {
          body.append("files", file);
          fileManifest.push({ field: field.key, name: file.name, size: file.size, type: file.type });
        }
      });
    });
    body.append("params_json", JSON.stringify({ ...values, _file_roles: fileManifest }));
    let preview;
    try {
      preview = await request("/api/video/prompt-preview", { method: "POST", body });
    } catch (error) {
      if (error?.status && ![502, 504].includes(Number(error.status))) throw error;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        try {
          const recovered = await request(`/api/video/prompt-preview/recover?request_nonce=${encodeURIComponent(requestNonce)}`);
          if (recovered?.status !== "pending") {
            preview = recovered;
            break;
          }
        } catch (recoverError) {
          if (recoverError?.status && ![404, 502, 504].includes(Number(recoverError.status))) throw recoverError;
        }
      }
      if (!preview) throw error;
    }
    const hasPreviewContent = Boolean(
      String(preview?.speech_text || preview?.prompt_text || preview?.prompt || "").trim()
      || (Array.isArray(preview?.speech_candidates) && preview.speech_candidates.length)
      || (preview?.storyboard && typeof preview.storyboard === "object")
    );
    if (!hasPreviewContent) {
      throw new Error("AI 未返回可预览的文案或提示词，请补充产品简介/口播主题后重试。");
    }
    if (Array.isArray(preview?.speech_candidates) && preview.speech_candidates.length) return chooseSpeechCandidate(preview);
    return editGeneratedPromptPreview(preview);
  }

  function requiresPromptPreview(module) {
    return VIDEO_PROMPT_MODULES.has(String(module?.id || module || ""));
  }

  function requiresPromptPreviewForSubmit(module, values) {
    values = values && typeof values === "object" ? values : {};
    if (!requiresPromptPreview(module)) return false;
    if (String(module?.id || module || "") === "digital_human_video") {
      return !String(values.speech_text || "").trim();
    }
    return true;
  }

  function requiresSimpleSubmitConfirmation(module) {
    const moduleId = String(module?.id || module || "");
    return Boolean(moduleId)
      && moduleId !== "ecommerce_image"
      && moduleId !== "video_language_replace"
      && !requiresPromptPreview(moduleId);
  }

  function applyConfirmedPromptPreview(module, submitValues, promptPreview) {
    if (!requiresPromptPreview(module)) return submitValues;
    if (!promptPreview || typeof promptPreview !== "object") return submitValues;
    const hasAuthoredSpeech = Boolean(String(submitValues.speech_text || "").trim() || String(submitValues.copy_text || "").trim());
    if (Object.prototype.hasOwnProperty.call(promptPreview, "speech_text") && !hasAuthoredSpeech) {
      submitValues.speech_text = promptPreview.speech_text;
      submitValues.speech_text = String(submitValues.speech_text || "");
      if (module.id === "ecommerce_short_video") submitValues.copy_text = submitValues.speech_text;
    }
    if (module.id === "digital_human_video" && String(submitValues.speech_text || "").trim()) {
      submitValues.use_ai_copy = false;
    }
    if (Array.isArray(promptPreview.speech_candidates)) {
      submitValues.speech_candidates = promptPreview.speech_candidates;
      submitValues.selected_speech_candidate_index = Number(promptPreview.selected_speech_candidate_index) || 0;
    }
    const hasAuthoredPrompt = Boolean(String(submitValues.prompt_text || "").trim() || String(submitValues.prompt || "").trim());
    if (Object.prototype.hasOwnProperty.call(promptPreview, "prompt_text") && !hasAuthoredPrompt) {
      submitValues.prompt_text = String(promptPreview.prompt_text || "");
      submitValues.prompt = promptPreview.prompt_text;
      submitValues.prompt = String(submitValues.prompt || "");
    }
    if (promptPreview.storyboard && typeof promptPreview.storyboard === "object") {
      submitValues.storyboard = promptPreview.storyboard;
      const previewItems = Array.isArray(promptPreview.storyboard)
        ? promptPreview.storyboard
        : (Array.isArray(promptPreview.storyboard.items) ? promptPreview.storyboard.items : []);
      submitValues.prompt_segments = previewItems
        .map((item) => String(item?.prompt || item?.text || "").trim())
        .filter(Boolean);
    }
    if (module.id === "ecommerce_short_video") {
      for (const key of [
        "ecommerce_material_analysis",
        "ecommerce_product_web_research",
        "ecommerce_effective_selected_indexes",
        "ecommerce_effective_ignored_indexes",
        "ecommerce_effective_reference_order",
        "ecommerce_creative_brief",
        "ecommerce_segments",
      ]) {
        if (Object.prototype.hasOwnProperty.call(promptPreview, key)) submitValues[key] = promptPreview[key];
      }
    }
    return submitValues;
  }

  function invalidatePromptPreview(module, draft, changedKey = "") {
    if (!requiresPromptPreview(module)) return;
    delete draft.values._prompt_preview;
    draft.values._prompt_preview_ready = false;
    delete draft.values._prompt_preview_confirmed;
  }

  function applyStoredPromptPreviewForSubmit(module, submitValues, draft) {
    const preview = draft.values._prompt_preview;
    if (!preview || typeof preview !== "object") return submitValues;
    const editable = Object.fromEntries(
      ["speech_text", "copy_text", "prompt_text", "prompt"].map((key) => [key, submitValues[key]])
    );
    const shouldRestoreEditableValue = (key, value) => {
      if (value === undefined) return false;
      if (["speech_text", "copy_text", "prompt_text", "prompt"].includes(key)) return Boolean(String(value || "").trim());
      return true;
    };
    applyConfirmedPromptPreview(module, submitValues, preview);
    for (const [key, value] of Object.entries(editable)) {
      if (shouldRestoreEditableValue(key, value)) submitValues[key] = value;
    }
    if (module.id === "ecommerce_short_video" && submitValues.copy_text !== undefined) {
      submitValues.speech_text = submitValues.copy_text;
    }
    return submitValues;
  }

  async function generatePromptDraft({ autoSubmit = false } = {}) {
    if (state.promptGenerating || (state.submitting && !autoSubmit)) return false;
    const module = currentModule();
    if (!requiresPromptPreview(module)) return false;
    const validationError = validate(module);
    if (validationError) {
      state.submitError = validationError;
      showVideoError(null, validationError, "无法生成提示词 / 文案");
      render();
      return false;
    }
    const draft = loadDraft(module);
    ensureAdvancedValues(module, draft);
    state.promptGenerating = true;
    state.submitError = "";
    render();
    const progress = openVideoProgress("正在生成提示词 / 文案", [
      "正在整理产品信息和素材…",
      "正在生成口播文案与画面提示词…",
      "正在检查生成内容，请稍候…",
    ], { stage: "prompt", moduleId: module.id, values: draft.values });
    try {
      const values = publicSubmitValues(module, draft);
      const preview = await confirmPromptPreview(module, values);
      if (!preview) {
        updateVideoSuccess(progress, "已取消生成", "已取消提示词 / 文案生成。", "你仍可以修改输入后再次点击生成。");
        return false;
      }
      draft.values._prompt_preview = preview;
      draft.values._prompt_preview_ready = true;
      draft.values._prompt_preview_confirmed = true;
      if (!String(values.speech_text || "").trim() && String(preview.speech_text || "").trim()) {
        draft.values.speech_text = String(preview.speech_text).trim();
      }
      saveDraft(module.id);
      if (autoSubmit) {
        const submitValues = publicSubmitValues(module, draft);
        applyStoredPromptPreviewForSubmit(module, submitValues, draft);
        progress?.update?.({
          title: "正在提交视频任务",
          message: "提示词 / 文案已生成，正在自动提交视频任务…",
          detail: "无需再次点击，系统会继续生成最终视频并同步到视频记录。",
          status: "progress",
          busy: true,
          messages: ["提示词 / 文案已生成，正在自动提交视频任务…"],
          steps: videoProgressSteps("submit", { moduleId: module.id, values: submitValues }),
          showClose: false,
          showConfirm: false,
          showCancel: false,
          actions: [],
        });
        await submitPreparedVideoTask(module, draft, submitValues, progress, { requireTaskId: true });
        return true;
      }
      updateVideoSuccess(
        progress,
        "提示词 / 文案已生成",
        "提示词和文案已生成，请检查内容后再提交视频任务。",
        "当前步骤只生成提示词 / 文案，还没有创建最终视频任务。确认内容无误后继续生成视频；如需调整，关闭提示后修改输入。",
        [{
          value: "continue-video",
          text: "继续生成视频",
          primary: true,
          onSelect: () => document.getElementById("videoWorkbenchForm")?.requestSubmit?.(),
        }],
      );
      return true;
    } catch (error) {
      state.submitError = showVideoError(error, "提示词 / 文案生成失败：请检查输入内容和素材后重试。", "提示词 / 文案生成失败", progress);
      return false;
    } finally {
      state.promptGenerating = false;
      render();
    }
  }

  async function taskAction(taskId, action) {
    if (!taskId) return;
    const isCancel = action === "cancel";
    const progress = openVideoProgress(isCancel ? "正在取消视频任务" : "正在重新提交视频任务", isCancel
      ? ["正在停止当前任务…", "正在同步任务状态…", "正在刷新任务列表…"]
      : ["正在准备重新提交参数…", "正在恢复视频生成任务…", "正在刷新任务状态，请稍候…"]);
    try {
      if (isCancel) {
        await request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
        await loadTasks({ quiet: true });
        updateVideoSuccess(progress, "视频任务已取消", "任务已停止，不会继续执行后续生成。", `任务编号：${taskId}`);
      } else {
        let result = null;
        try {
          result = await request(`/api/video/tasks/${encodeURIComponent(taskId)}/resume`, { method: "POST" });
        } catch (resumeError) {
          if (![404, 405].includes(Number(resumeError?.status))) throw resumeError;
          result = await request(`/api/tasks/${encodeURIComponent(taskId)}/retry`, { method: "POST" });
        }
        await loadTasks({ quiet: true });
        const resumedTaskId = taskIdFromResponse(result) || String(taskId);
        monitorSubmittedTask(resumedTaskId, progress, state.moduleId, "视频");
      }
    } catch (error) {
      state.taskError = showVideoError(error, isCancel ? "取消视频任务失败：请稍后重试。" : "重新提交视频任务失败：请检查素材和余额后重试。", isCancel ? "取消任务失败" : "重新提交失败", progress);
      renderTaskPanelOnly();
    }
  }

  function invalidateTaskMedia(taskId) {
    const id = String(taskId || "");
    for (const source of ["video", "regular"]) {
      const key = taskMediaKey({ id }, source);
      delete state.taskMedia[key];
      delete state.taskMediaResolved[key];
      delete state.taskMediaLoading[key];
    }
    state.tasks.filter((task) => task.id === id).forEach((task) => {
      task.mediaItems = [];
      task.subtitleStateKnown = false;
      task.fusionStateKnown = false;
      task.fusionImages = [];
    });
  }

  function openSubtitleTemplateModal(taskId) {
    const task = state.tasks.find((item) => item.id === String(taskId || "") && canAddSubtitlesToTask(item));
    if (!task) return;
    state.subtitleModalTaskId = task.id;
    state.subtitleTemplate = subtitleTemplateFromTask(task);
    state.subtitleError = "";
    render();
    window.requestAnimationFrame(() => document.querySelector("[data-video-subtitle-template]")?.focus());
  }

  function closeSubtitleTemplateModal() {
    if (state.subtitleSubmitting) return;
    state.subtitleModalTaskId = "";
    state.subtitleError = "";
    render();
  }

  async function addSubtitlesToTask(taskId, subtitleTemplate) {
    const template = normalizeSubtitleTemplate(subtitleTemplate);
    if (!taskId || !template || state.subtitleSubmitting) return;
    state.subtitleSubmitting = true;
    state.subtitleError = "";
    render();
    const progress = openVideoProgress("正在添加字幕", [
      "正在读取视频时间轴…",
      "正在生成字幕文件，请稍候…",
      "正在写入视频任务结果…",
    ]);
    try {
      await request(`/api/tasks/${encodeURIComponent(taskId)}/subtitles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subtitle_template: template }),
      });
      state.subtitleModalTaskId = "";
      invalidateTaskMedia(taskId);
      await loadTasks({ quiet: true });
      updateVideoSuccess(progress, "字幕添加完成", "字幕已添加到视频任务。", "请在任务记录中查看或下载最新结果。");
    } catch (error) {
      state.subtitleError = showVideoError(error, "添加字幕失败：请确认视频任务已完成后重试。", "添加字幕失败", progress);
    } finally {
      state.subtitleSubmitting = false;
      render();
    }
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
        // The backend directory supplies availability and task metadata only.
        // Visible fields are an explicit allowlist copied from the original UI;
        // provider/workflow parameters must never leak into this form.
        fields: fallbackModule.fields,
      };
    });
  }

  function currentModule() {
    return state.modules.find((module) => module.id === state.moduleId) || state.modules[0] || FALLBACK_MODULES[MODULE_ORDER[0]];
  }

  function resolvedFields(module, values = {}) {
    const source = typeof module.fields === "function" ? module.fields(values) : module.fields;
    return (Array.isArray(source) ? source : []).map((fieldItem) => {
      if (module.id === "video_subject_replace" && fieldItem.key === "image") {
        return { ...fieldItem, label: values.replace_mode === "product" ? "目标商品图" : "目标人物/模特图" };
      }
      return fieldItem;
    });
  }

  function draftScope() {
    const userId = window.__CONSOLE_BOOTSTRAP__?.me?.id || window.__CONSOLE_BOOTSTRAP__?.user?.id || ADMIN_WORKSPACE_USER_ID || "self";
    return String(userId);
  }

  function draftStorageKey(moduleId) {
    return `wk-video-workbench-draft:${draftScope()}:${moduleId}`;
  }

  function defaultValues(module) {
    return Object.fromEntries(resolvedFields(module).filter((field) => field.type !== "file").map((field) => [
      field.key,
      field.key === "minimax_tts_model"
        ? clampSpeechModel("")
        : (field.default ?? (field.type === "checkbox" ? false : "")),
    ]));
  }

  function hydrateDynamicDefaults(module, draft) {
    for (const field of resolvedFields(module, draft.values)) {
      if (field.type !== "file" && draft.values[field.key] === undefined) {
        draft.values[field.key] = field.default ?? (field.type === "checkbox" ? false : "");
      }
    }
    return draft;
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
    if (Object.prototype.hasOwnProperty.call(state.drafts[module.id].values, "minimax_tts_model")) {
      state.drafts[module.id].values.minimax_tts_model = clampSpeechModel(state.drafts[module.id].values.minimax_tts_model);
    }
    return hydrateDynamicDefaults(module, state.drafts[module.id]);
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
    releaseModuleFilePreviews(moduleId);
    state.files[moduleId] = {};
    void clearPersistedModuleFiles(moduleId);
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
    for (const line of input.split(/\n+/).map((item) => item.trim()).filter(Boolean)) {
      const timed = line.match(/^\[?\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)\s*(?:-->|-|~)\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)\s*\]?\s*(.*)$/);
      // The original platform only skips audio analysis when every line carries
      // a real timecode. Plain text must be aligned against the source video's audio.
      if (!timed) return [];
      rows.push({ start: parseTimecode(timed[1]), end: parseTimecode(timed[2]), text: timed[3].trim() });
    }
    return normalizeTimelineRows(rows);
  }

  function scriptSource(module, values) {
    if (module.id === "video_language_replace") return values.script_text || "";
    return values.speech_text || values.script || values.copy_text || "";
  }

  function ensureAdvancedValues(module, draft) {
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
      voiceName: String(row?.voice_name || row?.voiceName || row?.name || row?.label || voiceId),
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
        state.voiceError = videoErrorMessage(apiError, "音色列表加载失败：请刷新页面后重试。");
      }
    }
    state.voicePresets = rows.map(normalizeVoicePreset).filter((voice) => voice.voiceId);
    state.voiceLoaded = true;
    state.voiceLoading = false;
    render();
  }

  function selectedFileSlots(moduleId, fieldKey) {
    return state.files[moduleId]?.[fieldKey] || [];
  }

  function selectedFiles(moduleId, fieldKey) {
    return selectedFileSlots(moduleId, fieldKey).filter(Boolean);
  }

  function isPreviewableImageFile(file) {
    if (!file) return false;
    const mime = String(file.type || "").toLowerCase();
    const name = String(file.name || "").toLowerCase();
    return mime.startsWith("image/") || /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(name);
  }

  function localFilePreviewUrl(file) {
    if (!isPreviewableImageFile(file) || typeof URL?.createObjectURL !== "function") return "";
    if (!localFilePreviewUrls.has(file)) localFilePreviewUrls.set(file, URL.createObjectURL(file));
    return localFilePreviewUrls.get(file) || "";
  }

  function releaseFilePreview(file) {
    const previewUrl = localFilePreviewUrls.get(file);
    if (!previewUrl) return;
    URL.revokeObjectURL(previewUrl);
    localFilePreviewUrls.delete(file);
  }

  function replaceFileSlots(moduleId, fieldKey, nextSlots = []) {
    const previous = selectedFileSlots(moduleId, fieldKey);
    const retained = new Set(nextSlots.filter(Boolean));
    previous.filter(Boolean).forEach((file) => {
      if (!retained.has(file)) releaseFilePreview(file);
    });
    state.files[moduleId] ||= {};
    state.files[moduleId][fieldKey] = nextSlots;
    void persistFileSlots(moduleId, fieldKey, nextSlots);
  }

  function releaseModuleFilePreviews(moduleId) {
    Object.values(state.files[moduleId] || {}).flat().filter(Boolean).forEach(releaseFilePreview);
  }

  function releaseAllFilePreviews() {
    Array.from(localFilePreviewUrls.keys()).forEach(releaseFilePreview);
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

  function workbenchIcon(name) {
    const icons = {
      upload: '<path d="M12 16V5"></path><path d="m8 9 4-4 4 4"></path><path d="M5 15v4h14v-4"></path>',
      replace: '<path d="M4 8a7 7 0 0 1 12-3l2 2"></path><path d="M18 3v4h-4"></path><path d="M20 16a7 7 0 0 1-12 3l-2-2"></path><path d="M6 21v-4h4"></path>',
      refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 5v6h-6"></path>',
      play: '<path d="M9 6v12l9-6-9-6z" fill="currentColor" stroke="none"></path>',
      pause: '<path d="M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z" fill="currentColor" stroke="none"></path>',
      check: '<path d="m5 12 4 4L19 6"></path>',
      pending: '<circle cx="12" cy="12" r="8"></circle>',
      add: '<path d="M12 5v14M5 12h14"></path>',
      alert: '<path d="M10.3 4.3 2.8 17.2A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0Z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>',
    };
    return `<svg class="video-ui-icon" data-video-icon="${escapeHtml(name)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[name] || icons.add}</svg>`;
  }

  function optionMarkup(field, value) {
    return field.options.map((option) => `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(value) ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
  }

  function isPillSelectField(field) {
    return field?.type === "select" && PILL_SELECT_KEYS.has(field.key) && field.options.length >= 2 && field.options.length <= 4;
  }

  function voiceMatchesLanguage(voice, language) {
    const expected = String(language || "").trim().toLowerCase();
    const actual = String(voice?.language || "").trim().toLowerCase();
    return !expected || actual === expected;
  }

  function selectedVoiceForDraft(draft, language = null) {
    const values = draft?.values || {};
    const identifiers = [values.voice_id, values.speaker]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (!identifiers.length) return null;
    const targetLanguage = language == null ? (values.target_language || values.language || "") : language;
    return state.voicePresets.find((voice) => (
      identifiers.some((identifier) => identifier === voice.voiceId || identifier === voice.id)
      && voiceMatchesLanguage(voice, targetLanguage)
    )) || null;
  }

  function voiceSourceCopy(field, files, selectedVoice) {
    if (files.length) return `已选择 ${files.length} 个文件`;
    if (selectedVoice) return `已选择参考声音：${selectedVoice.label}`;
    return field.help || (field.previewSlots ? "点击对应素材位选择文件" : "点击选择文件");
  }

  function renderFileField(field) {
    const fileSlots = selectedFileSlots(state.moduleId, field.key);
    const files = selectedFiles(state.moduleId, field.key);
    const fileRows = files.map((item) => `<li><span>${escapeHtml(item.name)}</span><small>${formatBytes(item.size)}</small></li>`).join("");
    const explicitPreviewSlots = field.previewSlots == null ? null : Math.max(0, Number(field.previewSlots) || 0);
    const previewSlots = explicitPreviewSlots == null && !String(field.accept || "").includes("audio") ? 1 : (explicitPreviewSlots || 0);
    const previewLabels = Array.isArray(field.previewLabels) ? field.previewLabels : [];
    const isVoiceInput = VOICE_MODULES.has(state.moduleId) && field.key === "audio";
    const draft = isVoiceInput ? loadDraft(currentModule()) : null;
    const selectedVoice = isVoiceInput ? selectedVoiceForDraft(draft) : null;
    const hasSource = files.length > 0 || Boolean(selectedVoice);
    const displayLabel = isVoiceInput ? "参考音频/声音" : field.label;
    const sourceCopy = voiceSourceCopy(field, files, selectedVoice);
    const completionState = field.required
      ? `<span class="video-file-field-state ${hasSource ? "is-complete" : "is-pending"}" data-video-file-state="${hasSource ? "complete" : "pending"}" aria-label="${hasSource ? "已完成" : "待完成"}">${workbenchIcon(hasSource ? "check" : "pending")}</span>`
      : "";
    return `<div class="video-file-field ${hasSource ? "has-files" : ""} ${isVoiceInput ? "is-voice-source" : ""}" data-video-file-field="${escapeHtml(field.key)}" data-video-file-required="${field.required ? "true" : "false"}">
      <input type="file" data-video-field="${escapeHtml(field.key)}" ${field.accept ? `accept="${escapeHtml(field.accept)}"` : ""} ${field.multiple ? "multiple" : ""} />
      <span class="video-file-field-icon">${moduleIcon(state.moduleId)}</span>
      <span class="video-file-field-copy">
        <strong>${escapeHtml(displayLabel)}${field.required ? '<em aria-hidden="true">*</em>' : ""}${completionState}</strong>
        <span data-video-file-source-copy>${escapeHtml(sourceCopy)}</span>
      </span>
      <span class="video-file-field-actions">
        <button type="button" class="video-file-field-action" data-video-file-pick="${escapeHtml(field.key)}">${files.length ? "重新选择" : "选择文件"}</button>
        ${String(field.accept || "").includes("image") ? `<button type="button" class="video-file-field-action" data-video-asset-picker="${escapeHtml(field.key)}">历史素材</button>` : ""}
        ${isVoiceInput ? `<button type="button" class="video-file-field-action video-file-field-action--voice" data-video-open-voice>${hasSource ? "更换参考声音" : "声音设置"}</button>` : ""}
      </span>
      ${previewSlots ? `<span class="video-upload-slots">${Array.from({ length: previewSlots }, (_, index) => {
        const fileItem = fileSlots[index] || null;
        const label = fileItem?.name || previewLabels[index] || `素材 ${index + 1}`;
        const previewUrl = localFilePreviewUrl(fileItem);
        return `<button type="button" class="${fileItem ? "is-filled" : ""} ${previewUrl ? "has-preview" : ""}" data-video-file-slot="${index}" data-video-file-filled="${fileItem ? "true" : "false"}" aria-label="${escapeHtml(fileItem ? `替换 ${label}` : `上传 ${label}`)}" title="${escapeHtml(fileItem ? `点击替换：${label}` : `点击上传：${label}`)}">
          ${previewUrl ? `<img class="video-upload-slot-preview" data-video-file-preview src="${escapeHtml(previewUrl)}" alt="" decoding="async"><span class="video-upload-slot-shade" aria-hidden="true"></span><span class="video-upload-slot-action" aria-hidden="true">${workbenchIcon("replace")}</span>` : `<span class="video-upload-slot-empty-icon" aria-hidden="true">${workbenchIcon("add")}</span>`}
          <span class="video-upload-slot-label">${escapeHtml(label)}</span>
        </button>`;
      }).join("")}</span>` : ""}
      ${fileRows ? `<ul class="video-selected-files">${fileRows}</ul>` : ""}
    </div>`;
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

  function renderDigitalHumanSettings(fields, draft) {
    const fieldMap = new Map(fields.filter((field) => field.type !== "file").map((field) => [field.key, field]));
    const renderKeys = (keys) => keys.map((key) => fieldMap.get(key)).filter(Boolean).map((field) => renderInputField(field, draft.values[field.key])).join("");
    const hasSpeech = Boolean(String(draft.values.speech_text || "").trim());
    return `<div class="video-digital-human-settings">
      <section class="video-form-subsection video-form-subsection--reference">
        <div class="video-subsection-heading"><span>CONTENT REFERENCE</span><strong>AI 内容参考</strong><small>产品名称和简介只用于 AI 生成文案、画面提示词及分镜参考。</small></div>
        <div class="video-form-grid video-form-grid--content">${renderKeys(["product_name", "product_details"])}</div>
      </section>
      <section class="video-form-subsection video-form-subsection--script">
        <div class="video-subsection-heading"><span>FINAL INPUT</span><strong>最终口播输入</strong><small>${hasSpeech ? "已填写最终文案，产品简介可留空；提交时按此内容直接配音。" : "留空时会根据素材和 AI 内容参考生成文案，并在提交前弹窗预览、修改和确认。"}</small></div>
        <div class="video-form-grid video-form-grid--script">${renderKeys(["speech_text"])}</div>
      </section>
      <section class="video-form-subsection video-form-subsection--visual">
        <div class="video-subsection-heading"><span>OUTPUT SETTINGS</span><strong>画面与音频设置</strong><small>口播语言和预设音色在素材区的“声音设置”中选择。</small></div>
        <div class="video-form-grid video-form-grid--visual">${renderKeys(["minimax_tts_model", "ratio", "image_resolution", "digital_human_short_mode", "oral_target_duration_seconds"])}</div>
      </section>
    </div>`;
  }

  function renderVoiceCurrentSource(module, draft) {
    const uploadedAudio = selectedFiles(module.id, "audio")[0];
    const selected = selectedVoiceForDraft(draft);
    const currentSource = uploadedAudio
      ? `已上传音频：${uploadedAudio.name}`
      : (selected ? `已选择预设声音：${selected.label}` : "尚未选择参考音频或预设声音");
    return `<div class="video-voice-current" data-video-voice-current-source><span>当前参考来源</span><strong>${escapeHtml(currentSource)}</strong><small>上传音频会随任务提交；预设声音会保存到当前模块草稿。</small></div>`;
  }

  function renderVoicePresetList(draft) {
    const language = String(draft.values.target_language || draft.values.language || "").trim().toLowerCase();
    const filtered = state.voicePresets.filter((voice) => !language || voice.language.trim().toLowerCase() === language);
    const voices = (language ? filtered : state.voicePresets).slice(0, 24);
    const selected = selectedVoiceForDraft(draft);
    const languageOption = LANGUAGE_OPTIONS.find((option) => String(option.value).toLowerCase() === language);
    const languageLabel = languageOption?.label || draft.values.target_language || "当前口播语言";
    return `<div class="video-voice-toolbar">
      <span class="video-voice-language-note">音色列表已按${escapeHtml(languageLabel)}自动筛选，切换口播语言后立即更新</span>
    </div>
    ${state.voiceLoading && !voices.length ? `<div class="video-advanced-loading"><span class="video-workbench-loader"></span>正在加载音色列表</div>` : (!voices.length ? `<div class="video-advanced-loading">当前语言暂无可用预设音色，请上传参考音频或切换语言。</div>` : `
      <div class="video-voice-list" role="radiogroup" aria-label="可用音色">${voices.map((voice) => {
        const active = selected && (voice.voiceId === selected.voiceId || voice.id === selected.id);
        return `<article class="video-voice-item ${active ? "is-selected" : ""}">
          <button type="button" class="video-voice-select" role="radio" aria-checked="${active ? "true" : "false"}" data-video-voice-select="${escapeHtml(voice.id)}">
            <strong>${escapeHtml(voice.label)}</strong><small>${escapeHtml([voice.language, voice.gender].filter(Boolean).join(" · "))}</small>
          </button>
          ${voice.previewUrl ? `<button type="button" class="video-voice-play" data-video-voice-preview="${escapeHtml(voice.id)}" data-video-voice-playing="false" aria-label="试听 ${escapeHtml(voice.label)}">${workbenchIcon("play")}</button>` : `<span class="video-voice-no-preview">无试听</span>`}
        </article>`;
      }).join("")}</div>`)}`;
  }

  function updateVoicePlaybackButtons() {
    const audio = document.getElementById("videoVoicePreview");
    const isPlaying = Boolean(audio && !audio.paused && state.playingVoiceId);
    document.querySelectorAll("[data-video-voice-modal] [data-video-voice-preview]").forEach((button) => {
      const active = isPlaying && button.dataset.videoVoicePreview === state.playingVoiceId;
      button.dataset.videoVoicePlaying = active ? "true" : "false";
      button.classList.toggle("is-playing", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.setAttribute("aria-label", active ? "暂停试听" : "试听音色");
      button.innerHTML = workbenchIcon(active ? "pause" : "play");
    });
  }

  function bindVoiceAudioControls() {
    const audio = document.getElementById("videoVoicePreview");
    if (!audio) return;
    if (audio.dataset.videoVoiceEventsBound !== "1") {
      audio.dataset.videoVoiceEventsBound = "1";
      audio.addEventListener("play", () => {
        state.playingVoiceId = audio.dataset.videoVoiceCurrent || "";
        updateVoicePlaybackButtons();
      });
      audio.addEventListener("pause", () => {
        if (audio.dataset.videoVoiceSwitching === "1") return;
        state.playingVoiceId = "";
        updateVoicePlaybackButtons();
      });
      audio.addEventListener("playing", () => {
        delete audio.dataset.videoVoiceSwitching;
        updateVoicePlaybackButtons();
      });
      audio.addEventListener("ended", () => {
        delete audio.dataset.videoVoiceSwitching;
        state.playingVoiceId = "";
        updateVoicePlaybackButtons();
      });
      audio.addEventListener("error", () => {
        delete audio.dataset.videoVoiceSwitching;
        state.playingVoiceId = "";
        updateVoicePlaybackButtons();
      });
    }
    updateVoicePlaybackButtons();
  }

  function stopVoicePreview() {
    const audio = document.getElementById("videoVoicePreview");
    if (audio) {
      delete audio.dataset.videoVoiceSwitching;
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute("src");
      audio.load();
      delete audio.dataset.videoVoiceCurrent;
    }
    state.playingVoiceId = "";
    updateVoicePlaybackButtons();
  }

  function syncVoiceFileField(module, draft) {
    const field = resolvedFields(module, draft.values).find((item) => item.type === "file" && item.key === "audio");
    const host = document.querySelector('#videoWorkbenchRoot [data-video-file-field="audio"]');
    if (!field || !host) return;
    const files = selectedFiles(module.id, field.key);
    const selected = selectedVoiceForDraft(draft);
    const hasSource = files.length > 0 || Boolean(selected);
    host.classList.toggle("has-files", hasSource);
    const sourceCopy = host.querySelector("[data-video-file-source-copy]");
    if (sourceCopy) sourceCopy.textContent = voiceSourceCopy(field, files, selected);
    const stateNode = host.querySelector("[data-video-file-state]");
    if (stateNode) {
      stateNode.dataset.videoFileState = hasSource ? "complete" : "pending";
      stateNode.setAttribute("aria-label", hasSource ? "已完成" : "待完成");
      stateNode.classList.toggle("is-complete", hasSource);
      stateNode.classList.toggle("is-pending", !hasSource);
      stateNode.innerHTML = workbenchIcon(hasSource ? "check" : "pending");
    }
    const action = host.querySelector("[data-video-open-voice]");
    if (action) action.textContent = hasSource ? "更换参考声音" : "声音设置";
  }

  function refreshVoicePresetListInPlace(module, draft) {
    const modal = document.querySelector("[data-video-voice-modal]");
    const host = modal?.querySelector("[data-video-voice-presets]");
    if (!modal || !host) {
      render();
      return;
    }
    const refreshToken = ++state.voiceRefreshToken;
    host.classList.remove("is-refreshed");
    host.classList.add("is-refreshing");
    const currentSource = modal.querySelector("[data-video-voice-current-source]");
    if (currentSource) currentSource.outerHTML = renderVoiceCurrentSource(module, draft);
    syncVoiceFileField(module, draft);
    window.requestAnimationFrame(() => {
      if (refreshToken !== state.voiceRefreshToken || !host.isConnected) return;
      host.innerHTML = renderVoicePresetList(draft);
      host.classList.remove("is-refreshing");
      host.classList.add("is-refreshed");
      bindVoiceAudioControls();
      window.setTimeout(() => {
        if (refreshToken === state.voiceRefreshToken) host.classList.remove("is-refreshed");
      }, 260);
    });
  }

  function renderVoiceStudio(module, draft, voiceFields = []) {
    if (!VOICE_MODULES.has(module.id) || !state.voiceModalOpen) return "";
    const selected = selectedVoiceForDraft(draft);
    return `<div class="console-modal video-voice-modal" data-video-voice-modal>
      <div class="console-modal-backdrop" data-video-voice-close></div>
      <section class="console-modal-dialog video-voice-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="videoVoiceModalTitle">
        <div class="console-modal-head">
          <div><span>VOICE CAST</span><strong id="videoVoiceModalTitle">参考声音设置</strong><small>选择口播语言、预设声音并试听具体音色。</small></div>
          <button type="button" class="console-modal-close" data-video-voice-close title="关闭" aria-label="关闭参考声音设置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12"></path><path d="m18 6-12 12"></path></svg></button>
        </div>
        <div class="console-modal-content video-voice-modal-content">
          ${renderVoiceCurrentSource(module, draft)}
          ${state.voiceError ? `<div class="video-advanced-notice">${escapeHtml(state.voiceError)}</div>` : ""}
          ${voiceFields.length ? `<div class="video-voice-inline-fields">${voiceFields.map((field) => renderInputField(field, draft.values[field.key])).join("")}</div>` : ""}
          <div class="video-voice-presets" data-video-voice-presets>${renderVoicePresetList(draft)}</div>
          <audio id="videoVoicePreview" class="video-voice-audio" controls preload="metadata" data-video-voice-current="${escapeHtml(selected?.id || "")}" ${selected?.previewUrl ? `src="${escapeHtml(selected.previewUrl)}"` : ""}>当前浏览器不支持 audio 试听。</audio>
        </div>
        <div class="console-modal-actions"><button type="button" class="primary" data-video-voice-close>完成</button></div>
      </section>
    </div>`;
  }

  function renderTimelineEditor(module, draft) {
    if (!TIMELINE_MODULES.has(module.id)) return "";
    const rows = normalizeTimelineRows(draft.values.subtitle_segments);
    return `<section class="video-advanced-card video-timeline-editor" data-video-timeline-editor>
      <div class="video-advanced-head">
        <div><span>SCRIPT TIMELINE</span><strong>字幕 / 台词时间轴</strong><small>${module.id === "video_language_replace" ? "带时间码脚本可直接编辑；纯文本会按原视频音轨分析对齐。" : "按片段校对时间码和口播台词。"}</small></div>
        <button type="button" class="video-mini-button" data-video-parse-script>解析脚本</button>
      </div>
      <div class="video-timeline-list">${rows.length ? rows.map((row, index) => `<div class="video-timeline-row" data-video-timeline-id="${escapeHtml(row.id)}">
        <span class="video-timeline-index">${String(index + 1).padStart(2, "0")}</span>
        <label><span>开始</span><input inputmode="decimal" data-video-timeline-field="start" data-video-segment-id="${escapeHtml(row.id)}" value="${escapeHtml(formatTimecode(row.start))}"></label>
        <label><span>结束</span><input inputmode="decimal" data-video-timeline-field="end" data-video-segment-id="${escapeHtml(row.id)}" value="${escapeHtml(formatTimecode(row.end))}"></label>
        <label class="video-timeline-copy"><span>字幕 / 台词</span><textarea rows="2" data-video-timeline-field="text" data-video-segment-id="${escapeHtml(row.id)}">${escapeHtml(row.text)}</textarea></label>
        <div class="video-timeline-actions"><button type="button" data-video-remove-segment="timeline" data-video-segment-id="${escapeHtml(row.id)}">删除</button></div>
      </div>`).join("") : `<div class="video-advanced-empty">暂无时间轴片段。填写脚本后点击“解析脚本”，或手动添加台词。</div>`}</div>
      <button type="button" class="video-add-segment" data-video-add-timeline>${workbenchIcon("add")}<span>添加时间轴片段</span></button>
    </section>`;
  }

  function renderAdvancedSections(module, draft) {
    const sections = [renderTimelineEditor(module, draft)].filter(Boolean);
    if (!sections.length) return "";
    return `<section class="video-form-section video-form-section--advanced">
      <div class="video-section-heading"><span>03</span><div><strong>高级编排</strong><small>试听、故事板和时间轴内容都会随草稿保存。</small></div></div>
      <div class="video-advanced-stack">${sections.join("")}</div>
    </section>`;
  }

  function submitButtonLabel(module, values = {}) {
    if (module.id === "digital_human_video") return "生成数字人口播视频";
    if (module.id === "ecommerce_short_video") {
      return values.ecommerce_video_mode === "seeding_video" ? "生成种草视频" : "生成广告短视频";
    }
    return {
      video_language_replace: "生成音频并替换音轨",
      video_subject_replace: "提交视频替换",
      ecommerce_image: "生成电商广告图",
      subject_replace: "提交主体替换",
      poster_translate: "切换海报语言",
      subject_generate: values.subject_generate_mode === "product" ? "生成产品三视图" : "生成数字人人设三视图",
    }[module.id] || "提交生成任务";
  }

  function renderForm(module) {
    const draft = loadDraft(module);
    ensureAdvancedValues(module, draft);
    const fields = resolvedFields(module, draft.values);
    const fileFields = fields.filter((field) => field.type === "file");
    const uploadTopFields = fields.filter((field) => field.type !== "file" && field.placement === "uploadTop");
    const uploadFooterFields = fields.filter((field) => field.type !== "file" && field.placement === "uploadFooter");
    const inputFields = fields.filter((field) => field.type !== "file" && !field.placement && !(VOICE_MODULES.has(module.id) && ["speaker", "voice_id"].includes(field.key)));
    const settingsMarkup = module.id === "digital_human_video"
      ? renderDigitalHumanSettings(fields, draft)
      : (inputFields.length ? `<div class="video-form-grid">${inputFields.map((field) => renderInputField(field, draft.values[field.key])).join("")}</div>` : `<div class="video-workbench-state video-workbench-state--empty"><span>此模块没有额外生成参数。</span></div>`);
    return `<form id="videoWorkbenchForm" class="video-workbench-form" data-video-module-form="${escapeHtml(module.id)}">
      <div class="video-original-layout">
        <section class="video-form-section video-upload-panel">
          <div class="video-original-panel-head"><div><strong>素材上传</strong><small>请按原工作台顺序上传素材。</small></div><button type="button" class="video-button video-button--ghost" data-video-clear-files>清空</button></div>
          ${uploadTopFields.length ? `<div class="video-upload-mode-fields">${uploadTopFields.map((field) => renderInputField(field, draft.values[field.key])).join("")}</div>` : ""}
          ${fileFields.length ? `<div class="video-file-grid">${fileFields.map(renderFileField).join("")}</div>` : `<div class="video-workbench-state video-workbench-state--empty"><span>当前模块无需上传素材。</span></div>`}
          ${uploadFooterFields.length ? `<div class="video-upload-mode-fields video-upload-mode-fields--footer">${uploadFooterFields.map((field) => renderInputField(field, draft.values[field.key])).join("")}</div>` : ""}
        </section>
        <section class="video-form-section video-settings-panel">
          <div class="video-original-panel-head"><div><strong>生成内容</strong><small>仅显示原数字人项目对用户开放的参数。</small></div></div>
          ${settingsMarkup}
        </section>
      </div>
      ${renderAdvancedSections(module, draft)}
      <div class="video-form-footer">
        <div class="video-draft-status" data-video-draft-status>${draft.savedAt ? `草稿已保存 · ${escapeHtml(formatTime(draft.savedAt))}` : "输入内容将自动保存为草稿"}</div>
        <div class="video-form-actions">
          <button type="button" class="video-button video-button--ghost" data-video-clear-draft>清空草稿</button>
          ${requiresPromptPreview(module) ? `<button type="button" class="video-button video-button--ghost" data-video-generate-prompt ${state.promptGenerating || state.submitting ? "disabled" : ""}>${state.promptGenerating ? '<span class="video-button-spinner" aria-hidden="true"></span>正在生成' : (draft.values._prompt_preview_ready ? "重新生成提示词 / 文案" : "生成提示词 / 文案")}</button>` : ""}
          <button type="submit" class="video-button video-button--primary" ${state.submitting ? "disabled" : ""}>
            ${state.submitting ? '<span class="video-button-spinner" aria-hidden="true"></span>正在提交' : escapeHtml(submitButtonLabel(module, draft.values))}
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

  function authenticatedMediaUrl(value) {
    const safe = safeHttpUrl(value);
    if (!safe) return "";
    try {
      const url = new URL(safe, window.location.origin);
      if (url.origin !== window.location.origin) return url.href;
      if (ADMIN_CONSOLE_SESSION) url.searchParams.set("admin_console", "1");
      if (ADMIN_WORKSPACE_USER_ID) url.searchParams.set("admin_workspace_user_id", ADMIN_WORKSPACE_USER_ID);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return safe;
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
      const url = authenticatedMediaUrl(source.url || source.src || source.download_url || source.output_url);
      const type = inferMediaType(url, source.type || source.media_type || source.mediaType);
      const thumbnailUrl = authenticatedMediaUrl(source.thumbnail_url || source.thumbnailUrl);
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
      (task.source === "regular" || task.has_download || ["create_video", "digital_human_video"].includes(task.moduleId))
      && task.id
      && (
        (task.has_download && !task.mediaItems.length)
        || (task.status === "success" && task.has_download && !task.subtitleStateKnown && taskHasVideoOutput(task))
        || (["create_video", "digital_human_video"].includes(task.moduleId) && !task.fusionStateKnown)
        || (["failed", "error", "cancelled", "canceled"].includes(task.status) && !task.segments.some((segment) => ["failed", "error", "cancelled", "canceled"].includes(segment.status)))
      )
      && !state.taskMediaResolved[taskMediaKey(task)]
      && !state.taskMediaLoading[taskMediaKey(task)]
    )).slice(0, 50);
    await Promise.allSettled(candidates.map(async (task) => {
      const key = taskMediaKey(task);
      state.taskMediaLoading[key] = true;
      try {
        const detail = await request(`/api/tasks/${encodeURIComponent(task.id)}`);
        const mediaItems = normalizeMediaItems(detail);
        const detailedTask = normalizeTask({ ...task, ...detail }, task.source);
        state.taskMedia[key] = mediaItems;
        Object.assign(task, detailedTask, { mediaItems });
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
      const sourceUrl = escapeHtml(authenticatedMediaUrl(item.url));
      if (item.type === "image") {
        const previewUrl = escapeHtml(authenticatedMediaUrl(item.thumbnailUrl || item.url));
        return `<button type="button" class="video-task-media-item is-image" data-video-image-preview="${sourceUrl}" data-video-image-label="${label}" title="打开高清预览"><img src="${previewUrl}" alt="${label}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><span>${label}</span></button>`;
      }
      if (item.type === "video") {
        return `<figure class="video-task-media-item is-video"><video src="${sourceUrl}" controls preload="metadata" playsinline referrerpolicy="no-referrer">当前浏览器不支持视频预览。</video><figcaption>${label}</figcaption></figure>`;
      }
      return `<figure class="video-task-media-item is-audio"><audio src="${sourceUrl}" controls preload="metadata">当前浏览器不支持音频预览。</audio><figcaption>${label}</figcaption></figure>`;
    }).join("")}</div>`;
  }

  function renderImagePreviewModal() {
    const item = state.imagePreview;
    if (!item?.url) return "";
    const url = escapeHtml(authenticatedMediaUrl(item.url));
    const label = escapeHtml(item.label || "图片结果");
    return `<div class="console-modal video-image-preview-modal" data-video-image-modal>
      <div class="console-modal-backdrop" data-video-image-close></div>
      <section class="console-modal-dialog" role="dialog" aria-modal="true" aria-label="${label}">
        <div class="console-modal-head"><div><strong>${label}</strong><div class="small">高清原图预览</div></div><button type="button" class="console-modal-close" data-video-image-close aria-label="关闭">&times;</button></div>
        <div class="console-modal-content"><img src="${url}" alt="${label}" referrerpolicy="no-referrer" style="display:block;max-width:100%;max-height:72vh;margin:auto;object-fit:contain"></div>
        <div class="console-modal-actions"><a class="primary" href="${url}" download target="_blank" rel="noopener">下载原图</a><button type="button" data-video-image-close>关闭</button></div>
      </section>
    </div>`;
  }

  function renderImageHistoryModal() {
    if (!state.imageHistoryOpen) return "";
    const items = [];
    const seen = new Set();
    state.tasks
      .filter((task) => task.moduleId === state.moduleId || relevantRegularTask(task))
      .forEach((task) => (task.mediaItems || []).filter((item) => item.type === "image").forEach((item) => {
        if (!item.url || seen.has(item.url)) return;
        seen.add(item.url);
        items.push({ ...item, taskId: task.id, createdAt: task.createdAt });
      }));
    return `<div class="console-modal video-image-history-modal" data-video-image-history-modal>
      <div class="console-modal-backdrop" data-video-image-history-close></div>
      <section class="console-modal-dialog" role="dialog" aria-modal="true" aria-label="图片生成历史">
        <div class="console-modal-head"><div><strong>图片生成历史</strong><div class="small">当前模块最近任务的生成图片</div></div><button type="button" class="console-modal-close" data-video-image-history-close aria-label="关闭">&times;</button></div>
        <div class="console-modal-content"><div class="video-task-media">${items.length ? items.map((item) => `<button type="button" class="video-task-media-item is-image" data-video-image-preview="${escapeHtml(authenticatedMediaUrl(item.url))}" data-video-image-label="${escapeHtml(item.label || "历史图片")}"><img src="${escapeHtml(authenticatedMediaUrl(item.thumbnailUrl || item.url))}" alt="${escapeHtml(item.label || "历史图片")}" loading="lazy"><span>${escapeHtml(item.label || "历史图片")} · ${escapeHtml(formatTime(item.createdAt))}</span></button>`).join("") : '<div class="video-workbench-state video-workbench-state--empty"><span>暂无图片历史</span></div>'}</div></div>
        <div class="console-modal-actions"><button type="button" data-video-image-history-close>关闭</button></div>
      </section>
    </div>`;
  }

  function renderAssetPickerModal() {
    if (!state.assetPickerField) return "";
    const items = [];
    const seen = new Set();
    state.tasks.forEach((task) => (task.mediaItems || []).filter((item) => item.type === "image").forEach((item) => {
      if (!item.url || seen.has(item.url)) return;
      seen.add(item.url);
      items.push({ ...item, createdAt: task.createdAt });
    }));
    return `<div class="console-modal video-asset-picker-modal">
      <div class="console-modal-backdrop" data-video-asset-picker-close></div>
      <section class="console-modal-dialog" role="dialog" aria-modal="true" aria-label="选择历史素材">
        <div class="console-modal-head"><div><strong>选择历史素材</strong><div class="small">从当前账号已生成图片中选用</div></div><button type="button" class="console-modal-close" data-video-asset-picker-close aria-label="关闭">&times;</button></div>
        <div class="console-modal-content"><div class="video-task-media">${items.length ? items.map((item) => `<button type="button" class="video-task-media-item is-image" data-video-asset-use="${escapeHtml(authenticatedMediaUrl(item.url))}" data-video-asset-label="${escapeHtml(item.label || "历史素材")}"><img src="${escapeHtml(authenticatedMediaUrl(item.thumbnailUrl || item.url))}" alt="${escapeHtml(item.label || "历史素材")}" loading="lazy"><span>${escapeHtml(item.label || "历史素材")} · ${escapeHtml(formatTime(item.createdAt))}</span></button>`).join("") : '<div class="video-workbench-state video-workbench-state--empty"><span>暂无可选历史素材</span></div>'}</div></div>
        <div class="console-modal-actions"><button type="button" data-video-asset-picker-close>关闭</button></div>
      </section>
    </div>`;
  }

  async function useHistoryAsset(url, label) {
    const module = currentModule();
    const draft = loadDraft(module);
    const field = resolvedFields(module, draft.values).find((item) => item.key === state.assetPickerField && item.type === "file");
    if (!field) return;
    const sourceUrl = authenticatedMediaUrl(url);
    if (!sourceUrl) throw new Error("历史素材地址无效，请刷新后重试。");
    const response = await fetch(sourceUrl, { credentials: "include" });
    if (!response.ok) throw new Error(`历史素材读取失败（${response.status}）`);
    const blob = await response.blob();
    const extension = String(blob.type || "").split("/")[1] || "png";
    const file = new File([blob], `${String(label || "history-image").replace(/[\\/:*?"<>|]+/g, "-")}.${extension}`, { type: blob.type || "image/png", lastModified: Date.now() });
    const limit = Math.max(Number(field.maxFiles || field.previewSlots || 1), 1);
    const slots = selectedFileSlots(module.id, field.key).slice(0, limit);
    const emptyIndex = slots.findIndex((item) => !item);
    const targetIndex = emptyIndex >= 0 ? emptyIndex : (field.multiple && slots.length < limit ? slots.length : 0);
    slots[targetIndex] = file;
    replaceFileSlots(module.id, field.key, slots);
    invalidatePromptPreview(module, draft, field.key);
    saveDraft(module.id);
    state.assetPickerField = "";
    render();
  }

  function statusCopy(status, task = null) {
    if (taskNeedsVisualConfirmation(task)) return "待确认画面";
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

  function taskOutput(task) {
    return [task?.output, task?.output_data, task?.result]
      .find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)) || {};
  }

  function fusionImagesFromTask(task) {
    const output = [task?.output, task?.output_data, task?.result]
      .find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)) || {};
    const rawResult = output?.raw_result && typeof output.raw_result === "object" ? output.raw_result : {};
    const checkpoint = output?.video_checkpoint && typeof output.video_checkpoint === "object" ? output.video_checkpoint : {};
    const candidates = [
      task?.fusion_images,
      task?.digital_human_fusion_image_paths,
      output.fusion_images,
      output.digital_human_fusion_image_paths,
      rawResult.fusion_images,
      rawResult.digital_human_fusion_image_paths,
      checkpoint.fusion_images,
      checkpoint.digital_human_fusion_image_paths,
    ];
    const images = candidates.find((value) => Array.isArray(value) && value.length) || [];
    return images.map((value) => String(value || "").trim()).filter(Boolean);
  }

  function taskRawResult(task) {
    const output = taskOutput(task);
    return output?.raw_result && typeof output.raw_result === "object" ? output.raw_result : {};
  }

  function digitalHumanStageFromTask(task) {
    const listedStage = String(task?.video_stage || "").trim();
    if (["visual_review", "digital_human_visual_review"].includes(listedStage)) return "visual_review";
    return String(taskRawResult(task).digital_human_stage || "").trim();
  }

  function expectedDigitalHumanFusionCount(task) {
    const input = task?.input && typeof task.input === "object" ? task.input : {};
    return Math.min(Math.max(Number(input.digital_human_fusion_count || (input.digital_human_short_mode === "storyboard" ? 4 : 1)), 1), 4);
  }

  function seedingStageFromTask(task) {
    const listedStage = String(task?.video_stage || "").trim();
    if (listedStage === "images_only") return "images_only";
    return String(taskRawResult(task).seeding_stage || "").trim();
  }

  function seedingImagesFromTask(task) {
    const output = taskOutput(task);
    const raw = taskRawResult(task);
    const images = [raw.generated_scene_image_paths, output.image_paths, task?.image_paths]
      .find((value) => Array.isArray(value) && value.length) || [];
    return images.map((value) => String(value || "").trim()).filter(Boolean);
  }

  function normalizeSubtitleTemplate(value) {
    const template = String(value || "").trim();
    return SUBTITLE_TEMPLATE_OPTIONS.some(([key]) => key === template) ? template : "";
  }

  function subtitleTemplateFromTask(task) {
    const output = taskOutput(task);
    const input = task?.input && typeof task.input === "object" ? task.input : {};
    const params = task?.params && typeof task.params === "object" ? task.params : {};
    const outputParams = output?.params && typeof output.params === "object" ? output.params : {};
    return [task?.subtitleTemplate, input.subtitle_template, params.subtitle_template, output.subtitle_template, outputParams.subtitle_template]
      .map(normalizeSubtitleTemplate)
      .find(Boolean) || "split_hook";
  }

  function taskHasVideoOutput(task) {
    if ((task?.mediaItems || []).some((item) => item?.type === "video")) return true;
    const taskType = String(task?.type || task?.task_type || task?.moduleId || "");
    const output = taskOutput(task);
    const rawStage = String(output?.raw_result?.digital_human_stage || output?.raw_result?.seeding_stage || task?.video_stage || "").trim();
    if (["visual_review", "digital_human_visual_review", "images_only", "seeding_images_only"].includes(rawStage)) return false;
    const outputPaths = [output.download_path, output.video_path, output.output_path, task?.download_url, task?.output_url];
    const listPaths = [output.video_paths, output.result_paths].filter(Array.isArray).flat();
    const hasVideoPath = [...outputPaths, ...listPaths]
      .some((value) => /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/i.test(String(value || "")));
    return hasVideoPath || (VIDEO_OUTPUT_TASK_TYPES.has(taskType) && Boolean(task?.has_video_output));
  }

  function canAddSubtitlesToTask(task) {
    if (!task || task.status !== "success" || !task.has_download) return false;
    if (!task.subtitleStateKnown || task.subtitled) return false;
    return taskHasVideoOutput(task);
  }

  function segmentRows(candidate) {
    if (Array.isArray(candidate)) return candidate;
    if (!candidate || typeof candidate !== "object") return [];
    for (const key of ["items", "segments", "shots"]) {
      if (Array.isArray(candidate[key])) return candidate[key];
    }
    return [];
  }

  function taskSegments(task, result, status) {
    const output = task?.output_data && typeof task.output_data === "object" ? task.output_data : {};
    const rawResult = [task?.raw_result, result?.raw_result, output?.raw_result]
      .find((candidate) => candidate && typeof candidate === "object") || {};
    const completed = [task?.completed_segments, result?.completed_segments, output?.completed_segments, rawResult?.completed_segments]
      .map(segmentRows)
      .find((rows) => rows.length) || [];
    const planned = [
      task?.segments, result?.segments, output?.segments, rawResult?.segments,
      task?.storyboard, result?.storyboard, output?.storyboard, rawResult?.storyboard,
      task?.segment_scripts, result?.segment_scripts, output?.segment_scripts, rawResult?.segment_scripts,
      task?.prompt_segments, result?.prompt_segments, output?.prompt_segments, rawResult?.prompt_segments,
    ]
      .map(segmentRows)
      .find((rows) => rows.length) || [];
    const segmentIndex = (segment, fallback) => {
      const row = segment && typeof segment === "object" ? segment : {};
      const value = Number(row.index ?? row.segment_index ?? row.segmentIndex ?? segment);
      return Number.isInteger(value) && value > 0 ? value : fallback;
    };
    const completedByIndex = new Map(completed.map((segment, index) => [segmentIndex(segment, index + 1), segment]));
    const failedIndices = [
      task?.missing_segment_indices, result?.missing_segment_indices, output?.missing_segment_indices, rawResult?.missing_segment_indices,
      task?.failed_segment_indices, result?.failed_segment_indices, output?.failed_segment_indices, rawResult?.failed_segment_indices,
    ].filter(Array.isArray).flat().map(Number).filter((value) => Number.isInteger(value) && value > 0);
    const declaredCount = Number(task?.segment_count || result?.segment_count || output?.segment_count || rawResult?.segment_count || 0);
    const source = planned.length
      ? [...planned]
      : (Number.isInteger(declaredCount) && declaredCount > 0
        ? Array.from({ length: declaredCount }, (_, index) => ({ index: index + 1 }))
        : [...completed]);
    const knownIndices = new Set(source.map((segment, index) => segmentIndex(segment, index + 1)));
    failedIndices.forEach((index) => {
      if (!knownIndices.has(index)) source.push({ index, status: "failed" });
    });
    source.sort((left, right) => segmentIndex(left, 0) - segmentIndex(right, 0));
    const failedTask = ["failed", "error", "cancelled", "canceled"].includes(status);
    const hasDeclaredPlan = planned.length > 0 || declaredCount > 0 || failedIndices.length > 0;
    return source.map((segment, index) => {
      const row = segment && typeof segment === "object" ? segment : {};
      const fallbackIdentity = { endpointIndex: index + 1 };
      const endpointIndex = segmentIndex(segment, fallbackIdentity.endpointIndex);
      const completedRow = completedByIndex.get(endpointIndex);
      const explicitStatus = String(row.status || row.state || "").toLowerCase();
      const segmentStatus = explicitStatus || (completedRow ? "success" : (failedTask && hasDeclaredPlan ? "failed" : ""));
      return {
        ...row,
        ...(completedRow && typeof completedRow === "object" ? completedRow : {}),
        id: String(row.id || row.segment_id || endpointIndex),
        endpointIndex,
        label: String(row.label || row.title || row.shot || row.text || `片段 ${endpointIndex}`),
        status: segmentStatus,
      };
    });
  }

  function normalizeTask(task, source) {
    const id = String(task?.id || task?.task_id || task?.uuid || "");
    const taskType = String(task?.task_type || task?.type || "");
    const input = task?.input && typeof task.input === "object" ? task.input : {};
    const imageMode = String(input.video_image_mode || input.image_mode || input.mode || "");
    const inferredImageModule = imageMode === "subject_replace"
      ? "subject_replace"
      : imageMode === "poster_translate"
        ? "poster_translate"
        : ["digital_human_character", "three_view"].includes(imageMode)
          ? "subject_generate"
          : ["product_only", "model_product", "single_reference", "dual_reference"].includes(imageMode)
            ? "ecommerce_image"
            : "";
    const moduleId = String(
      task?.module
      || task?.module_id
      || task?.video_module
      || (taskType === "image_generate" ? inferredImageModule : "")
      || taskType
      || ""
    );
    const result = task?.result && typeof task.result === "object" ? task.result : {};
    const output = taskOutput(task);
    const subtitleStateKnown = Boolean(
      task?.subtitleStateKnown
      || Object.prototype.hasOwnProperty.call(task || {}, "subtitled")
      || Object.prototype.hasOwnProperty.call(output, "subtitled")
      || Object.prototype.hasOwnProperty.call(output, "subtitles_applied")
    );
    const fusionStateKnown = Boolean(
      task?.fusionStateKnown
      || Object.prototype.hasOwnProperty.call(task || {}, "output")
      || Object.prototype.hasOwnProperty.call(task || {}, "fusion_images")
      || Object.prototype.hasOwnProperty.call(output, "fusion_images")
      || Object.prototype.hasOwnProperty.call(output, "video_checkpoint")
      || Object.prototype.hasOwnProperty.call(output, "raw_result")
    );
    const status = taskStatus(task);
    const mediaKey = taskMediaKey({ id }, source);
    const directMediaItems = normalizeMediaItems(task);
    if (directMediaItems.length) state.taskMedia[mediaKey] = directMediaItems;
    return {
      ...task,
      id,
      moduleId,
      source,
      status,
      title: String(task?.title || task?.name || task?.workflow_name || FALLBACK_MODULES[moduleId]?.label || humanize(moduleId) || "视频任务"),
      createdAt: task?.created_at || task?.createdAt || task?.updated_at || task?.updatedAt || "",
      progress: Number(task?.progress ?? task?.progress_percent ?? task?.percent ?? 0),
      mediaItems: directMediaItems.length ? directMediaItems : (state.taskMedia[mediaKey] || []),
      subtitleStateKnown,
      subtitled: Boolean(task?.subtitled || output?.subtitled || output?.subtitles_applied),
      subtitleTemplate: subtitleTemplateFromTask(task),
      fusionStateKnown,
      fusionImages: fusionImagesFromTask(task),
      seedingStage: seedingStageFromTask(task),
      seedingImages: seedingImagesFromTask(task),
      segments: taskSegments(task, result, status),
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

  function renderSubtitleTemplateModal() {
    if (!state.subtitleModalTaskId) return "";
    const task = state.tasks.find((item) => item.id === state.subtitleModalTaskId);
    if (!task) return "";
    return `<div class="console-modal video-voice-modal" data-video-subtitle-modal>
      <div class="console-modal-backdrop" data-video-subtitle-close></div>
      <section class="console-modal-dialog video-voice-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="videoSubtitleModalTitle">
        <div class="console-modal-head">
          <div><span>SUBTITLE</span><strong id="videoSubtitleModalTitle">添加字幕</strong><small>选择字幕模板后，将在现有成片上生成字幕版视频。</small></div>
          <button type="button" class="console-modal-close" data-video-subtitle-close title="关闭" aria-label="关闭字幕设置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12"></path><path d="m18 6-12 12"></path></svg></button>
        </div>
        <div class="console-modal-content video-voice-modal-content">
          <label class="video-form-field video-form-field--wide">
            <span>字幕模板</span>
            <select data-video-subtitle-template>${SUBTITLE_TEMPLATE_OPTIONS.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === state.subtitleTemplate ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select>
            <small>字幕仅添加到当前成功视频，不会改变初始生成参数。</small>
          </label>
          ${state.subtitleError ? `<div class="video-inline-error" role="alert">${escapeHtml(state.subtitleError)}</div>` : ""}
        </div>
        <div class="console-modal-actions">
          <button type="button" class="primary" data-video-subtitle-confirm ${state.subtitleSubmitting ? "disabled" : ""}>${state.subtitleSubmitting ? "正在添加字幕…" : "确认添加字幕"}</button>
          <button type="button" data-video-subtitle-close ${state.subtitleSubmitting ? "disabled" : ""}>取消</button>
        </div>
      </section>
    </div>`;
  }

  function renderFusionViewActions(task) {
    const fusionImages = Array.isArray(task?.fusionImages) ? task.fusionImages : [];
    if (!task?.id || !["create_video", "digital_human_video"].includes(task.moduleId) || !fusionImages.length) return "";
    const input = task?.input && typeof task.input === "object" ? task.input : {};
    const expected = Math.min(Math.max(Number(input.digital_human_fusion_count || (input.digital_human_short_mode === "storyboard" ? 4 : 1)), 1), 4);
    const mainBusy = Boolean(state.fusionViewBusy[`${task.id}:main`]);
    const viewsBusy = Boolean(state.fusionViewBusy[`${task.id}:views`]);
    const mainHistory = state.fusionHistory[`${task.id}:1`];
    return `<div class="video-task-segments video-task-fusion-views"><span>数字人视角</span>
      <button type="button" data-video-task-fusion-step="fusion_main" data-video-task-id="${escapeHtml(task.id)}" ${mainBusy ? "disabled" : ""}>${mainBusy ? "正在重生成主图…" : "重生成主图"}</button>
      <button type="button" data-video-fusion-history data-video-task-id="${escapeHtml(task.id)}" data-video-asset-index="1">主图历史</button>
      ${Array.isArray(mainHistory) ? `<div class="video-task-seeding-history">${mainHistory.map((item, index) => `<button type="button" data-video-fusion-history-use data-video-task-id="${escapeHtml(task.id)}" data-video-asset-index="1" data-video-history-path="${escapeHtml(item.path)}"><span>${index === 0 ? "当前/最近主图" : `历史主图 ${index + 1}`}</span></button>`).join("")}</div>` : ""}
      ${fusionImages.length < expected ? `<button type="button" data-video-task-fusion-step="fusion_views" data-video-task-id="${escapeHtml(task.id)}" ${viewsBusy ? "disabled" : ""}>${viewsBusy ? "正在生成分镜图…" : `生成剩余分镜图（${fusionImages.length}/${expected}）`}</button>` : ""}
      ${fusionImages.slice(1).map((image, offset) => {
      const viewIndex = offset + 2;
      const busy = Boolean(state.fusionViewBusy[`${task.id}:${viewIndex}`]);
      const history = state.fusionHistory[`${task.id}:${viewIndex}`];
      return `<button type="button" data-video-task-fusion-view data-video-task-id="${escapeHtml(task.id)}" data-video-fusion-view-index="${viewIndex}" ${busy ? "disabled" : ""}>${busy ? `正在重生成视角 ${viewIndex}…` : `重生成视角 ${viewIndex}`}</button><button type="button" data-video-fusion-history data-video-task-id="${escapeHtml(task.id)}" data-video-asset-index="${viewIndex}">视角 ${viewIndex} 历史</button>${Array.isArray(history) ? `<div class="video-task-seeding-history">${history.map((item, index) => `<button type="button" data-video-fusion-history-use data-video-task-id="${escapeHtml(task.id)}" data-video-asset-index="${viewIndex}" data-video-history-path="${escapeHtml(item.path)}"><span>${index === 0 ? `当前/最近视角 ${viewIndex}` : `历史视角 ${viewIndex}-${index + 1}`}</span></button>`).join("")}</div>` : ""}`;
    }).join("")}</div>`;
  }

  async function loadFusionHistory(taskId, assetIndex) {
    const key = `${taskId}:${assetIndex}`;
    const payload = await request(`/api/video/tasks/${encodeURIComponent(taskId)}/digital-human/assets/${encodeURIComponent(assetIndex)}/history`);
    state.fusionHistory[key] = Array.isArray(payload?.items) ? payload.items : [];
    renderTaskPanelOnly();
  }

  async function useFusionHistory(taskId, assetIndex, path) {
    await request(`/api/video/tasks/${encodeURIComponent(taskId)}/digital-human/assets/${encodeURIComponent(assetIndex)}/use`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    invalidateTaskMedia(taskId);
    await loadTasks({ quiet: true });
    await loadFusionHistory(taskId, assetIndex);
  }

  function mediaFileName(value) {
    return String(value || "").split(/[\\/]/).pop()?.split(/[?#]/)[0] || "";
  }

  function imageMediaForPath(task, path, fallbackIndex = 0) {
    const images = (task?.mediaItems || []).filter((item) => item?.type === "image");
    const fileName = mediaFileName(path);
    return images.find((item) => mediaFileName(item.label) === fileName)
      || images[Math.max(0, Number(fallbackIndex) || 0)]
      || null;
  }

  function renderSeedingSceneActions(task) {
    const images = Array.isArray(task?.seedingImages) ? task.seedingImages : [];
    const input = task?.input && typeof task.input === "object" ? task.input : {};
    if (!task?.id || task.seedingStage !== "images_only" || !images.length || Number(input.ecommerce_seeding_regenerate_scene_index || 0)) return "";
    return `<div class="video-task-segments video-task-seeding-scenes"><span>种草分镜图</span>${images.map((image, offset) => {
      const sceneIndex = offset + 1;
      const busyKey = `${task.id}:${sceneIndex}`;
      const busy = Boolean(state.seedingSceneBusy[busyKey]);
      const history = state.seedingHistory[busyKey];
      const sceneMedia = imageMediaForPath(task, image, offset);
      const scenePreviewUrl = authenticatedMediaUrl(sceneMedia?.thumbnailUrl || sceneMedia?.url);
      return `<div class="video-task-seeding-scene">
        <strong>分镜图 ${sceneIndex}</strong>
        ${scenePreviewUrl ? `<figure class="video-task-media-item is-image"><img src="${escapeHtml(scenePreviewUrl)}" alt="分镜图 ${sceneIndex}" loading="lazy" decoding="async"><figcaption>当前分镜图 ${sceneIndex}</figcaption></figure>` : ""}
        <button type="button" data-video-seeding-regenerate data-video-task-id="${escapeHtml(task.id)}" data-video-scene-index="${sceneIndex}" ${busy ? "disabled" : ""}>重新生成</button>
        <button type="button" data-video-seeding-upload data-video-task-id="${escapeHtml(task.id)}" data-video-scene-index="${sceneIndex}" ${busy ? "disabled" : ""}>上传替换</button>
        <button type="button" data-video-seeding-history data-video-task-id="${escapeHtml(task.id)}" data-video-scene-index="${sceneIndex}" ${busy ? "disabled" : ""}>历史素材</button>
        ${Array.isArray(history) ? `<div class="video-task-seeding-history">${history.map((item, itemIndex) => {
          const previewUrl = authenticatedMediaUrl(item.previewUrl);
          const label = item.source === "regenerated" ? `重生成 ${itemIndex + 1}` : item.source === "uploaded" ? `上传素材 ${itemIndex + 1}` : `当前/历史 ${itemIndex + 1}`;
          return `<button type="button" data-video-seeding-use data-video-task-id="${escapeHtml(task.id)}" data-video-scene-index="${sceneIndex}" data-video-seeding-path="${escapeHtml(item.path)}">${previewUrl ? `<img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(label)}" width="72" height="72" loading="lazy" decoding="async">` : ""}<span>${escapeHtml(label)}</span></button>`;
        }).join("")}</div>` : ""}
      </div>`;
    }).join("")}</div>`;
  }

  function canRegenerateTaskSegments(task) {
    const type = String(task?.type || task?.task_type || task?.moduleId || "");
    return type === "create_video" || type === "digital_human_video";
  }

  function renderTaskList() {
    if (state.taskLoading && !state.tasks.length) {
      return `<div class="video-workbench-state video-workbench-state--loading"><span class="video-workbench-loader" aria-hidden="true"></span><strong>正在读取任务</strong><span>同步规划与执行状态...</span></div>`;
    }
    if (state.taskError && !state.tasks.length) {
      return `<div class="video-workbench-state video-workbench-state--error"><span class="video-state-symbol" aria-hidden="true">${workbenchIcon("alert")}</span><strong>任务加载失败</strong><span>${escapeHtml(state.taskError)}</span><button type="button" class="video-button video-button--ghost" data-video-refresh>重新加载</button></div>`;
    }
    const matchingTasks = state.tasks.filter((task) => !task.moduleId || task.moduleId === state.moduleId || relevantRegularTask(task));
    const pageSize = 50;
    const pageCount = Math.max(Math.ceil(matchingTasks.length / pageSize), 1);
    state.taskPage = Math.min(Math.max(Number(state.taskPage) || 1, 1), pageCount);
    const visibleTasks = matchingTasks.slice((state.taskPage - 1) * pageSize, state.taskPage * pageSize);
    if (!visibleTasks.length) {
      return `<div class="video-workbench-state video-workbench-state--empty"><span class="video-state-symbol" aria-hidden="true">${workbenchIcon("add")}</span><strong>暂无任务</strong><span>提交后，规划与执行进度会显示在这里。</span></div>`;
    }
    return `<div class="video-task-list">${visibleTasks.map((task) => {
      const status = task.status;
      const reviewKind = taskNeedsVisualConfirmation(task);
      const statusTone = reviewKind ? "review" : status;
      const progress = Math.max(0, Math.min(100, Number.isFinite(task.progress) ? task.progress : 0));
      const downloadUrl = authenticatedMediaUrl(task.download_url || task.output_url || (task.id ? `/api/tasks/${encodeURIComponent(task.id)}/download` : ""));
      const canDownload = Boolean(task.has_download || task.download_url || task.output_url) && Boolean(downloadUrl);
      const canCancel = task.id && ACTIVE_STATUSES.has(status);
      const canResume = task.id && ["failed", "cancelled", "canceled"].includes(status);
      const canAddSubtitles = task.id && canAddSubtitlesToTask(task);
      const awaitingDigitalVisuals = task.id
        && status === "success"
        && digitalHumanStageFromTask(task) === "visual_review"
        && (task.fusionImages || []).length >= expectedDigitalHumanFusionCount(task);
      const awaitingSeedingVisuals = task.id && status === "success" && seedingStageFromTask(task) === "images_only";
      const seedingInput = task?.input && typeof task.input === "object" ? task.input : {};
      const canFinalizeSeedingVisuals = awaitingSeedingVisuals && !Number(seedingInput.ecommerce_seeding_regenerate_scene_index || 0);
      const workflowBusy = Boolean(state.workflowBusy[task.id]);
      const canRegenerateSegments = canRegenerateTaskSegments(task);
      const failedSegments = (task.segments || []).filter((segment) => !segment.status || ["failed", "error", "cancelled", "canceled"].includes(segment.status));
      const completedSegments = status === "success"
        ? (task.segments || []).filter((segment) => segment.status === "success")
        : [];
      return `<article class="video-task-card" data-video-task-id="${escapeHtml(task.id)}">
        <div class="video-task-card-head">
          <span class="video-task-source">${task.source === "video" ? "视频规划" : "执行队列"}</span>
          <span class="video-task-status is-${escapeHtml(statusTone)}"><i aria-hidden="true"></i>${escapeHtml(statusCopy(status, task))}</span>
        </div>
        <strong>${escapeHtml(task.title)}</strong>
        <small>${escapeHtml(task.id || "待分配任务 ID")} · ${escapeHtml(formatTime(task.createdAt))}</small>
        ${ACTIVE_STATUSES.has(status) ? `<div class="video-task-progress"><span style="width:${progress || 8}%"></span></div>` : ""}
        ${reviewKind ? `<p class="video-task-stage-note">${reviewKind === "digital-human" ? "数字人画面已生成，尚未合成最终视频。请确认画面后继续生成。" : "分镜图已生成，尚未合成最终视频。请确认分镜图后继续生成。"}</p>` : ""}
        ${renderTaskMedia(task)}
        ${renderFusionViewActions(task)}
        ${renderSeedingSceneActions(task)}
        <div class="video-task-actions">
          ${canDownload ? `<a class="video-task-download" href="${escapeHtml(downloadUrl)}">下载结果</a>` : ""}
          ${awaitingDigitalVisuals ? `<button type="button" class="video-task-action" data-video-task-finalize="digital-human" data-video-task-id="${escapeHtml(task.id)}" ${workflowBusy ? "disabled" : ""}>${workflowBusy ? "正在提交…" : "确认画面并生成视频"}</button>` : ""}
          ${canFinalizeSeedingVisuals ? `<button type="button" class="video-task-action" data-video-task-finalize="seeding" data-video-task-id="${escapeHtml(task.id)}" ${workflowBusy ? "disabled" : ""}>${workflowBusy ? "正在提交…" : "确认分镜图并生成视频"}</button>` : ""}
          ${canAddSubtitles ? `<button type="button" class="video-task-action" data-video-task-subtitle="${escapeHtml(task.id)}">添加字幕</button>` : ""}
          ${canCancel ? `<button type="button" class="video-task-action" data-video-task-action="cancel" data-video-task-id="${escapeHtml(task.id)}">取消任务</button>` : ""}
          ${canResume ? `<button type="button" class="video-task-action" data-video-task-action="retry" data-video-task-id="${escapeHtml(task.id)}">失败续跑</button>` : ""}
        </div>
        ${canRegenerateSegments && canResume && failedSegments.length ? `<div class="video-task-segments"><span>失败片段</span>${failedSegments.slice(0, 8).map((segment) => `<button type="button" data-video-task-segment-regenerate data-video-task-id="${escapeHtml(task.id)}" data-video-segment-id="${escapeHtml(segment.endpointIndex)}">${escapeHtml(segment.label)} · 重生成</button>`).join("")}</div>` : ""}
        ${canRegenerateSegments && completedSegments.length > 1 ? `<div class="video-task-segments"><span>已完成片段</span>${completedSegments.slice(0, 8).map((segment) => `<button type="button" data-video-task-segment-regenerate data-video-task-id="${escapeHtml(task.id)}" data-video-segment-id="${escapeHtml(segment.endpointIndex)}">${escapeHtml(segment.label)} · 重生成</button>`).join("")}</div>` : ""}
      </article>`;
    }).join("")}</div>${pageCount > 1 ? `<div class="video-task-pagination"><button type="button" data-video-task-page="${state.taskPage - 1}" ${state.taskPage <= 1 ? "disabled" : ""}>上一页</button><span>${state.taskPage} / ${pageCount}</span><button type="button" data-video-task-page="${state.taskPage + 1}" ${state.taskPage >= pageCount ? "disabled" : ""}>下一页</button></div>` : ""}`;
  }

  function renderTaskPanel() {
    return `<aside class="video-task-panel">
      <div class="video-task-panel-head">
        <div><span>LIVE QUEUE</span><strong>任务动态</strong></div>
        ${["ecommerce_image", "subject_replace", "poster_translate", "subject_generate"].includes(state.moduleId) ? '<button type="button" class="video-icon-button" data-video-image-history-open aria-label="图片历史" title="图片历史">历史</button>' : ""}
        <button type="button" class="video-icon-button" data-video-refresh aria-label="刷新任务" title="刷新任务">${workbenchIcon("refresh")}</button>
      </div>
      ${state.taskWarning ? `<div class="video-task-warning">${escapeHtml(state.taskWarning)}</div>` : ""}
      ${renderTaskList()}
    </aside>`;
  }

  function renderTaskPanelOnly() {
    const current = document.querySelector("#videoWorkbenchRoot .video-task-panel");
    if (!current) {
      render();
      return;
    }
    const currentList = current.querySelector(".video-task-list");
    const scrollTop = currentList?.scrollTop || 0;
    const template = document.createElement("template");
    template.innerHTML = renderTaskPanel().trim();
    const next = template.content.firstElementChild;
    if (!next) return;
    current.replaceWith(next);
    const nextList = next.querySelector(".video-task-list");
    if (nextList) nextList.scrollTop = scrollTop;
  }

  function renderWorkbenchHero(module) {
    const moduleGroup = MODULE_ORDER.indexOf(module.id) < 4 ? "视频生成" : "图片素材";
    return `<header class="video-workbench-hero">
      <div class="video-workbench-hero-mark">${moduleIcon(module.id)}</div>
      <div class="video-workbench-hero-copy">
        <span>${escapeHtml(module.kicker)}</span>
        <h3>${escapeHtml(module.label)}</h3>
        <p>${escapeHtml(module.description)}</p>
      </div>
      <div class="video-workbench-hero-meta"><span><i></i>${escapeHtml(moduleGroup)}</span><small>草稿自动保存 · 任务统一管理</small></div>
    </header>`;
  }

  function renderActiveModuleOnly() {
    const root = document.getElementById("videoWorkbenchRoot");
    const currentHero = root?.querySelector(".video-workbench-hero");
    const formPanel = root?.querySelector(".video-form-panel");
    if (!root || !currentHero || !formPanel) {
      render();
      return;
    }
    const module = currentModule();
    loadDraft(module);
    const template = document.createElement("template");
    template.innerHTML = renderWorkbenchHero(module).trim();
    const nextHero = template.content.firstElementChild;
    if (nextHero) currentHero.replaceWith(nextHero);
    formPanel.innerHTML = renderForm(module);
  }

  function render() {
    const root = document.getElementById("videoWorkbenchRoot");
    if (!root) return;
    if (state.moduleLoading && !state.initialized) {
      root.innerHTML = `<div class="video-workbench-state video-workbench-state--loading"><span class="video-workbench-loader" aria-hidden="true"></span><strong>正在准备视频工作台</strong><span>读取可用模块与任务规划...</span></div>`;
      return;
    }
    const module = currentModule();
    const draft = loadDraft(module);
    state.playingVoiceId = "";
    const voiceFields = resolvedFields(module, draft.values).filter((field) => field.type !== "file" && field.placement === "voice");
    root.innerHTML = `<div class="video-workbench-shell">
      ${renderWorkbenchHero(module)}
      ${state.moduleError ? `<div class="video-catalog-notice is-fallback"><strong>已启用本地模块配置</strong><span>在线模块目录暂不可用，当前功能与字段仍可正常使用。</span><button type="button" data-video-retry-modules>重新连接</button></div>` : ""}
      ${state.moduleEmpty ? `<div class="video-catalog-notice"><strong>模块接口返回空列表</strong><span>已显示内置的 8 个模块合同。</span></div>` : ""}
      <div class="video-workbench-grid">
        <main class="video-form-panel">${renderForm(module)}</main>
        ${renderTaskPanel()}
      </div>
    </div>
    ${renderVoiceStudio(module, draft, voiceFields)}
    ${renderSubtitleTemplateModal()}
    ${renderAssetPickerModal()}
    ${renderImageHistoryModal()}
    ${renderImagePreviewModal()}`;
    bindVoiceAudioControls();
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

  function filesMatchAccept(field, files) {
    const accept = String(field?.accept || "").trim();
    const items = Array.from(files || []).filter(Boolean);
    if (!accept) return items;
    const tokens = accept.split(",").map((item) => item.trim()).filter(Boolean);
    return items.filter((file) => {
      const type = String(file.type || "").toLowerCase();
      const name = String(file.name || "").toLowerCase();
      return tokens.some((token) => {
        if (token === "image/*") return type.startsWith("image/");
        if (token === "audio/*") return type.startsWith("audio/");
        if (token === "video/*") return type.startsWith("video/");
        if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
        if (token.startsWith(".")) return name.endsWith(token);
        return type === token;
      });
    });
  }

  function assignFilesToField(field, files, slotIndex = null) {
    const module = currentModule();
    const draft = loadDraft(module);
    const selected = filesMatchAccept(field, files);
    if (!field || !selected.length) return false;
    state.files[module.id] ||= {};
    invalidatePromptPreview(module, draft, field.key);
    if (Number.isInteger(slotIndex) && slotIndex >= 0) {
      const slotLimit = Math.max(1, Number(field.previewSlots || field.maxFiles || 1));
      if (slotIndex >= slotLimit) return false;
      const next = selectedFileSlots(module.id, field.key).slice(0, slotLimit);
      next[slotIndex] = selected[0];
      replaceFileSlots(module.id, field.key, next);
    } else {
      const limit = field.maxFiles ? Number(field.maxFiles) : (field.multiple ? selected.length : 1);
      replaceFileSlots(module.id, field.key, selected.slice(0, Math.max(1, limit)));
    }
    if (field.key === "audio") {
      delete draft.values.voice_id;
      delete draft.values.speaker;
      delete draft.values.voice_label;
      delete draft.values.voice_name;
      delete draft.values.elevenlabs_tts_preset_key;
      saveDraft(module.id);
    }
    if (module.id === "video_language_replace" && field.key === "video") {
      draft.values.video_language_script_analyzed = false;
      draft.values.video_language_script_confirmed = false;
    }
    return true;
  }

  function openFilePicker(fieldKey, slotIndex = null) {
    const module = currentModule();
    const draft = loadDraft(module);
    const field = resolvedFields(module, draft.values).find((item) => item.type === "file" && item.key === fieldKey);
    if (!field) return;
    const host = Array.from(document.querySelectorAll("#videoWorkbenchRoot [data-video-file-field]"))
      .find((item) => item.dataset.videoFileField === field.key);
    const input = host?.querySelector('input[type="file"][data-video-field]');
    if (!input) return;
    input.value = "";
    if (Number.isInteger(slotIndex) && slotIndex >= 0) {
      input.dataset.videoFileSlotTarget = String(slotIndex);
      input.multiple = false;
    } else {
      delete input.dataset.videoFileSlotTarget;
      input.multiple = Boolean(field.multiple);
    }
    input.click();
  }

  function handleFieldChange(input) {
    const module = currentModule();
    const draft = loadDraft(module);
    const field = resolvedFields(module, draft.values).find((item) => item.key === input.dataset.videoField);
    if (!field) return;
    if (field.type === "file") {
      const targetSlot = Number.parseInt(input.dataset.videoFileSlotTarget || "", 10);
      delete input.dataset.videoFileSlotTarget;
      if (!assignFilesToField(field, Array.from(input.files || []), Number.isInteger(targetSlot) ? targetSlot : null)) return;
      render();
      return;
    }
    draft.values[field.key] = readFieldValue(field, input);
    const voiceLanguageChanged = VOICE_MODULES.has(module.id) && field.key === "target_language";
    if (voiceLanguageChanged) {
      // A preset is language-bound. Do not let a previously selected voice
      // silently cross into the newly selected language.
      VOICE_PRESET_DRAFT_KEYS.forEach((key) => delete draft.values[key]);
      stopVoicePreview();
    }
    invalidatePromptPreview(module, draft, field.key);
    if (module.id === "video_language_replace" && field.key === "script_text") {
      draft.values.video_language_script_analyzed = false;
      draft.values.video_language_script_confirmed = false;
    }
    reconcileVideoCharacterOptions(draft.values, field.key);
    saveDraft(module.id);
    if (voiceLanguageChanged) {
      if (state.voiceModalOpen) refreshVoicePresetListInPlace(module, draft);
      else render();
      return;
    }
    if (isPillSelectField(field) || DYNAMIC_SELECT_KEYS.has(field.key)) render();
  }

  function clearSelectedFiles(moduleId) {
    const module = state.modules.find((item) => item.id === moduleId) || FALLBACK_MODULES[moduleId];
    const draft = module ? loadDraft(module) : null;
    if (module && draft) invalidatePromptPreview(module, draft);
    releaseModuleFilePreviews(moduleId);
    state.files[moduleId] = {};
    void clearPersistedModuleFiles(moduleId);
    render();
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
    const language = String(draft.values.target_language || draft.values.language || "").trim().toLowerCase();
    if (!voice || !voiceMatchesLanguage(voice, language)) return;
    draft.values.voice_id = voice.voiceId;
    draft.values.speaker = voice.voiceName;
    draft.values.voice_label = voice.label;
    draft.values.voice_name = voice.voiceName;
    draft.values.elevenlabs_tts_preset_key = voice.id;
    draft.values.elevenlabs_tts_voice_id = voice.voiceId;
    draft.values.minimax_tts_voice_id = "";
    replaceFileSlots(module.id, "audio", []);
    stopVoicePreview();
    saveDraft(module.id);
    render();
  }

  function previewVoice(voiceId) {
    const voice = state.voicePresets.find((item) => item.id === voiceId || item.voiceId === voiceId);
    const audio = document.getElementById("videoVoicePreview");
    if (!voice?.previewUrl || !audio) return;
    if (audio.dataset.videoVoiceCurrent === voice.id && !audio.paused) {
      delete audio.dataset.videoVoiceSwitching;
      audio.pause();
      state.playingVoiceId = "";
      updateVoicePlaybackButtons();
      return;
    }
    audio.dataset.videoVoiceSwitching = "1";
    if (!audio.paused) audio.pause();
    state.playingVoiceId = "";
    updateVoicePlaybackButtons();
    const previewUrl = new URL(voice.previewUrl, window.location.href).href;
    if (audio.src !== previewUrl) {
      audio.src = previewUrl;
      audio.currentTime = 0;
    }
    audio.dataset.videoVoiceCurrent = voice.id;
    state.playingVoiceId = voice.id;
    updateVoicePlaybackButtons();
    const playback = audio.play();
    playback?.catch(() => {
      if (state.playingVoiceId !== voice.id) return;
      delete audio.dataset.videoVoiceSwitching;
      state.playingVoiceId = "";
      updateVoicePlaybackButtons();
    });
  }

  function openVoiceStudio() {
    const { draft } = advancedDraft();
    const language = String(draft.values.target_language || draft.values.language || "").trim().toLowerCase();
    const selected = selectedVoiceForDraft(draft, "");
    if (language && selected && !voiceMatchesLanguage(selected, language)) {
      VOICE_PRESET_DRAFT_KEYS.forEach((key) => delete draft.values[key]);
      saveDraft(currentModule().id);
    }
    state.voiceModalOpen = true;
    render();
    window.requestAnimationFrame(() => document.querySelector("[data-video-voice-modal] .console-modal-close")?.focus());
  }

  function closeVoiceStudio() {
    if (!state.voiceModalOpen) return;
    state.voiceModalOpen = false;
    render();
    window.requestAnimationFrame(() => document.querySelector("[data-video-open-voice]")?.focus());
  }

  function setTimelineRows(module, draft, rows) {
    draft.values.subtitle_segments = normalizeTimelineRows(rows);
    draft.values.script_segments = draft.values.subtitle_segments;
    saveDraft(module.id);
  }

  async function parseCurrentScript() {
    const { module, draft } = advancedDraft();
    const source = scriptSource(module, draft.values);
    let rows = parseTimedScript(source);
    if (rows.length && module.id === "video_language_replace") {
      draft.values.script_text = String(source || "").trim();
      draft.values.source_script = draft.values.script_text;
      draft.values.video_language_script_step = "inline_timecodes";
    }
    if (!rows.length && module.id === "video_language_replace") {
      const sourceVideo = selectedFiles(module.id, "video")[0];
      if (!sourceVideo) {
        state.submitError = "请先上传原视频，再解析台词和时间戳";
        showVideoError(null, state.submitError, "无法解析台词");
        render();
        return false;
      }
      const progress = openVideoProgress("正在解析台词和时间轴", [
        "正在读取原视频和脚本内容…",
        "正在分析台词时间点，请稍候…",
        "正在整理可编辑时间轴…",
      ]);
      try {
        const body = new FormData();
        body.append("params_json", JSON.stringify(draft.values || {}));
        body.append("files", sourceVideo);
        const analyzed = await request("/api/video/language-script/analyze", { method: "POST", body });
        const params = analyzed?.params && typeof analyzed.params === "object" ? analyzed.params : {};
        draft.values.script_text = String(params.script_text || params.source_script || "");
        draft.values.source_script = draft.values.script_text;
        rows = normalizeTimelineRows(params.video_language_source_segments || []);
        draft.values.video_language_script_step = params.video_language_script_step || "parsed";
        updateVideoSuccess(progress, "台词解析完成", "已生成可编辑的台词时间轴。", "请检查时间轴后再提交生成任务。");
      } catch (error) {
        state.submitError = showVideoError(error, "原视频台词解析失败：请检查视频和音频内容后重试。", "台词解析失败", progress);
        render();
        return false;
      }
    }
    if (!rows.length) {
      state.submitError = "请先填写脚本或口播文案，再解析时间轴";
      showVideoError(null, state.submitError, "无法解析时间轴");
      render();
      return false;
    } else {
      state.submitError = "";
      setTimelineRows(module, draft, rows);
      if (module.id === "video_language_replace") {
        draft.values.video_language_script_analyzed = true;
        draft.values.video_language_script_confirmed = false;
        saveDraft(module.id);
      }
    }
    render();
    return true;
  }

  async function finalizeVisualTask(taskId, kind) {
    const id = String(taskId || "");
    if (!id || state.workflowBusy[id]) return;
    state.workflowBusy[id] = true;
    state.taskError = "";
    renderTaskPanelOnly();
    const progress = openVideoProgress("正在创建视频任务", [
      "正在确认已选画面…",
      "正在提交视频生成任务…",
      "正在排入处理队列，请稍候…",
    ]);
    try {
      await submitVisualFinalizeTask(id, kind, progress, state.moduleId, "最终视频");
    } catch (error) {
      state.taskError = showVideoError(error, "确认画面后创建视频任务失败：请检查素材和余额后重试。", "视频任务提交失败", progress);
    } finally {
      delete state.workflowBusy[id];
      renderTaskPanelOnly();
    }
  }

  async function regenerateSeedingScene(taskId, sceneIndex) {
    const key = `${taskId}:${sceneIndex}`;
    if (state.seedingSceneBusy[key]) return;
    state.seedingSceneBusy[key] = true;
    renderTaskPanelOnly();
    const progress = openVideoProgress("正在重新生成分镜图", [
      `正在准备分镜图 ${sceneIndex}…`,
      "正在调用图片生成服务…",
      "正在保存新的分镜素材…",
    ]);
    try {
      await request(`/api/video/tasks/${encodeURIComponent(taskId)}/seeding-images/${encodeURIComponent(sceneIndex)}/regenerate`, { method: "POST" });
      state.taskWarning = `分镜图 ${sceneIndex} 已进入重生成队列，完成后可在历史素材中选用。`;
      await loadTasks({ quiet: true });
      updateVideoSuccess(progress, "分镜图已提交重生成", state.taskWarning, "生成完成后可在历史素材中选择使用。");
    } catch (error) {
      state.taskError = showVideoError(error, `分镜图 ${sceneIndex} 重生成失败：请检查素材和余额后重试。`, "分镜图生成失败", progress);
    } finally {
      delete state.seedingSceneBusy[key];
      renderTaskPanelOnly();
    }
  }

  function uploadSeedingScene(taskId, sceneIndex) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", async () => {
      const image = input.files?.[0];
      if (!image) return;
      const key = `${taskId}:${sceneIndex}`;
      state.seedingSceneBusy[key] = true;
      renderTaskPanelOnly();
      const progress = openVideoProgress("正在上传替换分镜图", [
        `正在上传分镜图 ${sceneIndex}…`,
        "正在校验图片内容…",
        "正在更新任务素材…",
      ]);
      try {
        const body = new FormData();
        body.append("image", image);
        await request(`/api/video/tasks/${encodeURIComponent(taskId)}/seeding-images/${encodeURIComponent(sceneIndex)}/upload`, { method: "POST", body });
        delete state.seedingHistory[key];
        invalidateTaskMedia(taskId);
        await loadTasks({ quiet: true });
        updateVideoSuccess(progress, "分镜图替换完成", `分镜图 ${sceneIndex} 已替换成功。`, "可以继续检查或提交后续视频生成。");
      } catch (error) {
        state.taskError = showVideoError(error, `分镜图 ${sceneIndex} 上传替换失败：请重新选择图片后重试。`, "分镜图替换失败", progress);
      } finally {
        delete state.seedingSceneBusy[key];
        renderTaskPanelOnly();
      }
    }, { once: true });
    input.click();
  }

  async function loadSeedingHistory(taskId, sceneIndex) {
    const key = `${taskId}:${sceneIndex}`;
    state.seedingSceneBusy[key] = true;
    renderTaskPanelOnly();
    try {
      const payload = await request(`/api/video/tasks/${encodeURIComponent(taskId)}/seeding-images/${encodeURIComponent(sceneIndex)}/history`);
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const mediaByTaskId = new Map();
      await Promise.all([...new Set(items.map((item) => String(item?.source_task_id || taskId)).filter(Boolean))].map(async (sourceTaskId) => {
        const knownTask = state.tasks.find((item) => item.id === sourceTaskId);
        let mediaItems = Array.isArray(knownTask?.mediaItems) ? knownTask.mediaItems : [];
        if (!mediaItems.length) {
          try {
            mediaItems = normalizeMediaItems(await request(`/api/tasks/${encodeURIComponent(sourceTaskId)}`));
          } catch {
            mediaItems = [];
          }
        }
        mediaByTaskId.set(sourceTaskId, mediaItems.filter((item) => item.type === "image"));
      }));
      state.seedingHistory[key] = items.map((item) => {
        const sourceTaskId = String(item?.source_task_id || taskId);
        const fileName = mediaFileName(item?.path);
        const media = (mediaByTaskId.get(sourceTaskId) || []).find((candidate) => mediaFileName(candidate.label) === fileName);
        return { ...item, previewUrl: authenticatedMediaUrl(media?.thumbnailUrl || media?.url) };
      });
    } catch (error) {
      state.taskError = showVideoError(error, `分镜图 ${sceneIndex} 历史素材读取失败：请稍后重试。`, "历史素材读取失败");
    } finally {
      delete state.seedingSceneBusy[key];
      renderTaskPanelOnly();
    }
  }

  async function useSeedingHistory(taskId, sceneIndex, path) {
    const key = `${taskId}:${sceneIndex}`;
    state.seedingSceneBusy[key] = true;
    renderTaskPanelOnly();
    try {
      await request(`/api/video/tasks/${encodeURIComponent(taskId)}/seeding-images/${encodeURIComponent(sceneIndex)}/use`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      delete state.seedingHistory[key];
      invalidateTaskMedia(taskId);
      await loadTasks({ quiet: true });
    } catch (error) {
      state.taskError = showVideoError(error, `分镜图 ${sceneIndex} 历史素材恢复失败：请稍后重试。`, "历史素材恢复失败");
    } finally {
      delete state.seedingSceneBusy[key];
      renderTaskPanelOnly();
    }
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
    setTimelineRows(module, draft, (draft.values.subtitle_segments || []).filter((item) => String(item.id) !== String(segmentId)));
    render();
  }

  async function regenerateTaskSegment(taskId, segmentId) {
    if (!taskId || !segmentId) return;
    const progress = openVideoProgress("正在重新生成视频片段", [
      "正在准备片段参数…",
      "正在调用视频生成服务…",
      "正在等待片段进入任务队列…",
    ]);
    try {
      await request(`/api/video/tasks/${encodeURIComponent(taskId)}/segments/${encodeURIComponent(segmentId)}/regenerate`, { method: "POST" });
      await loadTasks({ quiet: true });
      updateVideoSuccess(progress, "视频片段已提交重生成", "视频片段已进入重生成队列。", "完成后可在任务记录中查看结果。");
    } catch (error) {
      showVideoError(error, "片段重生成失败：请检查素材和余额后重试。", "片段重生成失败", progress);
      state.taskError = videoErrorMessage(error, "片段重生成失败：请检查素材和余额后重试。");
      renderTaskPanelOnly();
    }
  }

  async function regenerateTaskFusionView(taskId, requestedViewIndex) {
    const viewIndex = Number(requestedViewIndex);
    const task = state.tasks.find((item) => item.id === String(taskId || ""));
    if (!task || !Number.isInteger(viewIndex) || viewIndex < 2 || viewIndex > (task.fusionImages || []).length) return;
    const busyKey = `${task.id}:${viewIndex}`;
    if (state.fusionViewBusy[busyKey]) return;
    state.fusionViewBusy[busyKey] = true;
    state.taskError = "";
    state.taskWarning = "";
    renderTaskPanelOnly();
    const progress = openVideoProgress(`正在重生成视角 ${viewIndex}`, [
      `正在准备数字人视角 ${viewIndex}…`,
      "正在调用图片生成服务…",
      "正在更新任务画面，请稍候…",
    ]);
    try {
      await request("/api/video/create-video/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: task.id,
          step: "fusion_view",
          params: { digital_human_regenerate_view_index: viewIndex },
        }),
      });
      invalidateTaskMedia(taskId);
      await loadTasks({ quiet: true });
      updateVideoSuccess(progress, "数字人视角已提交重生成", `视角 ${viewIndex} 已进入生成队列。`, "生成完成后可在任务卡片中查看最新画面。");
    } catch (error) {
      state.taskError = showVideoError(error, `视角 ${viewIndex} 重生成失败：请检查素材和余额后重试。`, "视角重生成失败", progress);
      state.taskWarning = state.taskError;
    } finally {
      delete state.fusionViewBusy[busyKey];
      renderTaskPanelOnly();
    }
  }

  async function runTaskFusionStep(taskId, step) {
    const task = state.tasks.find((item) => item.id === String(taskId || ""));
    if (!task || !["fusion_main", "fusion_views"].includes(step)) return;
    const busyKey = `${task.id}:${step === "fusion_main" ? "main" : "views"}`;
    if (state.fusionViewBusy[busyKey]) return;
    state.fusionViewBusy[busyKey] = true;
    state.taskError = "";
    renderTaskPanelOnly();
    const progress = openVideoProgress(step === "fusion_main" ? "正在重生成数字人主图" : "正在生成数字人分镜图", [
      "正在准备数字人画面参数…",
      "正在调用图片生成服务…",
      "正在保存最新画面，请稍候…",
    ]);
    try {
      await request("/api/video/create-video/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: task.id, step, params: {} }),
      });
      invalidateTaskMedia(task.id);
      await loadTasks({ quiet: true });
      updateVideoSuccess(progress, "数字人画面已提交", step === "fusion_main" ? "数字人主图已进入生成队列。" : "数字人分镜图已进入生成队列。", "生成完成后可在任务卡片中查看。");
    } catch (error) {
      state.taskError = showVideoError(error, step === "fusion_main" ? "数字人主图重生成失败：请检查素材和余额后重试。" : "数字人分镜图生成失败：请检查素材和余额后重试。", "数字人画面生成失败", progress);
    } finally {
      delete state.fusionViewBusy[busyKey];
      renderTaskPanelOnly();
    }
  }

  function validate(module) {
    const draft = loadDraft(module);
    const fields = resolvedFields(module, draft.values);
    for (const field of fields) {
      if (!field.required) continue;
      if (field.type === "file" && !selectedFiles(module.id, field.key).length) {
        if (field.key === "audio" && selectedVoiceForDraft(draft)) continue;
        return `请上传${field.label}`;
      }
      if (field.type !== "file" && String(draft.values[field.key] ?? "").trim() === "") return `请填写${field.label}`;
    }
    for (const field of fields.filter((item) => item.type === "file")) {
      const count = selectedFiles(module.id, field.key).length;
      if (field.minFiles && count < Number(field.minFiles)) return `${field.label}至少需要 ${field.minFiles} 个文件`;
      if (field.maxFiles && count > Number(field.maxFiles)) return `${field.label}最多允许 ${field.maxFiles} 个文件`;
    }
    if (module.id === "subject_replace" && !selectedFiles(module.id, "replacement_product").length && !selectedFiles(module.id, "replacement_model").length) {
      return "请至少上传商品图或模特图中的一项";
    }
    return "";
  }

  function publicSubmitValues(module, draft) {
    const values = Object.fromEntries(resolvedFields(module, draft.values)
      .filter((field) => field.type !== "file")
      .map((field) => [field.key, draft.values[field.key]]));
    const selectedVoice = selectedVoiceForDraft(draft);
    if (selectedVoice) {
      values.speaker = draft.values.voice_name || draft.values.speaker || "";
      values.voice_label = draft.values.voice_label || "";
      values.preset_dry_voice = draft.values.voice_label || values.speaker;
      values.elevenlabs_tts_preset_key = draft.values.elevenlabs_tts_preset_key || "";
      values.elevenlabs_tts_voice_id = draft.values.voice_id || "";
      values.minimax_tts_voice_id = "";
    }
    if (values.minimax_tts_model) {
      values.minimax_tts_model = clampSpeechModel(values.minimax_tts_model);
      values.video_tts_model = values.minimax_tts_model;
    }
    if (module.id === "digital_human_video") {
      const oral = values.digital_human_content_mode === "oral_broadcast";
      Object.assign(values, {
        language: values.target_language,
        style_hint: "生成大片质感商业广告视频提示词。直入核心卖点，产品主画面、功能过程、使用结果和购买理由清晰，高效、有转化感。",
        ecommerce_ad_style: "standard_ecommerce",
        use_ai_copy: !String(values.speech_text || "").trim(),
        digital_human_short_mode: oral ? "single" : (values.digital_human_short_mode || "storyboard"),
        product_image_role: oral ? "scene" : "product",
        dual_model_dialogue: selectedFiles(module.id, "model").length >= 2,
        add_subtitles: false,
        subtitle_enabled: false,
        digital_human_operation: "visual_review",
      });
    } else if (module.id === "ecommerce_short_video") {
      const seeding = values.ecommerce_video_mode === "seeding_video";
      values.language = values.target_language;
      values.content_mode = seeding ? "planting" : "advertising";
      values.tg_use_llm_prompt = seeding || !String(values.prompt_text || "").trim();
      if (seeding) {
        values.add_subtitles = true;
        values.subtitle_enabled = true;
        values.ecommerce_seeding_operation = "images_only";
      } else {
        values.prompt = values.prompt_text || "";
        values.ecommerce_model = values.ecommerce_short_video_model;
        values.seedance_model = values.ecommerce_short_video_model;
      }
    } else if (module.id === "video_language_replace") {
      values.language = values.target_language;
      values.video_tts_model = clampSpeechModel(values.minimax_tts_model);
      values.script_text = String(draft.values.script_text || values.script_text || "");
      values.source_script = String(draft.values.source_script || values.script_text || "");
      values.video_language_script_analyzed = Boolean(draft.values.video_language_script_analyzed);
      values.video_language_script_confirmed = Boolean(draft.values.video_language_script_confirmed);
    } else if (module.id === "video_subject_replace") {
      values.subject_kind = values.replace_mode === "union" ? "union" : (values.replace_mode === "product" ? "product" : "model");
      if (values.subject_kind === "model") {
        values.mode = "original";
        values.use_custom_duration = false;
      } else if (values.subject_kind === "union") {
        values.mode = "union";
        values.tg_workflow_label = "联合替换工作流";
      } else {
        values.prompt_text = "替换视频中所有同类商品，保持人物、背景、光影和原视频节奏不变。";
      }
    } else if (module.id === "ecommerce_image") {
      values.mode = selectedFiles(module.id, "model").length ? "model_product" : "product_only";
      values.image_size = values.output_size || "2K";
      values.size = values.output_size || "2K";
      values.count = Number(values.nano_images || 4);
      values.prompt = [values.product_name, values.product_details, "生成电商广告图，保持商品形态与包装文字准确"].filter(Boolean).join("；");
      values.tg_use_llm_prompt = true;
    } else if (module.id === "subject_replace") {
      values.mode = "subject_replace";
    } else if (module.id === "poster_translate") {
      values.mode = "poster_translate";
      values.language = values.target_language;
    } else if (module.id === "subject_generate") {
      const product = values.subject_generate_mode === "product";
      values.mode = product ? "three_view" : "digital_human_character";
      if (!String(values.prompt || "").trim()) {
        values.prompt = product
          ? "综合多个角度还原产品形态，保持包装细节，生成白底三视图"
          : "请根据已选择的人设方向生成自然真实的数字人人设三视图";
      }
    }
    return values;
  }

  async function submitPreparedVideoTask(module, draft, submitValues, progress = null, options = {}) {
    const label = submitButtonLabel(module, draft.values);
    const currentProgress = progress || openVideoProgress(`正在${label}`, [
      "正在校验输入内容和素材…",
      "正在上传素材并创建任务…",
      "正在排入生成队列，请稍候…",
    ], { stage: "submit", moduleId: module.id, values: submitValues });
    currentProgress?.update?.({ steps: videoProgressSteps("submit", { moduleId: module.id, values: submitValues }) });
    const fileManifest = [];
    const body = new FormData();
    body.append("module", module.id);
    body.append("module_id", module.id);
    body.append("video_module", module.id);
    body.append("task_type", module.task_type || BACKEND_TASK_TYPES[module.id] || module.id);
    resolvedFields(module, draft.values).filter((field) => field.type === "file").forEach((field) => {
      selectedFiles(module.id, field.key).forEach((selectedFile) => {
        body.append(field.upload_name || "files", selectedFile);
        fileManifest.push({ field: field.key, name: selectedFile.name, size: selectedFile.size, type: selectedFile.type });
      });
    });
    body.append("params_json", JSON.stringify({ ...submitValues, _file_roles: fileManifest }));
    const result = await request("/api/video/tasks", { method: "POST", body });
    const createdTask = normalizeTask(result?.task || result, "video");
    if (createdTask.id || createdTask.moduleId) state.tasks.unshift(createdTask);
    releaseModuleFilePreviews(module.id);
    state.files[module.id] = {};
    void clearPersistedModuleFiles(module.id);
    saveDraft(module.id);
    await loadTasks({ quiet: true });
    const taskId = String(createdTask.id || result?.id || "").trim();
    if (!taskId) {
      if (options.requireTaskId) {
        const missingTaskId = new Error("服务器未返回视频任务编号，暂时无法自动追踪生成进度。");
        missingTaskId.code = "VIDEO_TASK_ID_MISSING";
        throw missingTaskId;
      }
      updateVideoSuccess(
        currentProgress,
        "生成任务已提交",
        `${label}已提交，系统正在后台处理。`,
        "任务编号暂未返回，请在任务动态中刷新查看。",
        [{
          value: "view-workbench",
          text: "查看任务动态",
          primary: true,
          onSelect: () => openVideoTaskWorkbench(module.id),
        }],
      );
      return "";
    }
    currentProgress?.update?.({ steps: videoProgressSteps("generate", { moduleId: module.id, values: submitValues }) });
    monitorSubmittedTask(taskId, currentProgress, module.id, label, { values: submitValues });
    return taskId;
  }

  async function submit(event) {
    event.preventDefault();
    if (state.submitting) return;
    const module = currentModule();
    const validationError = validate(module);
    if (validationError) {
      state.submitError = validationError;
      showVideoError(null, validationError, "无法开始生成");
      render();
      return;
    }
    state.submitting = true;
    state.submitError = "";
    render();
    let progress = null;
    try {
      const draft = loadDraft(module);
      ensureAdvancedValues(module, draft);
      if (module.id === "video_language_replace") {
        if (!draft.values.video_language_script_analyzed) {
          await parseCurrentScript();
          return;
        }
        const parsed = normalizeTimelineRows(draft.values.subtitle_segments).length
          ? normalizeTimelineRows(draft.values.subtitle_segments)
          : parseTimedScript(scriptSource(module, draft.values));
        if (parsed.length) {
          draft.values.subtitle_segments = parsed;
          draft.values.script_segments = parsed;
        }
        draft.values.video_language_script_confirmed = true;
      }
      const submitValues = publicSubmitValues(module, draft);
      if (module.id === "video_language_replace" && normalizeTimelineRows(draft.values.script_segments).length) {
        submitValues.source_segments = normalizeTimelineRows(draft.values.script_segments).map((row) => ({
          start_seconds: Number(row.start),
          end_seconds: Number(row.end),
          source_text: String(row.text || "").trim(),
        })).filter((row) => row.source_text && row.end_seconds > row.start_seconds);
      }
      if (requiresPromptPreviewForSubmit(module, submitValues)) {
        if (!draft.values._prompt_preview_ready || !draft.values._prompt_preview) {
          await generatePromptDraft({ autoSubmit: true });
          return;
        }
        applyStoredPromptPreviewForSubmit(module, submitValues, draft);
      } else if (requiresPromptPreview(module) && draft.values._prompt_preview_ready && draft.values._prompt_preview_confirmed) {
        applyStoredPromptPreviewForSubmit(module, submitValues, draft);
      } else if (requiresSimpleSubmitConfirmation(module) && !(await confirmVideoSubmit(module))) {
        return;
      }
      progress = openVideoProgress(`正在${submitButtonLabel(module, draft.values)}`, [
        "正在校验输入内容和素材…",
        "正在上传素材并创建任务…",
        "正在排入生成队列，请稍候…",
      ], { stage: "submit", moduleId: module.id, values: submitValues });
      await submitPreparedVideoTask(module, draft, submitValues, progress);
    } catch (error) {
      state.submitError = showVideoError(error, "任务提交失败：请检查输入、素材和算力余额后重试。", "生成任务提交失败", progress);
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
      state.runtimeDefaults = payload && typeof payload.runtime_defaults === "object" && payload.runtime_defaults
        ? payload.runtime_defaults
        : {};
      if (Array.isArray(payload?.speech_models) && payload.speech_models.length) {
        state.runtimeDefaults.speech_models = payload.speech_models;
      }
      state.modules = normalizeModules(payload);
      Object.keys(state.drafts || {}).forEach((moduleId) => {
        const draft = state.drafts[moduleId];
        if (draft?.values && Object.prototype.hasOwnProperty.call(draft.values, "minimax_tts_model")) {
          draft.values.minimax_tts_model = clampSpeechModel(draft.values.minimax_tts_model);
        }
      });
    } catch (error) {
      state.moduleError = videoErrorMessage(error, "无法读取模块配置：请刷新页面后重试。");
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
    if (!quiet) render();
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
      const key = task.id || `${task.source}:${task.createdAt}:${task.moduleId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
    await hydrateTaskMedia(state.tasks);
    if (failures.length === results.length) {
      state.taskError = videoErrorMessage(failures[0]?.reason, "无法读取任务列表：请检查网络后重试。");
    } else if (failures.length) {
      state.taskWarning = "部分任务来源暂时不可用，已显示可读取的任务。";
    }
    state.taskLoading = false;
    if (quiet) renderTaskPanelOnly();
    else render();
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

  async function confirmLeave() {
    if (!hasTransientState()) return true;
    const message = state.submitting
      ? "视频任务正在提交。现在离开可能中断上传，确定继续吗？"
      : "视频工作台中仍有已选文件。素材和文本草稿已保存在当前浏览器，确定离开吗？";
    if (window.VectoPublicPrompt?.confirm) {
      return window.VectoPublicPrompt.confirm({
        title: state.submitting ? "任务正在提交" : "当前页面还有未完成内容",
        message,
        confirmText: "继续离开",
        cancelText: "留在当前页",
      });
    }
    state.submitError = "页面提示组件加载失败：请刷新页面后再离开当前工作台。";
    render();
    return false;
  }

  function selectModule(moduleId) {
    if (!MODULE_ORDER.includes(moduleId) || moduleId === state.moduleId) return;
    state.voiceModalOpen = false;
    state.moduleId = moduleId;
    state.taskPage = 1;
    state.submitError = "";
    renderActiveModuleOnly();
    if (VOICE_MODULES.has(moduleId)) loadVoicePresets().catch(() => {});
  }

  function bind() {
    if (document.documentElement.dataset.videoWorkbenchBound === "1") return;
    document.documentElement.dataset.videoWorkbenchBound = "1";
    document.addEventListener("input", (event) => {
      const input = event.target.closest?.("#videoWorkbenchRoot [data-video-field]");
      if (input && input.type !== "file") handleFieldChange(input);
      const timelineInput = event.target.closest?.("#videoWorkbenchRoot [data-video-timeline-field]");
      if (timelineInput) updateTimelineField(timelineInput);
    });
    document.addEventListener("change", (event) => {
      const input = event.target.closest?.("#videoWorkbenchRoot [data-video-field]");
      if (input) handleFieldChange(input);
      const subtitleTemplate = event.target.closest?.("#videoWorkbenchRoot [data-video-subtitle-template]");
      if (subtitleTemplate) state.subtitleTemplate = normalizeSubtitleTemplate(subtitleTemplate.value) || "split_hook";
    });
    document.addEventListener("submit", (event) => {
      if (event.target.id === "videoWorkbenchForm") submit(event);
    });
    const clearDropState = (host, slot) => {
      host?.classList.remove("is-drop-target");
      slot?.classList.remove("is-drop-target");
    };
    document.addEventListener("dragenter", (event) => {
      const host = event.target.closest?.("#videoWorkbenchRoot [data-video-file-field]");
      if (!host) return;
      event.preventDefault();
      host.classList.add("is-drop-target");
      event.target.closest?.("[data-video-file-slot]")?.classList.add("is-drop-target");
    });
    document.addEventListener("dragover", (event) => {
      const host = event.target.closest?.("#videoWorkbenchRoot [data-video-file-field]");
      if (!host) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    document.addEventListener("dragleave", (event) => {
      const host = event.target.closest?.("#videoWorkbenchRoot [data-video-file-field]");
      const slot = event.target.closest?.("#videoWorkbenchRoot [data-video-file-slot]");
      if (slot && !slot.contains(event.relatedTarget)) slot.classList.remove("is-drop-target");
      if (host && !host.contains(event.relatedTarget)) clearDropState(host, slot);
    });
    document.addEventListener("drop", (event) => {
      const host = event.target.closest?.("#videoWorkbenchRoot [data-video-file-field]");
      if (!host) return;
      event.preventDefault();
      const slot = event.target.closest?.("[data-video-file-slot]");
      clearDropState(host, slot);
      const module = currentModule();
      const draft = loadDraft(module);
      const field = resolvedFields(module, draft.values).find((item) => item.type === "file" && item.key === host.dataset.videoFileField);
      const slotIndex = Number.parseInt(slot?.dataset.videoFileSlot || "", 10);
      if (assignFilesToField(field, event.dataTransfer?.files, Number.isInteger(slotIndex) ? slotIndex : null)) render();
    });
    document.addEventListener("click", (event) => {
      if (event.target.closest?.("[data-video-image-close]")) {
        event.preventDefault();
        state.imagePreview = null;
        render();
        return;
      }
      if (event.target.closest?.("[data-video-image-history-close]")) {
        event.preventDefault();
        state.imageHistoryOpen = false;
        render();
        return;
      }
      if (event.target.closest?.("[data-video-asset-picker-close]")) {
        event.preventDefault();
        state.assetPickerField = "";
        render();
        return;
      }
      const assetPicker = event.target.closest?.("[data-video-asset-picker]");
      if (assetPicker) {
        event.preventDefault();
        state.assetPickerField = assetPicker.dataset.videoAssetPicker || "";
        render();
        return;
      }
      const assetUse = event.target.closest?.("[data-video-asset-use]");
      if (assetUse) {
        event.preventDefault();
        void useHistoryAsset(assetUse.dataset.videoAssetUse, assetUse.dataset.videoAssetLabel).catch((error) => {
          state.submitError = showVideoError(error, "历史素材载入失败：请稍后重试。", "历史素材载入失败");
          render();
        });
        return;
      }
      if (event.target.closest?.("[data-video-image-history-open]")) {
        event.preventDefault();
        state.imageHistoryOpen = true;
        render();
        return;
      }
      const imagePreview = event.target.closest?.("[data-video-image-preview]");
      if (imagePreview) {
        event.preventDefault();
        state.imagePreview = { url: imagePreview.dataset.videoImagePreview, label: imagePreview.dataset.videoImageLabel || "图片结果" };
        render();
        return;
      }
      if (event.target.closest?.("[data-video-subtitle-close]")) {
        event.preventDefault();
        closeSubtitleTemplateModal();
        return;
      }
      const subtitleTask = event.target.closest?.("[data-video-task-subtitle]");
      if (subtitleTask) {
        event.preventDefault();
        openSubtitleTemplateModal(subtitleTask.dataset.videoTaskSubtitle);
        return;
      }
      if (event.target.closest?.("[data-video-subtitle-confirm]")) {
        event.preventDefault();
        void addSubtitlesToTask(state.subtitleModalTaskId, state.subtitleTemplate);
        return;
      }
      if (event.target.closest?.("[data-video-voice-close]")) {
        event.preventDefault();
        closeVoiceStudio();
        return;
      }
      if (event.target.closest?.("#videoWorkbenchRoot [data-video-open-voice]")) {
        event.preventDefault();
        openVoiceStudio();
        return;
      }
      const fileSlot = event.target.closest?.("#videoWorkbenchRoot [data-video-file-slot]");
      if (fileSlot) {
        event.preventDefault();
        const host = fileSlot.closest("[data-video-file-field]");
        openFilePicker(host?.dataset.videoFileField || "", Number.parseInt(fileSlot.dataset.videoFileSlot || "", 10));
        return;
      }
      const filePicker = event.target.closest?.("#videoWorkbenchRoot [data-video-file-pick]");
      if (filePicker) {
        event.preventDefault();
        openFilePicker(filePicker.dataset.videoFilePick || "");
        return;
      }
      const choiceButton = event.target.closest?.("#videoWorkbenchRoot [data-video-choice-field]");
      if (choiceButton) {
        const select = document.getElementById(`videoField-${choiceButton.dataset.videoChoiceField}`);
        if (select && select.value !== choiceButton.dataset.videoChoiceValue) {
          select.value = choiceButton.dataset.videoChoiceValue;
          handleFieldChange(select);
        }
      }
      if (event.target.closest?.("[data-video-clear-draft]")) clearDraft(state.moduleId);
      if (event.target.closest?.("[data-video-clear-files]")) clearSelectedFiles(state.moduleId);
      if (event.target.closest?.("[data-video-generate-prompt]")) void generatePromptDraft();
      if (event.target.closest?.("[data-video-refresh]")) loadTasks().catch(() => {});
      if (event.target.closest?.("[data-video-retry-modules]")) loadModules().catch(() => {});
      const voiceSelect = event.target.closest?.("[data-video-voice-select]");
      if (voiceSelect) selectVoice(voiceSelect.dataset.videoVoiceSelect);
      const voicePreview = event.target.closest?.("[data-video-voice-preview]");
      if (voicePreview) {
        event.preventDefault();
        previewVoice(voicePreview.dataset.videoVoicePreview);
        return;
      }
      if (event.target.closest?.("[data-video-parse-script]")) void parseCurrentScript();
      if (event.target.closest?.("[data-video-add-timeline]")) addTimelineRow();
      const removeSegment = event.target.closest?.("[data-video-remove-segment]");
      if (removeSegment) removeAdvancedSegment(removeSegment.dataset.videoRemoveSegment, removeSegment.dataset.videoSegmentId);
      const fusionView = event.target.closest?.("[data-video-task-fusion-view]");
      if (fusionView) {
        fusionView.disabled = true;
        regenerateTaskFusionView(fusionView.dataset.videoTaskId, fusionView.dataset.videoFusionViewIndex).catch((error) => {
          state.taskError = showVideoError(error, "数字人视角重生成失败：请检查素材和余额后重试。", "视角重生成失败");
          renderTaskPanelOnly();
        });
        return;
      }
      const fusionHistory = event.target.closest?.("[data-video-fusion-history]");
      if (fusionHistory) {
        void loadFusionHistory(fusionHistory.dataset.videoTaskId, fusionHistory.dataset.videoAssetIndex).catch((error) => {
          state.taskError = showVideoError(error, "数字人素材历史加载失败：请稍后重试。", "历史素材加载失败");
          renderTaskPanelOnly();
        });
        return;
      }
      const fusionHistoryUse = event.target.closest?.("[data-video-fusion-history-use]");
      if (fusionHistoryUse) {
        void useFusionHistory(fusionHistoryUse.dataset.videoTaskId, fusionHistoryUse.dataset.videoAssetIndex, fusionHistoryUse.dataset.videoHistoryPath).catch((error) => {
          state.taskError = showVideoError(error, "数字人历史素材切换失败：请稍后重试。", "历史素材切换失败");
          renderTaskPanelOnly();
        });
        return;
      }
      const fusionStep = event.target.closest?.("[data-video-task-fusion-step]");
      if (fusionStep) {
        void runTaskFusionStep(fusionStep.dataset.videoTaskId, fusionStep.dataset.videoTaskFusionStep);
        return;
      }
      const finalizeTask = event.target.closest?.("[data-video-task-finalize]");
      if (finalizeTask) {
        finalizeTask.disabled = true;
        void finalizeVisualTask(finalizeTask.dataset.videoTaskId, finalizeTask.dataset.videoTaskFinalize);
        return;
      }
      const taskSegment = event.target.closest?.("[data-video-task-segment-regenerate]");
      if (taskSegment) {
        taskSegment.disabled = true;
        regenerateTaskSegment(taskSegment.dataset.videoTaskId, taskSegment.dataset.videoSegmentId).catch((error) => {
          state.taskError = showVideoError(error, "片段重生成失败：请检查素材和余额后重试。", "片段重生成失败");
          render();
        });
      }
      const seedingRegenerate = event.target.closest?.("[data-video-seeding-regenerate]");
      if (seedingRegenerate) {
        void regenerateSeedingScene(seedingRegenerate.dataset.videoTaskId, seedingRegenerate.dataset.videoSceneIndex);
        return;
      }
      const seedingUpload = event.target.closest?.("[data-video-seeding-upload]");
      if (seedingUpload) {
        uploadSeedingScene(seedingUpload.dataset.videoTaskId, seedingUpload.dataset.videoSceneIndex);
        return;
      }
      const seedingHistory = event.target.closest?.("[data-video-seeding-history]");
      if (seedingHistory) {
        void loadSeedingHistory(seedingHistory.dataset.videoTaskId, seedingHistory.dataset.videoSceneIndex);
        return;
      }
      const seedingUse = event.target.closest?.("[data-video-seeding-use]");
      if (seedingUse) {
        void useSeedingHistory(seedingUse.dataset.videoTaskId, seedingUse.dataset.videoSceneIndex, seedingUse.dataset.videoSeedingPath);
        return;
      }
      const taskButton = event.target.closest?.("[data-video-task-action]");
      if (taskButton) {
        taskButton.disabled = true;
        taskAction(taskButton.dataset.videoTaskId, taskButton.dataset.videoTaskAction).catch((error) => {
          state.taskError = showVideoError(error, "任务操作失败：请稍后重试。", "任务操作失败");
          render();
        });
      }
      const taskPage = event.target.closest?.("[data-video-task-page]");
      if (taskPage) {
        state.taskPage = Math.max(Number(taskPage.dataset.videoTaskPage) || 1, 1);
        renderTaskPanelOnly();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.imagePreview) {
        state.imagePreview = null;
        render();
      } else if (event.key === "Escape" && state.subtitleModalTaskId) closeSubtitleTemplateModal();
      else if (event.key === "Escape" && state.voiceModalOpen) closeVoiceStudio();
    });
    document.addEventListener("visibilitychange", syncPolling);
    window.addEventListener("pagehide", (event) => {
      if (!event.persisted) releaseAllFilePreviews();
    });
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
    await restorePersistedFiles();
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
    state.voiceModalOpen = false;
    if (!state.subtitleSubmitting) state.subtitleModalTaskId = "";
    state.requestToken += 1;
    syncPolling();
  }

  window.VideoWorkbench = { activate, deactivate, selectModule, refresh: loadTasks, confirmLeave, hasTransientState };
}());
