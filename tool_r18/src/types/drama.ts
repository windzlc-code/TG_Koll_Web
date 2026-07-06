// 社交平台自動發文工具型別定義

/** 人設分類 */
export type PersonaCategory =
  | "家庭與生活"
  | "財經與職場"
  | "健康與美容"
  | "興趣與創作"
  | "教育與成長"
  | "情感與關係";

export const GENRES = [
  // 家庭與生活
  { value: "育兒媽媽", label: "育兒媽媽", desc: "分享育兒經驗、親子日常與家庭生活", audience: "女性向", category: "家庭與生活", markets: ["cn"] },
  { value: "家庭主婦", label: "家庭主婦", desc: "家務技巧、居家整理與生活智慧", audience: "女性向", category: "家庭與生活", markets: ["cn"] },
  { value: "全職爸爸", label: "全職爸爸", desc: "男性視角的育兒日常與家庭故事", audience: "男性向", category: "家庭與生活", markets: ["cn"] },
  { value: "新婚夫妻", label: "新婚夫妻", desc: "婚後生活適應、兩人世界與甜蜜日常", audience: "全齡", category: "家庭與生活", markets: ["cn"] },
  { value: "單親媽媽", label: "單親媽媽", desc: "獨立帶娃、堅韌成長與生活重建", audience: "女性向", category: "家庭與生活", markets: ["cn"] },
  { value: "婆媳關係創作者", label: "婆媳關係創作者", desc: "婆媳矛盾、家庭邊界與情感吐槽", audience: "女性向", category: "家庭與生活", markets: ["cn"] },
  { value: "養寵創作者", label: "養寵創作者", desc: "寵物日常、養護知識與萌寵故事", audience: "全齡", category: "家庭與生活", markets: ["cn"] },
  { value: "鄉村生活創作者", label: "鄉村生活創作者", desc: "田園生活、農耕日常與鄉土情懷", audience: "全齡", category: "家庭與生活", markets: ["cn"] },

  // 財經與職場
  { value: "理財專家", label: "理財專家", desc: "投資理財、資產配置與財富增長", audience: "男女皆可", category: "財經與職場", markets: ["cn"] },
  { value: "副業達人", label: "副業達人", desc: "兼職賺錢、被動收入與時間管理", audience: "男女皆可", category: "財經與職場", markets: ["cn"] },
  { value: "職場精英", label: "職場精英", desc: "職場晉升、人際關係與高效工作", audience: "男女皆可", category: "財經與職場", markets: ["cn"] },
  { value: "創業者", label: "創業者", desc: "創業歷程、商業思維與成功經驗", audience: "男性向", category: "財經與職場", markets: ["cn"] },
  { value: "電商賣家", label: "電商賣家", desc: "網路商店營運、選品技巧與銷售經驗", audience: "男女皆可", category: "財經與職場", markets: ["cn"] },
  { value: "自由職業者", label: "自由職業者", desc: "遠端工作、時間自由與生活方式", audience: "男女皆可", category: "財經與職場", markets: ["cn"] },
  { value: "省錢達人", label: "省錢達人", desc: "精打細算、薅羊毛技巧與消費觀念", audience: "女性向", category: "財經與職場", markets: ["cn"] },

  // 健康與美容
  { value: "健身創作者", label: "健身創作者", desc: "運動訓練、體型管理與健康生活", audience: "男女皆可", category: "健康與美容", markets: ["cn"] },
  { value: "美妝創作者", label: "美妝創作者", desc: "化妝技巧、產品評測與美容心得", audience: "女性向", category: "健康與美容", markets: ["cn"] },
  { value: "肌膚保養專家", label: "肌膚保養專家", desc: "肌膚護理、成分解析與抗老秘訣", audience: "女性向", category: "健康與美容", markets: ["cn"] },
  { value: "減肥創作者", label: "減肥創作者", desc: "減重歷程、飲食控制與身材管理", audience: "女性向", category: "健康與美容", markets: ["cn"] },
  { value: "中醫養生創作者", label: "中醫養生創作者", desc: "傳統養生、食療調理與健康知識", audience: "全齡", category: "健康與美容", markets: ["cn"] },
  { value: "營養師", label: "營養師", desc: "飲食搭配、營養知識與健康食譜", audience: "全齡", category: "健康與美容", markets: ["cn"] },
  { value: "穿搭創作者", label: "穿搭創作者", desc: "時尚搭配、風格塑造與購物分享", audience: "女性向", category: "健康與美容", markets: ["cn"] },

  // 興趣與創作
  { value: "美食創作者", label: "美食創作者", desc: "烹飪教程、美食探店與飲食文化", audience: "全齡", category: "興趣與創作", markets: ["cn"] },
  { value: "旅行創作者", label: "旅行創作者", desc: "旅行攻略、目的地推薦與出行體驗", audience: "全齡", category: "興趣與創作", markets: ["cn"] },
  { value: "美術創作者", label: "美術創作者", desc: "繪畫創作、藝術分享與審美提升", audience: "全齡", category: "興趣與創作", markets: ["cn"] },
  { value: "攝影創作者", label: "攝影創作者", desc: "拍攝技巧、後期處理與視覺美學", audience: "全齡", category: "興趣與創作", markets: ["cn"] },
  { value: "讀書創作者", label: "讀書創作者", desc: "書單推薦、讀書筆記與知識分享", audience: "全齡", category: "興趣與創作", markets: ["cn"] },
  { value: "手工創作者", label: "手工創作者", desc: "DIY教程、手工製作與創意生活", audience: "女性向", category: "興趣與創作", markets: ["cn"] },
  { value: "遊戲創作者", label: "遊戲創作者", desc: "遊戲攻略、評測分享與電競文化", audience: "男性向", category: "興趣與創作", markets: ["cn"] },
  { value: "音樂創作者", label: "音樂創作者", desc: "音樂分享、樂器教學與創作心得", audience: "全齡", category: "興趣與創作", markets: ["cn"] },

  // 教育與成長
  { value: "育兒專家", label: "育兒專家", desc: "科學育兒、兒童發展與教育方法", audience: "全齡", category: "教育與成長", markets: ["cn"] },
  { value: "學習創作者", label: "學習創作者", desc: "學習方法、考試技巧與自我提升", audience: "全齡", category: "教育與成長", markets: ["cn"] },
  { value: "英語老師", label: "英語老師", desc: "英語學習、口語提升與語言技巧", audience: "全齡", category: "教育與成長", markets: ["cn"] },
  { value: "心理諮詢師", label: "心理諮詢師", desc: "心理健康、情緒管理與自我成長", audience: "全齡", category: "教育與成長", markets: ["cn"] },
  { value: "職業規劃師", label: "職業規劃師", desc: "職業發展、求職技巧與人生規劃", audience: "全齡", category: "教育與成長", markets: ["cn"] },
  { value: "正能量創作者", label: "正能量創作者", desc: "勵志故事、人生感悟與積極心態", audience: "全齡", category: "教育與成長", markets: ["cn"] },

  // 情感與關係
  { value: "情感創作者", label: "情感創作者", desc: "戀愛技巧、兩性關係與情感分析", audience: "女性向", category: "情感與關係", markets: ["cn"] },
  { value: "毒舌媳婦", label: "毒舌媳婦", desc: "婆家吐槽、婚姻現實與犀利反擊", audience: "女性向", category: "情感與關係", markets: ["cn"] },
  { value: "傳統阿姨", label: "傳統阿姨", desc: "傳統觀念、社會評論與中年女性視角", audience: "全齡", category: "情感與關係", markets: ["cn"] },
  { value: "單身貴族", label: "單身貴族", desc: "單身生活、自我享受與婚戀觀念", audience: "全齡", category: "情感與關係", markets: ["cn"] },
  { value: "離婚創作者", label: "離婚創作者", desc: "婚姻反思、重新出發與獨立成長", audience: "女性向", category: "情感與關係", markets: ["cn"] },
  { value: "相親達人", label: "相親達人", desc: "相親經歷、擇偶標準與婚戀市場", audience: "全齡", category: "情感與關係", markets: ["cn"] },
] as const;

