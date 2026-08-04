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
  const TIMELINE_MODULES = new Set(["video_language_replace"]);
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
  const MINIMAX_TTS_MODEL_OPTIONS = [
    { value: "speech-2.8-hd", label: "speech-2.8-hd（高清，推荐）" },
    { value: "speech-2.8-turbo", label: "speech-2.8-turbo（快速）" },
    { value: "speech-2.6-hd", label: "speech-2.6-hd" },
    { value: "speech-2.6-turbo", label: "speech-2.6-turbo" },
    { value: "speech-02-hd", label: "speech-02-hd" },
    { value: "speech-02-turbo", label: "speech-02-turbo" },
    { value: "speech-01-hd", label: "speech-01-hd" },
    { value: "speech-01-turbo", label: "speech-01-turbo" },
  ];
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
    default: [AUTOMATIC_OPTION, { value: "gentle", label: "亲和自然" }, { value: "business", label: "商务干练" }, { value: "elegant", label: "优雅知性" }, { value: "lively", label: "活力外向" }],
    female: [AUTOMATIC_OPTION, { value: "elegant", label: "优雅知性" }, { value: "gentle", label: "亲和自然" }, { value: "sweet", label: "清新亲切" }, { value: "cool", label: "高级冷感" }, { value: "business", label: "干练专业" }],
    female_young: [AUTOMATIC_OPTION, { value: "sweet", label: "清新甜美" }, { value: "lively", label: "活力外向" }, { value: "gentle", label: "亲和自然" }, { value: "cool", label: "高级冷感" }, { value: "elegant", label: "优雅知性" }],
    female_mature: [AUTOMATIC_OPTION, { value: "elegant", label: "优雅知性" }, { value: "business", label: "商务干练" }, { value: "gentle", label: "亲和自然" }, { value: "cool", label: "高级冷感" }, { value: "calm", label: "沉稳大气" }],
    male: [AUTOMATIC_OPTION, { value: "business", label: "干练专业" }, { value: "calm", label: "沉稳大气" }, { value: "sunny", label: "阳光亲和" }, { value: "elite", label: "精英专业" }, { value: "elegant", label: "儒雅稳重" }],
    male_young: [AUTOMATIC_OPTION, { value: "lively", label: "活力外向" }, { value: "business", label: "商务干练" }, { value: "sunny", label: "阳光亲和" }, { value: "cool", label: "高级冷感" }, { value: "street", label: "潮流自信" }],
    male_mature: [AUTOMATIC_OPTION, { value: "business", label: "商务干练" }, { value: "calm", label: "沉稳大气" }, { value: "gentle", label: "亲和自然" }, { value: "elite", label: "精英专业" }, { value: "elegant", label: "儒雅稳重" }],
  };
  const CHARACTER_CLOTHING = {
    default: [AUTOMATIC_OPTION, { value: "formal_suit", label: "正式西装套装" }, { value: "smart_casual_set", label: "通勤休闲套装" }, { value: "soft_knit_set", label: "针织舒适套装" }, { value: "casual_jacket_set", label: "休闲夹克套装" }, { value: "sporty", label: "运动套装" }],
    female: [AUTOMATIC_OPTION, { value: "tailored_suit_female", label: "女士西装套装" }, { value: "business_dress_female", label: "轻商务裙装套装" }, { value: "elegant_commute_female", label: "优雅通勤套装" }, { value: "soft_knit_set_female", label: "温柔针织套装" }, { value: "sporty_female", label: "运动休闲套装" }],
    female_young: [AUTOMATIC_OPTION, { value: "blazer_dress_female", label: "轻商务连衣裙套装" }, { value: "shirt_skirt_female", label: "学院感半裙套装" }, { value: "knit_jeans_female", label: "针织休闲套装" }, { value: "sweet_female", label: "清新甜美裙装套装" }, { value: "sporty_female", label: "运动休闲套装" }],
    female_mature: [AUTOMATIC_OPTION, { value: "tailored_suit_female", label: "修身西装套装" }, { value: "silk_blouse_trousers_female", label: "高级通勤套装" }, { value: "elegant_female", label: "优雅知性裙装套装" }, { value: "knit_cardigan_female", label: "温柔针织裙装套装" }, { value: "daily_female", label: "简洁日常套装" }],
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
          textarea("product_details", oral ? "文案需求" : "产品相关简介", { placeholder: oral ? "可选：说明口播主题、受众、核心观点、段落方向、语气风格；AI 会据此生成口播文案" : "可选：补充产品卖点、适用人群、使用场景、价格/参数等详情；只用于 AI 生成文案或提示词", wide: true }),
          ...(oral ? [number("oral_target_duration_seconds", "目标口播时长（秒）", { default: 30, min: 5, max: 180, step: 1 })] : []),
          select("target_language", "口播语言", LANGUAGE_OPTIONS, { default: "Chinese", placement: "voice" }),
          select("minimax_tts_model", "MiniMax 音频模型", MINIMAX_TTS_MODEL_OPTIONS, { default: "speech-2.8-hd" }),
          textarea("speech_text", "口播文案", { placeholder: oral ? "可手动输入成稿，也可留空让 AI 根据文案需求和场景图生成" : "可手动输入，也可留空让 AI 根据图片生成", wide: true }),
          select("ratio", "画面比例", VIDEO_RATIO_OPTIONS, { default: "9:16" }),
          select("image_resolution", "图片分辨率", IMAGE_RESOLUTION_OPTIONS, { default: "2K" }),
          ...(!oral ? [select("digital_human_short_mode", "分镜模式", [{ value: "storyboard", label: "多分镜" }, { value: "single", label: "单镜头" }], { default: "storyboard" })] : []),
        ];
      },
    },
    ecommerce_short_video: {
      id: "ecommerce_short_video",
      label: "广告 / 种草视频",
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
        select("minimax_tts_model", "MiniMax 音频模型", MINIMAX_TTS_MODEL_OPTIONS, { default: "speech-2.8-hd" }),
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
      description: "保留原视频动作和镜头，替换人物或商品主体。",
      fields: [
        select("replace_mode", "替换模式", [{ value: "model", label: "模特替换" }, { value: "product", label: "商品替换" }], { default: "model", placement: "uploadFooter" }),
        file("video", "原视频", "video/*", { required: true }),
        file("image", "目标人物/模特图", "image/*", { required: true, dynamicLabel: true }),
      ],
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
      field.default ?? (field.type === "checkbox" ? false : ""),
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

  function optionMarkup(field, value) {
    return field.options.map((option) => `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(value) ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
  }

  function isPillSelectField(field) {
    return field?.type === "select" && PILL_SELECT_KEYS.has(field.key) && field.options.length >= 2 && field.options.length <= 4;
  }

  function renderFileField(field) {
    const files = selectedFiles(state.moduleId, field.key);
    const fileRows = files.map((item) => `<li><span>${escapeHtml(item.name)}</span><small>${formatBytes(item.size)}</small></li>`).join("");
    const previewSlots = Math.max(0, Number(field.previewSlots) || 0);
    const previewLabels = Array.isArray(field.previewLabels) ? field.previewLabels : [];
    return `<label class="video-file-field ${files.length ? "has-files" : ""}" data-video-file-field="${escapeHtml(field.key)}">
      <input type="file" data-video-field="${escapeHtml(field.key)}" ${field.accept ? `accept="${escapeHtml(field.accept)}"` : ""} ${field.multiple ? "multiple" : ""} ${field.required ? "required" : ""} />
      <span class="video-file-field-icon">${moduleIcon(state.moduleId)}</span>
      <span class="video-file-field-copy">
        <strong>${escapeHtml(field.label)}${field.required ? '<em aria-hidden="true">*</em>' : ""}</strong>
        <span>${files.length ? `已选择 ${files.length} 个文件` : (field.help || "点击选择或将文件拖到这里")}</span>
      </span>
      <span class="video-file-field-action">${files.length ? "重新选择" : "选择文件"}</span>
      ${previewSlots ? `<span class="video-upload-slots" aria-hidden="true">${Array.from({ length: previewSlots }, (_, index) => `<i class="${files[index] ? "is-filled" : ""}">${escapeHtml(files[index]?.name || previewLabels[index] || `素材 ${index + 1}`)}</i>`).join("")}</span>` : ""}
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

  function renderVoiceStudio(module, draft, voiceFields = []) {
    if (!VOICE_MODULES.has(module.id)) return "";
    const language = String(state.voiceFilter || draft.values.target_language || draft.values.language || "").toLowerCase();
    const filtered = state.voicePresets.filter((voice) => !language || language === "auto" || voice.language.toLowerCase().includes(language));
    const voices = (filtered.length ? filtered : state.voicePresets).slice(0, 24);
    const selectedId = String(draft.values.voice_id || draft.values.speaker || "");
    const selected = state.voicePresets.find((voice) => voice.voiceId === selectedId || voice.id === selectedId);
    const languages = [...new Set(state.voicePresets.map((voice) => voice.language).filter(Boolean))].sort();
    return `<section class="video-advanced-card video-voice-studio" data-video-voice-studio>
      <div class="video-advanced-head">
        <div><span>VOICE CAST</span><strong>参考声音</strong><small>${escapeHtml(selected?.label || "可上传干音，或选择预设声音试听")}</small></div>
      </div>
      ${state.voiceError ? `<div class="video-advanced-notice">${escapeHtml(state.voiceError)}</div>` : ""}
      ${voiceFields.length ? `<div class="video-voice-inline-fields">${voiceFields.map((field) => renderInputField(field, draft.values[field.key])).join("")}</div>` : ""}
      <details class="video-voice-picker">
        <summary>${selected ? "更换 / 试听预设声音" : "选择 / 试听预设声音"}</summary>
        <div class="video-voice-picker-body">
          <div class="video-voice-toolbar">
            <label><span>筛选语言</span><select data-video-voice-filter><option value="">全部语言</option>${languages.map((item) => `<option value="${escapeHtml(item)}" ${item === state.voiceFilter ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select></label>
            <button type="button" class="video-mini-button" data-video-reload-voices ${state.voiceLoading ? "disabled" : ""}>${state.voiceLoading ? "加载中…" : "刷新音色"}</button>
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
        </div>
      </details>
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
    const voiceFields = fields.filter((field) => field.type !== "file" && field.placement === "voice");
    const inputFields = fields.filter((field) => field.type !== "file" && !field.placement && !(VOICE_MODULES.has(module.id) && ["speaker", "voice_id"].includes(field.key)));
    return `<form id="videoWorkbenchForm" class="video-workbench-form" data-video-module-form="${escapeHtml(module.id)}">
      <div class="video-original-layout">
        <section class="video-form-section video-upload-panel">
          <div class="video-original-panel-head"><div><strong>素材上传</strong><small>请按原工作台顺序上传素材。</small></div><button type="button" class="video-button video-button--ghost" data-video-clear-files>清空</button></div>
          ${uploadTopFields.length ? `<div class="video-upload-mode-fields">${uploadTopFields.map((field) => renderInputField(field, draft.values[field.key])).join("")}</div>` : ""}
          ${fileFields.length ? `<div class="video-file-grid">${fileFields.map(renderFileField).join("")}</div>` : `<div class="video-workbench-state video-workbench-state--empty"><span>当前模块无需上传素材。</span></div>`}
          ${renderVoiceStudio(module, draft, voiceFields)}
          ${uploadFooterFields.length ? `<div class="video-upload-mode-fields video-upload-mode-fields--footer">${uploadFooterFields.map((field) => renderInputField(field, draft.values[field.key])).join("")}</div>` : ""}
        </section>
        <section class="video-form-section video-settings-panel">
          <div class="video-original-panel-head"><div><strong>生成内容</strong><small>仅显示原数字人项目对用户开放的参数。</small></div></div>
          ${inputFields.length ? `<div class="video-form-grid">${inputFields.map((field) => renderInputField(field, draft.values[field.key])).join("")}</div>` : `<div class="video-workbench-state video-workbench-state--empty"><span>此模块没有额外生成参数。</span></div>`}
        </section>
      </div>
      ${renderAdvancedSections(module, draft)}
      <div class="video-form-footer">
        <div class="video-draft-status" data-video-draft-status>${draft.savedAt ? `草稿已保存 · ${escapeHtml(formatTime(draft.savedAt))}` : "输入内容将自动保存为草稿"}</div>
        <div class="video-form-actions">
          <button type="button" class="video-button video-button--ghost" data-video-clear-draft>清空草稿</button>
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
    loadDraft(module);
    root.innerHTML = `<div class="video-workbench-shell">
      ${renderWorkbenchHero(module)}
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
    const draft = loadDraft(module);
    const field = resolvedFields(module, draft.values).find((item) => item.key === input.dataset.videoField);
    if (!field) return;
    if (field.type === "file") {
      state.files[module.id] ||= {};
      const selected = Array.from(input.files || []);
      state.files[module.id][field.key] = field.maxFiles ? selected.slice(0, Number(field.maxFiles)) : selected;
      render();
      return;
    }
    draft.values[field.key] = readFieldValue(field, input);
    if (field.key === "character_gender") {
      draft.values.character_hairstyle = "";
      draft.values.character_temperament = "";
      draft.values.character_clothing = "";
    } else if (field.key === "character_age") {
      draft.values.character_temperament = "";
      draft.values.character_clothing = "";
    }
    saveDraft(module.id);
    if (isPillSelectField(field) || DYNAMIC_SELECT_KEYS.has(field.key)) render();
  }

  function clearSelectedFiles(moduleId) {
    state.files[moduleId] = {};
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
    setTimelineRows(module, draft, (draft.values.subtitle_segments || []).filter((item) => String(item.id) !== String(segmentId)));
    render();
  }

  function regenerateDraftSegment(kind, segmentId) {
    const { module, draft } = advancedDraft();
    const rows = normalizeTimelineRows(draft.values.subtitle_segments);
    const row = rows.find((item) => String(item.id) === String(segmentId));
    if (row) {
      row.regenerate = true;
      row.regenerate_revision = Number(row.regenerate_revision || 0) + 1;
      setTimelineRows(module, draft, rows);
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
    const fields = resolvedFields(module, draft.values);
    for (const field of fields) {
      if (!field.required) continue;
      if (field.type === "file" && !selectedFiles(module.id, field.key).length) {
        if (field.key === "audio" && draft.values.voice_id) continue;
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
    if (draft.values.voice_id) {
      values.voice_id = draft.values.voice_id;
      values.speaker = draft.values.voice_id;
      values.voice_label = draft.values.voice_label || "";
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
      });
    } else if (module.id === "ecommerce_short_video") {
      const seeding = values.ecommerce_video_mode === "seeding_video";
      values.language = values.target_language;
      values.content_mode = seeding ? "planting" : "advertising";
      values.tg_use_llm_prompt = seeding || !String(values.prompt_text || "").trim();
      if (seeding) {
        values.add_subtitles = true;
        values.subtitle_enabled = true;
      } else {
        values.prompt = values.prompt_text || "";
        values.ecommerce_model = values.ecommerce_short_video_model;
        values.seedance_model = values.ecommerce_short_video_model;
      }
    } else if (module.id === "video_language_replace") {
      values.language = values.target_language;
      values.video_tts_model = values.minimax_tts_model;
    } else if (module.id === "video_subject_replace") {
      values.subject_kind = values.replace_mode === "product" ? "product" : "model";
      if (values.subject_kind === "model") {
        values.mode = "original";
        values.use_custom_duration = false;
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
          : [values.digital_human_character_region, values.character_gender, values.character_age, values.character_hairstyle, values.character_temperament, values.character_clothing].filter(Boolean).join("，") || "生成自然真实的数字人人设三视图";
      }
    }
    return values;
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
        }
      }
      const submitValues = publicSubmitValues(module, draft);
      if (module.id === "video_language_replace" && normalizeTimelineRows(draft.values.script_segments).length) {
        submitValues.source_segments = normalizeTimelineRows(draft.values.script_segments).map((row) => ({
          start_seconds: Number(row.start),
          end_seconds: Number(row.end),
          source_text: String(row.text || "").trim(),
        })).filter((row) => row.source_text && row.end_seconds > row.start_seconds);
      }
      if (!(await confirmPromptPreview(module, submitValues))) return;
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
      if (event.target.closest?.("[data-video-clear-draft]")) clearDraft(state.moduleId);
      if (event.target.closest?.("[data-video-clear-files]")) clearSelectedFiles(state.moduleId);
      if (event.target.closest?.("[data-video-refresh]")) loadTasks().catch(() => {});
      if (event.target.closest?.("[data-video-retry-modules]")) loadModules().catch(() => {});
      if (event.target.closest?.("[data-video-reload-voices]")) loadVoicePresets({ force: true }).catch(() => {});
      const voiceSelect = event.target.closest?.("[data-video-voice-select]");
      if (voiceSelect) selectVoice(voiceSelect.dataset.videoVoiceSelect);
      const voicePreview = event.target.closest?.("[data-video-voice-preview]");
      if (voicePreview) previewVoice(voicePreview.dataset.videoVoicePreview);
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

  window.VideoWorkbench = { activate, deactivate, selectModule, refresh: loadTasks, confirmLeave, hasTransientState };
}());