export const PERSONA_PERSONALITIES = [
  { value: "活潑開朗", label: "活潑開朗" },
  { value: "溫柔體貼", label: "溫柔體貼" },
  { value: "犀利毒舌", label: "犀利毒舌" },
  { value: "知性優雅", label: "知性優雅" },
  { value: "貼近生活", label: "貼近生活" },
  { value: "勵志正能量", label: "勵志正能量" },
  { value: "幽默搞笑", label: "幽默搞笑" },
  { value: "神秘高冷", label: "神秘高冷" },
] as const;

export const PERSONA_GENDERS = [
  { value: "女性", label: "女性" },
  { value: "男性", label: "男性" },
  { value: "不限", label: "不限" },
] as const;

export const PERSONA_NATIONALITIES = [
  { value: "none", label: "不限" },
  { value: "台灣", label: "台灣" },
  { value: "香港", label: "香港" },
  { value: "澳門", label: "澳門" },
  { value: "中國大陸", label: "中國大陸" },
  { value: "馬來西亞", label: "馬來西亞" },
  { value: "新加坡", label: "新加坡" },
  { value: "日本", label: "日本" },
  { value: "韓國", label: "韓國" },
  { value: "泰國", label: "泰國" },
  { value: "印度", label: "印度" },
  { value: "美國", label: "美國" },
  { value: "英國", label: "英國" },
  { value: "澳洲", label: "澳洲" },
  { value: "加拿大", label: "加拿大" },
  { value: "菲律賓", label: "菲律賓" },
  { value: "印尼", label: "印尼" },
  { value: "越南", label: "越南" },
] as const;

export const PERSONA_STYLES = [
  { value: "委婉含蓄", label: "委婉含蓄" },
  { value: "直接犀利", label: "直接犀利" },
  { value: "幽默調侃", label: "幽默調侃" },
  { value: "溫情敘事", label: "溫情敘事" },
  { value: "實用內容分享", label: "實用內容分享" },
  { value: "故事化表達", label: "故事化表達" },
] as const;

export const TARGET_MARKETS = [
  {
    value: "cn",
    label: "華語受眾",
    desc: "中文內容，面向台灣及海外華人社群",
  },
  {
    value: "jp",
    label: "日本受眾",
    desc: "日文內容，細膩情感表達，貼合日本使用者審美",
  },
  {
    value: "west",
    label: "歐美受眾",
    desc: "英文內容，直接有力的敘事風格，強共鳴與爽感",
  },
  {
    value: "kr",
    label: "韓國受眾",
    desc: "韓文內容，情感細膩，注重人物關係與生活質感",
  },
  {
    value: "sea",
    label: "東南亞受眾",
    desc: "英文內容，家庭與階層話題，情感濃烈貼近生活",
  },
] as const;

export const EPISODE_COUNTS = [
  { value: 0, label: "自動" },
  { value: 50, label: "50~150字（超短）" },
  { value: 150, label: "150~300字（極短）" },
  { value: 300, label: "300~500字（短篇）" },
  { value: 500, label: "500~800字（中短篇）" },
  { value: -1, label: "自訂" },
] as const;

export type DramaMode = "traditional" | "adaptation";

export type DramaStep =
  | "setup" | "creative-plan" | "characters"
  | "reference-script" | "structure-transform" | "character-transform"
  | "directory" | "outlines" | "episodes" | "compliance" | "export";

export const DRAMA_STEP_LABELS: Record<DramaStep, string> = {
  setup: "人設建立",
  "creative-plan": "內容方案",
  characters: "人設開發",
  "reference-script": "參考文案",
  "structure-transform": "結構轉換",
  "character-transform": "角色轉換",
  directory: "內容目錄",
  outlines: "內容細綱",
  episodes: "文案生產",
  compliance: "內容審核",
  export: "發布佇列",
};

export const DRAMA_STEPS: DramaStep[] = [
  "episodes",
  "export",
];

export const FRAMEWORK_STYLES = [
  { value: "東方玄幻", label: "東方玄幻", desc: "仙俠修真、靈氣法術、飛昇渡劫", category: "古代風格", markets: ["cn"] },
  { value: "古裝宮廷", label: "古裝宮廷", desc: "深宮權謀、后妃爭鬥、皇權博弈", category: "古代風格", markets: ["cn"] },
  { value: "武俠江湖", label: "武俠江湖", desc: "江湖恩怨、武林爭霸、俠骨柔情", category: "古代風格", markets: ["cn"] },
  { value: "古風言情", label: "古風言情", desc: "古代背景、浪漫愛情、情深緣淺", category: "古代風格", markets: ["cn"] },
  { value: "歷史演義", label: "歷史演義", desc: "王朝更迭、英雄輩出、歷史風雲", category: "古代風格", markets: ["cn"] },
  { value: "西方奇幻", label: "西方奇幻", desc: "魔法世界、騎士冒險、龍與精靈", category: "幻想風格", markets: ["west", "cn"] },
  { value: "科幻未來", label: "科幻未來", desc: "星際探索、AI時代、賽博朋克", category: "幻想風格", markets: ["west", "cn", "jp"] },
  { value: "末日廢土", label: "末日廢土", desc: "末世求生、廢土冒險、人性考驗", category: "幻想風格", markets: ["west", "cn"] },
  { value: "靈異恐怖", label: "靈異恐怖", desc: "鬼怪傳說、驚悚懸疑、心理恐怖", category: "幻想風格", markets: ["cn", "jp", "west"] },
  { value: "穿越時空", label: "穿越時空", desc: "時空穿梭、古今交錯、命運改變", category: "幻想風格", markets: ["cn", "jp", "west", "kr"] },
  { value: "現代都市", label: "現代都市", desc: "都市職場、商戰情感、現代生活", category: "現代風格", markets: ["cn", "kr", "sea"] },
  { value: "校園青春", label: "校園青春", desc: "校園戀愛、青春成長、友情熱血", category: "現代風格", markets: ["cn", "jp", "kr", "west"] },
  { value: "都市情感", label: "都市情感", desc: "婚戀家庭、情感糾葛、現實題材", category: "現代風格", markets: ["cn", "kr", "sea"] },
  { value: "職場商戰", label: "職場商戰", desc: "職場風雲、商場博弈、逆襲成長", category: "現代風格", markets: ["cn", "kr", "west"] },
  { value: "懸疑推理", label: "懸疑推理", desc: "燒腦破案、邏輯推理、真相大白", category: "現代風格", markets: ["cn", "jp", "west", "kr"] },
  { value: "民國諜戰", label: "民國諜戰", desc: "亂世風雲、諜影重重、家國情懷", category: "特殊風格", markets: ["cn"] },
  { value: "軍旅戰爭", label: "軍旅戰爭", desc: "鐵血軍魂、戰場烽火、熱血報國", category: "特殊風格", markets: ["cn", "west"] },
  { value: "遊戲競技", label: "遊戲競技", desc: "電競網遊、虛擬世界、巔峰對決", category: "特殊風格", markets: ["cn", "jp", "west"] },
  { value: "體育競技", label: "體育競技", desc: "運動賽場、揮灑汗水、超越自我", category: "特殊風格", markets: ["cn", "jp", "west", "kr"] },
  { value: "鄉村鄉土", label: "鄉村鄉土", desc: "田園生活、鄉土風情、鄰里故事", category: "特殊風格", markets: ["cn", "jp", "sea"] },
  // 日本市場專屬風格
  { value: "物哀治癒", label: "物哀治癒", desc: "細膩日常中的情緒修復與溫柔成長", category: "日式風格", markets: ["jp"] },
  { value: "職人匠心", label: "職人匠心", desc: "圍繞職業精神與細節打磨的成長線", category: "日式風格", markets: ["jp"] },
  { value: "異世界冒險", label: "異世界冒險", desc: "穿越異世界後的任務成長與夥伴協作", category: "日式風格", markets: ["jp", "west", "cn"] },
  { value: "妖怪奇談", label: "妖怪奇談", desc: "民俗怪談與溫情治癒結合的奇談線", category: "日式風格", markets: ["jp"] },
  { value: "王道熱血", label: "王道熱血", desc: "友情羈絆、成長試煉與正義宣言", category: "日式風格", markets: ["jp", "cn", "west"] },
  // 歐美市場專屬風格
  { value: "超級英雄", label: "超級英雄", desc: "能力覺醒、責任命題與團隊對抗", category: "歐美風格", markets: ["west"] },
  { value: "太空歌劇", label: "太空歌劇", desc: "星際文明衝突與史詩級陣營對抗", category: "歐美風格", markets: ["west"] },
  { value: "奇幻史詩", label: "奇幻史詩", desc: "宏大世界觀下的王權與命運戰爭", category: "歐美風格", markets: ["west"] },
  { value: "犯罪驚悚", label: "犯罪驚悚", desc: "高壓節奏、連環危機與反轉追兇", category: "歐美風格", markets: ["west"] },
  { value: "黑色幽默", label: "黑色幽默", desc: "荒誕處境中的諷刺喜劇表達", category: "歐美風格", markets: ["west"] },
  { value: "浪漫喜劇", label: "浪漫喜劇", desc: "誤會迭起、歡喜冤家式的高糖節奏", category: "歐美風格", markets: ["west", "kr"] },
  { value: "蒸汽朋克", label: "蒸汽朋克", desc: "維多利亞美學、機械奇觀與階級反抗", category: "歐美風格", markets: ["west", "cn"] },
  // 韓國市場專屬風格
  { value: "韓式復仇", label: "韓式復仇", desc: "身份落差、精密復仇與情感反噬", category: "韓式風格", markets: ["kr"] },
  { value: "財閥博弈", label: "財閥博弈", desc: "財閥家族權力鬥爭與階層對抗", category: "韓式風格", markets: ["kr", "cn"] },
  { value: "命運愛情", label: "命運愛情", desc: "命運錯位與高強度情感拉扯", category: "韓式風格", markets: ["kr"] },
  { value: "懸愛反轉", label: "懸愛反轉", desc: "戀愛線與懸疑線交織的連續反轉結構", category: "韓式風格", markets: ["kr"] },
  // 東南亞市場專屬風格
  { value: "家族恩怨", label: "家族恩怨", desc: "家族關係、代際衝突與利益對抗", category: "東南亞風格", markets: ["sea", "cn"] },
  { value: "鄉土逆襲", label: "鄉土逆襲", desc: "基層環境中個人崛起與身份躍遷", category: "東南亞風格", markets: ["sea", "cn"] },
  { value: "宗教民俗", label: "宗教民俗", desc: "地方信仰與民俗禁忌驅動的衝突故事", category: "東南亞風格", markets: ["sea"] },
] as const;

export interface DramaSetup {
  genres: string[]; // max 2
  personaPersonality: string; // 人設性格
  personaGender: string;      // 人設性別
  personaNationality?: string; // 人設國籍
  personaStyle: string;       // 表述習慣
  totalEpisodes: number;
  targetMarket: string; // "cn" | "jp" | "west" | "kr" | "sea"
  customTopic?: string;
  setupMode?: "topic";
  chineseScript?: "simplified" | "traditional"; // only for targetMarket === "cn"
  // legacy fields kept for backwards compat with stored projects
  audience?: string;
  tone?: string;
  ending?: string;
  // Social media persona fields
  personaName?: string;
  personaDescription?: string;
  personalityTags?: string;
  postFormat?: string;
  contentTheme?: string;
  interests?: string[];
  trendTopics?: string[];
  tweetStyleProfile?: string;
  tweetStyleSample?: string;
  tweetStyleLinkUrl?: string;
  tweetStyleLinkText?: string;
  linkEndingPresets?: Array<{
    id: string;
    name?: string;
    linkUrl?: string;
    endingText?: string;
    enabled?: boolean;
    createdAt?: string;
    updatedAt?: string;
  }>;
  activeLinkEndingPresetId?: string;
  freePostTemplate?: "jinjunya-hook" | "default";
  // Persona image consistency
  personaAvatarUrl?: string;   // base64 data URL of uploaded reference image
  personaAppearance?: string;  // AI-extracted appearance description for image generation/search
  // Meme persona (梗圖/段子型): image-first, short text hooks, meme images from pool
  isMemePersona?: boolean;
  memeImagePool?: string[];    // scraped image URLs from source account posts
  memeSourceUrl?: string;      // original scraped account URL for re-fetching
  // Girl/beauty persona (美女/福利型): image-first, same-person photos or AI-generated consistent images
  isGirlPersona?: boolean;
  girlImagePool?: string[];    // scraped photos of the same person from source account
}

export interface DramaCharacter {
  name: string;
  age: string;
  identity: string;
  personality: string[];
  motivation: string;
  arc: string;
  catchphrase: string;
  villainLevel?: number; // 1-4 for villain hierarchy
}

export interface EpisodeEntry {
  number: number;
  title: string;
  summary: string;
  hookType: string;
  isKey: boolean;      // 🔥
  isClimax: boolean;   // ⚡ 高潮卡點
  isPaywall: boolean;  // 💰 付費卡點
  emotionLevel?: number; // 1-5 情緒強度
  outline?: string;    // 單集細綱（約300字）
}

export interface EpisodeVersion {
  content: string;
  wordCount: number;
  timestamp: string;
  label?: string; // e.g. "場次二重寫" or "整集重寫"
}

export interface EpisodeImageHistoryEntry {
  imageUrl: string;
  createdAt: string;
  query?: string;
  source?: string;
}

export interface EpisodeScript {
  number: number;
  title: string;
  content: string;
  wordCount: number;
  memorySummary?: string;
  orderIndex?: number;
  archivePostId?: string;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string;
  imageUrl?: string;       // auto-collected cover image URL
  imageHistory?: EpisodeImageHistoryEntry[];
  history?: EpisodeVersion[];
}

export interface DramaProject {
  id: string;
  mode: DramaMode;
  setup: DramaSetup | null;
  creativePlan: string;
  characters: string;
  directory: EpisodeEntry[];
  directoryRaw: string;
  episodes: EpisodeScript[];
  complianceReport: string;
  currentStep: DramaStep;
  dramaTitle: string;
  createdAt: string;
  updatedAt: string;
  // Adaptation mode fields
  referenceScript?: string;
  referenceStructure?: string; // Extracted structure from reference script
  frameworkStyle?: string;
  structureTransform?: string;
  characterTransform?: string;
}

export function createEmptyDramaProject(mode: DramaMode = "traditional"): DramaProject {
  return {
    id: crypto.randomUUID(),
    mode,
    setup: null,
    creativePlan: "",
    characters: "",
    directory: [],
    directoryRaw: "",
    episodes: [],
    complianceReport: "",
    currentStep: mode === "traditional" ? "episodes" : "reference-script",
    dramaTitle: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    referenceScript: "",
    referenceStructure: "",
    frameworkStyle: "",
    structureTransform: "",
    characterTransform: "",
  };
}
