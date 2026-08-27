import { useEffect, useMemo, useRef, useState } from "react";
import { crmApi, payloadItems } from "./api";
import { localizedError, type Messages } from "./i18n";
import { Icon } from "./icons";
import { PlatformLogo } from "./platform";
import { ConsoleModal } from "./confirm-dialog";
import { SelectMenu } from "./select-menu";
import type { CrmAccount, Language, ViewId } from "./types";

type Row = Record<string, unknown>;
export type WizardView = Extract<ViewId, "collect" | "public" | "outreach" | "groups" | "relationships">;
export type WorkflowSeed = {
  poolId?: string;
  leadIds?: string[];
  leads?: Row[];
  batchSize?: 5 | 10 | 20;
  collectMode?: "persona" | "hotspot" | "link";
  collectInput?: string;
  execution?: ExecutionMode;
};
type ExecutionMode = "sample" | "batch" | "schedule";
type PublicActionType = "public_comment" | "public_reply" | "followup_reply" | "nurture_reply";
type ReplyStrategy = "question_hook" | "offer_hook" | "group_invite";
type PreflightResult = Awaited<ReturnType<typeof crmApi.preflight>>;

const copy = {
  "zh-Hans": {
    title: "建立 CRM 任务", collectTitle: "采集用户", close: "关闭", back: "上一步", next: "下一步", cancel: "取消", prepare: "分析并继续",
    submit: "确认并开始", collectStart: "开始采集", submitting: "正在建立任务…", loading: "正在读取客户池、模板和账号…", required: "请完成当前步骤的必填内容。",
    step: (current: number, total: number) => `步骤 ${current}／${total}`,
    collectSteps: ["填写设置", "确认启动"],
    collectHint2: "，AI 会先解析并让你确认，再启动采集。",
    collectHint3Persona: "需求已拆解成画像与多组关键词，将并发执行并自动去重。",
    collectHint3Hotspot: "已找出高互动贴文，请勾选要深入采集的来源。",
    collectHint3Link: "请核对链接与采集范围，再开始采集。",
    preparePersona: "分析画像并继续", prepareHotspot: "搜索热门贴文并继续", prepareLink: "验证链接并继续",
    preparingPersona: "AI 正在拆解需求…", preparingHotspot: "搜寻真实热点中…", preparingLink: "正在验证链接…",
    demand: "描述你的目标用户", demandPlaceholder: "例如：台湾 25–40 岁、经营电商品牌、关注 AI 自动化",
    query: "输入近期热门议题", queryPlaceholder: "例如：AI 代理人、零售电商、个人品牌经营",
    sourceLink: "贴上 IG／Threads 链接", sourceLinkPlaceholder: "https://www.instagram.com/... 或 https://www.threads.net/...",
    audienceScope: "采集策略", audienceScopeHint: "决定哪些候选可进正式客户池",
    vertical: "垂直精准", verticalHint: "产业＋角色／需求至少两层讯号；泛相关不进名单",
    expanded: "扩大范围", expandedHint: "固定近 30 天；精准、扩展候选、排除三层统计",
    recommended: "推荐", expand: "扩量",
    lookback: "采集资料时间范围", lookbackHint: "会实际筛选贴文与互动时间",
    lookbackNote: (label: string) => `目前选择「${label}」。没有可验证时间的资料不会混入结果。`,
    lookbackLabel: (days: number) => (days === 1 ? "今天" : `近${days}天`),
    platformHint: (names: string[]) => names.length === 0
      ? "尚未选择采集平台。请点选 Threads 或 Instagram。"
      : names.length === 1
        ? `已选择 ${names[0]}。只会在该平台采集，不会跨平台混标。`
        : `已选择 ${names.join("＋")}，共 ${names.length} 个平台，将分别执行并自动去重。`,
    keywordLimit: "每个关键词采集范围", hotspotPostRange: "热点贴文选取范围",
    customRange: "自订起讫范围", allPosts: "全部找到的贴文",
    perPostUsers: "每则贴文采集用户范围",
    limitFast: "6 条", limitStandard: "12 条", limitDeep: "30 条", limitNone: "不限",
    limit30: "30位", limit100: "100位", limit300: "300位",
    linkEngagement: "仅采集本篇贴文按赞、评论用户", linkFollowers: "采集该主账号公开可见粉丝",
    linkPlatformNote: "由链接自动辨识。单一贴文只会在所属平台采集，不会误标成跨平台。",
    batchName: "本次采集批次名称", batchNameHint: "选填，完成后仍可修改", batchPlaceholder: "例如：7 月房贷高意向名单", defaultBatch: "AI 潜在客户",
    summaryMode: "采集方式", summaryPlatform: "目标平台", summaryBatch: "本次采集批次", summaryLookback: "资料时间范围", summaryScope: "采集策略",
    selectAllSources: "选择全部", clearSources: "清除选取",
    personaShort: "需求定向采集", hotspotShort: "热点全域采集", linkShort: "链接精准采集",
    engageSteps: ["选客户", "写内容", "选方式", "确认"],
    relationSteps: ["选客户", "选账号", "确认"],
    assistant: "Vecto AI 操作助手", assistantHints: {
      collect: "沿用原 CRM 的三步采集：先选方式，再分析需求或搜索热点，最后核对范围并启动。",
      public: "先从客户池选择目标，再准备公开留言内容，最后完成执行前检查并确认发布。",
      outreach: "先选客户、再绑定模板，最后选择样本、批次或排程；不会跳过重复触达检查。",
      groups: "先确定邀请对象与平台，再准备邀请内容；Instagram 群聊和 Threads 邀请帖会明确区分。",
      relationships: "从客户池选择要复核的客户，再使用 Instagram 账号进行只读关系检查。",
    },
    mode: "采集方式",
    platform: "采集平台", threads: "Threads", instagram: "Instagram", limit: "采集上限", analysis: "需求与客户画像分析", targetPersona: "目标画像", customerIntent: "客户意向", mainNeed: "主要需求", painPoint: "关注痛点", segments: "子画像", scenarios: "需求场景", keywords: "搜索关键词", results: "真实搜索结果", selectedSources: "已选择来源", noResults: "没有找到可用结果，可返回修改关键词。",
    pool: "客户池", choosePool: "请选择客户池", recipients: "选择客户", selectAll: "选择本页全部", clear: "清空选择", loadMoreMembers: "加载更多客户", selected: (count: number) => `实际执行 ${count} 位客户`, noMembers: "该客户池暂无可用客户。", unavailableMember: "缺少平台账号或原帖链接，无法用于当前动作",
    template: "消息模板", chooseTemplate: "不使用已保存模板", content: "任务内容", contentPlaceholder: "填写公开留言、私信或邀请内容", publicMode: "公开互动方式", publicComment: "首次公开留言", publicReply: "公开回复", followupReply: "跟进回复", nurtureReply: "持续互动培育", publicReplyHint: "回复类动作必须选择带有原帖或评论链接的客户；系统会逐条保留提交证据。", publicStrategy: "留言策略", questionStrategy: "自然问句", questionStrategyHint: "回应原文，再提出一个容易回答的问题", offerStrategy: "提供帮助", offerStrategyHint: "先回应需求，再邀请对方回复关键词", groupStrategy: "征求群邀同意", groupStrategyHint: "只邀请对方回复同意，不会直接拉入群组", groupMode: "群组方式", threadsPost: "Threads 社群邀请帖", instagramDirect: "Instagram Direct 群聊",
    account: "执行账号", chooseAccount: "请选择账号", accountLogin: "需要先登录", execution: "执行方式", sample: "少量样本", sampleHint: "手动选择 1–20 位真实客户先行测试", batch: "稳定分批", batchHint: "按所选客户逐个执行并记录证据", schedule: "定时排程", scheduleHint: "到指定时间创建任务；真实动作仍按确认与计费规则执行", scheduleAt: "执行时间",
    scheduleCadence: "排程频率", scheduleOnce: "单次执行", scheduleDaily: "每日采集", dailyAt: "每天执行时间", dailyHint: "每天使用相同画像、关键词、范围和账号创建一个新的采集任务。",
    trustFirstTitle: "信任触达规则", trustFirstHint: "首次私信只发送给已公开回复，或已验证关注执行账号的客户。", trustFirstSteps: ["未达到信任门槛的客户会在执行前检查中自动排除", "首次私信使用短文字，不附链接、电话、LINE 或图片", "发送前会再次显示可执行人数、跳过原因和预计扣点"],
    confirmation: "提交前确认", action: "任务类型", targetRange: "目标范围", billing: "计费", billingWrite: "执行前检查通过后，按已确认批次扣点", billingRead: "只读操作免费，但会保留任务与结果记录", consent: "我已核对账号、目标客户与内容，并确认允许系统执行以上真实平台动作。",
    aiDrafts: "按原帖生成 AI 留言草稿", aiDrafting: "正在逐条生成草稿…", aiDraftHint: "每位客户会保留独立草稿；提交前仍可逐条修改。", draftFor: "给这位客户的留言",
    prepared: "准备完成", taskQueued: "任务已进入队列", scheduleSaved: "排程已保存", searchWarning: "结果来自实时搜索，请在继续前勾选正确来源。",
    runPreflight: "检查目标与计费", confirmAfterPreflight: "确认并开始", preflightTitle: "执行前检查", preflightHint: "请确认可执行目标、跳过原因和预计扣点，再开始任务。",
    totalTargets: "提交目标", allowedTargets: "可执行", duplicateTargets: "重复跳过", blockedTargets: "策略拦截", estimatedPoints: "预计扣点", expiresAt: "确认有效至", skippedTargets: "跳过明细", noCharge: "本次不扣点",
  },
  "zh-Hant": {
    title: "建立 CRM 任務", collectTitle: "採集用戶", close: "關閉", back: "上一步", next: "下一步", cancel: "取消", prepare: "分析並繼續",
    submit: "確認並開始", collectStart: "開始採集", submitting: "正在建立任務…", loading: "正在讀取客戶池、範本和帳號…", required: "請完成目前步驟的必填內容。",
    step: (current: number, total: number) => `步驟 ${current}／${total}`,
    collectSteps: ["填寫設定", "確認啟動"],
    collectHint2: "，AI 會先解析並讓你確認，再啟動採集。",
    collectHint3Persona: "需求已拆解成畫像與多組關鍵詞，將併發執行並自動去重。",
    collectHint3Hotspot: "已找出高互動貼文，請勾選要深入採集的來源。",
    collectHint3Link: "請核對連結與採集範圍，再開始採集。",
    preparePersona: "分析畫像並繼續", prepareHotspot: "搜尋熱門貼文並繼續", prepareLink: "驗證連結並繼續",
    preparingPersona: "AI 正在拆解需求…", preparingHotspot: "搜尋真實熱點中…", preparingLink: "正在驗證連結…",
    demand: "描述你的目標用戶", demandPlaceholder: "例如：台灣 25–40 歲、經營電商品牌、關注 AI 自動化",
    query: "輸入近期熱門議題", queryPlaceholder: "例如：AI 代理人、零售電商、個人品牌經營",
    sourceLink: "貼上 IG／Threads 連結", sourceLinkPlaceholder: "https://www.instagram.com/... 或 https://www.threads.net/...",
    audienceScope: "採集策略", audienceScopeHint: "決定哪些候選可進正式客戶池",
    vertical: "垂直精準", verticalHint: "產業＋角色／需求至少兩層訊號；泛相關不進名單",
    expanded: "擴大範圍", expandedHint: "固定近 30 天；精準、擴展候選、排除三層統計",
    recommended: "推薦", expand: "擴量",
    lookback: "採集資料時間範圍", lookbackHint: "會實際篩選貼文與互動時間",
    lookbackNote: (label: string) => `目前選擇「${label}」。沒有可驗證時間的資料不會混入結果。`,
    lookbackLabel: (days: number) => (days === 1 ? "今天" : `近${days}天`),
    platformHint: (names: string[]) => names.length === 0
      ? "尚未選擇採集平台。請點選 Threads 或 Instagram。"
      : names.length === 1
        ? `已選擇 ${names[0]}。只會在該平台採集，不會跨平台混標。`
        : `已選擇 ${names.join("＋")}，共 ${names.length} 個平台，將分別執行並自動去重。`,
    keywordLimit: "每個關鍵詞採集範圍", hotspotPostRange: "熱點貼文選取範圍",
    customRange: "自訂起訖範圍", allPosts: "全部找到的貼文",
    perPostUsers: "每則貼文採集用戶範圍",
    limitFast: "6 筆", limitStandard: "12 筆", limitDeep: "30 筆", limitNone: "不限",
    limit30: "30位", limit100: "100位", limit300: "300位",
    linkEngagement: "僅採集本篇貼文按讚、評論用戶", linkFollowers: "採集該主帳號公開可見粉絲",
    linkPlatformNote: "由連結自動辨識。單一貼文只會在所屬平台採集，不會誤標成跨平台。",
    batchName: "本次採集批次名稱", batchNameHint: "選填，完成後仍可修改", batchPlaceholder: "例如：7 月房貸高意向名單", defaultBatch: "AI 潛在客戶",
    summaryMode: "採集方式", summaryPlatform: "目標平台", summaryBatch: "本次採集批次", summaryLookback: "資料時間範圍", summaryScope: "採集策略",
    selectAllSources: "選擇全部", clearSources: "清除選取",
    personaShort: "需求定向採集", hotspotShort: "熱點全域採集", linkShort: "連結精準採集",
    engageSteps: ["選客戶", "寫內容", "選方式", "確認"],
    relationSteps: ["選客戶", "選帳號", "確認"],
    assistant: "Vecto AI 操作助手", assistantHints: {
      collect: "沿用原 CRM 的三步採集：先選方式，再分析需求或搜尋熱點，最後核對範圍並啟動。",
      public: "先從客戶池選擇目標，再準備公開留言內容，最後完成執行前檢查並確認發佈。",
      outreach: "先選客戶、再綁定範本，最後選擇樣本、批次或排程；不會跳過重複觸達檢查。",
      groups: "先確定邀請對象與平台，再準備邀請內容；Instagram 群聊和 Threads 邀請貼文會明確區分。",
      relationships: "從客戶池選擇要複核的客戶，再使用 Instagram 帳號進行唯讀關係檢查。",
    },
    mode: "採集方式",
    platform: "採集平台", threads: "Threads", instagram: "Instagram", limit: "採集上限", analysis: "需求與客戶畫像分析", targetPersona: "目標畫像", customerIntent: "客戶意向", mainNeed: "主要需求", painPoint: "關注痛點", segments: "子畫像", scenarios: "需求場景", keywords: "搜尋關鍵詞", results: "真實搜尋結果", selectedSources: "已選擇來源", noResults: "沒有找到可用結果，可返回修改關鍵詞。",
    pool: "客戶池", choosePool: "請選擇客戶池", recipients: "選擇客戶", selectAll: "選擇本頁全部", clear: "清空選擇", loadMoreMembers: "載入更多客戶", selected: (count: number) => `實際執行 ${count} 位客戶`, noMembers: "該客戶池暫無可用客戶。", unavailableMember: "缺少平台帳號或原貼文連結，無法用於目前動作",
    template: "訊息範本", chooseTemplate: "不使用已儲存範本", content: "任務內容", contentPlaceholder: "填寫公開留言、私訊或邀請內容", publicMode: "公開互動方式", publicComment: "首次公開留言", publicReply: "公開回覆", followupReply: "跟進回覆", nurtureReply: "持續互動培育", publicReplyHint: "回覆類動作必須選擇帶有原貼文或留言連結的客戶；系統會逐則保留提交證據。", publicStrategy: "留言策略", questionStrategy: "自然問句", questionStrategyHint: "回應原文，再提出一個容易回答的問題", offerStrategy: "提供幫助", offerStrategyHint: "先回應需求，再邀請對方回覆關鍵詞", groupStrategy: "徵求群邀同意", groupStrategyHint: "只邀請對方回覆同意，不會直接拉入群組", groupMode: "群組方式", threadsPost: "Threads 社群邀請貼文", instagramDirect: "Instagram Direct 群聊",
    account: "執行帳號", chooseAccount: "請選擇帳號", accountLogin: "需要先登入", execution: "執行方式", sample: "少量樣本", sampleHint: "手動選擇 1–20 位真實客戶先行測試", batch: "穩定分批", batchHint: "按所選客戶逐個執行並記錄證據", schedule: "定時排程", scheduleHint: "到指定時間建立任務；真實動作仍按確認與計費規則執行", scheduleAt: "執行時間",
    scheduleCadence: "排程頻率", scheduleOnce: "單次執行", scheduleDaily: "每日採集", dailyAt: "每天執行時間", dailyHint: "每天使用相同畫像、關鍵詞、範圍和帳號建立一個新的採集任務。",
    trustFirstTitle: "信任觸達規則", trustFirstHint: "首次私訊只發送給已公開回覆，或已驗證關注執行帳號的客戶。", trustFirstSteps: ["未達到信任門檻的客戶會在執行前檢查中自動排除", "首次私訊使用短文字，不附連結、電話、LINE 或圖片", "發送前會再次顯示可執行人數、略過原因和預計扣點"],
    confirmation: "提交前確認", action: "任務類型", targetRange: "目標範圍", billing: "計費", billingWrite: "執行前檢查通過後，按已確認批次扣點", billingRead: "唯讀操作免費，但會保留任務與結果記錄", consent: "我已核對帳號、目標客戶與內容，並確認允許系統執行以上真實平台動作。",
    aiDrafts: "按原貼文生成 AI 留言草稿", aiDrafting: "正在逐則生成草稿…", aiDraftHint: "每位客戶會保留獨立草稿；提交前仍可逐則修改。", draftFor: "給這位客戶的留言",
    prepared: "準備完成", taskQueued: "任務已進入佇列", scheduleSaved: "排程已儲存", searchWarning: "結果來自即時搜尋，請在繼續前勾選正確來源。",
    runPreflight: "檢查目標與計費", confirmAfterPreflight: "確認並開始", preflightTitle: "執行前檢查", preflightHint: "請確認可執行目標、略過原因和預計扣點，再開始任務。",
    totalTargets: "提交目標", allowedTargets: "可執行", duplicateTargets: "重複跳過", blockedTargets: "策略攔截", estimatedPoints: "預計扣點", expiresAt: "確認有效至", skippedTargets: "跳過明細", noCharge: "本次不扣點",
  },
} as const;

function objectOf(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  if (typeof value === "string") { try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {}; } catch { return {}; } }
  return {};
}

function arrayOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
  return [];
}

function rowId(row: Row) { return String(row.id || row.lead_id || row.task_id || row.username || ""); }
function memberLead(row: Row) { return objectOf(row.lead || row.profile || row.profile_json); }
function memberId(row: Row) { return String(row.lead_id || memberLead(row).id || row.id || ""); }
function memberUsername(row: Row) { const lead = memberLead(row); return String(row.username || lead.username || "").replace(/^@/, ""); }
function memberLabel(row: Row) { const lead = memberLead(row); return String(row.display_name || lead.display_name || memberUsername(row) || memberId(row)); }
function memberTarget(row: Row) {
  const lead = memberLead(row);
  const profile = objectOf(lead.profile || lead.profile_json || row.profile_json);
  return String(row.source_url || row.sourcePostUrl || lead.source_url || lead.sourcePostUrl || profile.source_url || profile.sourcePostUrl || profile.post_url || profile.url || "");
}

function platformFromUrl(value: string): "threads" | "instagram" | "" {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host === "threads.net" || host.endsWith(".threads.net") || host === "threads.com" || host.endsWith(".threads.com")) return "threads";
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
  } catch { /* The server performs the authoritative URL validation. */ }
  return "";
}

function accountReady(account?: CrmAccount) {
  if (!account) return false;
  if (account.needs_login) return false;
  const blocked = ["pending_login", "needs_login", "need_verification", "cookie_expired", "expired", "abnormal", "banned", "disabled", "blocked", "suspended"];
  return !blocked.includes(String(account.status || "").toLowerCase()) && !blocked.includes(String(account.health_status || "").toLowerCase());
}

function asRows(value: unknown): Row[] { return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item))) : []; }
function futureLocalValue() { const date = new Date(Date.now() + 60 * 60 * 1000); date.setSeconds(0, 0); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
function nextDailyRun(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]); const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const date = new Date(); date.setHours(hour, minute, 0, 0);
  if (date.getTime() <= Date.now() + 60_000) date.setDate(date.getDate() + 1);
  return date;
}

export function WorkflowWizard({
  view, messages, language, capabilities, seed, onClose, onCreated,
}: {
  view: WizardView | null;
  messages: Messages;
  language: Language;
  capabilities?: Record<string, { enabled?: boolean }>;
  seed?: WorkflowSeed | null;
  onClose: () => void;
  onCreated: (taskId: string) => void;
}) {
  const t = copy[language];
  const dialog = useRef<HTMLElement>(null);
  const idempotency = useRef("");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [accounts, setAccounts] = useState<CrmAccount[]>([]);
  const [pools, setPools] = useState<Row[]>([]);
  const [templates, setTemplates] = useState<Row[]>([]);
  const [poolId, setPoolId] = useState("");
  const [members, setMembers] = useState<Row[]>([]);
  const [memberCursor, setMemberCursor] = useState("");
  const [membersHaveMore, setMembersHaveMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [accountId, setAccountId] = useState("");
  const [collectAccountIds, setCollectAccountIds] = useState<Record<"threads" | "instagram", string>>({ threads: "", instagram: "" });
  const [templateId, setTemplateId] = useState("");
  const [content, setContent] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [execution, setExecution] = useState<ExecutionMode>("sample");
  const [scheduleAt, setScheduleAt] = useState(futureLocalValue());
  const [scheduleCadence, setScheduleCadence] = useState<"once" | "daily">("once");
  const [dailyTime, setDailyTime] = useState(() => futureLocalValue().slice(11, 16));
  const [collectMode, setCollectMode] = useState<"persona" | "hotspot" | "link">("persona");
  const [collectInput, setCollectInput] = useState("");
  const [collectLimit, setCollectLimit] = useState(12);
  const [audienceScope, setAudienceScope] = useState<"vertical" | "expanded">("vertical");
  const [lookbackDays, setLookbackDays] = useState(7);
  const [linkOptions, setLinkOptions] = useState({ engagement: true, followers: false });
  const [category, setCategory] = useState("");
  const [platforms, setPlatforms] = useState({ threads: true, instagram: false });
  const [prepared, setPrepared] = useState<Row | null>(null);
  const [sourceSelection, setSourceSelection] = useState<Set<string>>(new Set());
  const [groupMode, setGroupMode] = useState<"threads" | "instagram">("threads");
  const [publicAction, setPublicAction] = useState<PublicActionType>("public_comment");
  const [replyStrategy, setReplyStrategy] = useState<ReplyStrategy>("question_hook");
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);

  const totalSteps = view === "collect" ? 2 : view === "relationships" ? 3 : 4;
  const stepNames = view === "collect" ? t.collectSteps : view === "relationships" ? t.relationSteps : t.engageSteps;
  const memberEligible = (row: Row) => {
    if (view === "public") return Boolean(memberTarget(row));
    if (view === "outreach" || view === "relationships") return Boolean(memberUsername(row));
    if (view === "groups" && groupMode === "instagram") return Boolean(memberUsername(row));
    return true;
  };
  const selectedMembers = useMemo(
    () => members.filter((row) => selected.has(memberId(row)) && memberEligible(row)),
    [groupMode, members, selected, view],
  );
  const effectiveRecipients = useMemo(() => {
    const limit = seed?.batchSize || (execution === "sample" ? 20 : selectedMembers.length);
    if (execution === "sample" || seed?.batchSize) return selectedMembers.slice(0, Math.max(1, Number(limit) || 20));
    return selectedMembers;
  }, [execution, seed?.batchSize, selectedMembers]);
  const selectedAccount = accounts.find((account) => String(account.id) === accountId);
  const selectedAccountReady = accountReady(selectedAccount);
  const collectPlatforms = (["threads", "instagram"] as const).filter((platform) => platforms[platform]);
  const isWrite = view === "public" || view === "outreach" || view === "groups";
  const requiredPlatform = view === "relationships" || (view === "groups" && groupMode === "instagram") ? "instagram" : view === "public" || view === "groups" ? "threads" : "";
  const supportedAccounts = accounts.filter((account) => !requiredPlatform || String(account.platform || "").toLowerCase() === requiredPlatform);

  useEffect(() => {
    if (!view) return;
    idempotency.current = `crm-wizard:${view}:${window.crypto.randomUUID()}`;
    setCollectMode(seed?.collectMode || "persona");
    setCollectInput(seed?.collectInput || "");
    setCollectLimit(seed?.collectMode === "hotspot" ? 30 : 12);
    setAudienceScope("vertical");
    setLookbackDays(7);
    setLinkOptions({ engagement: true, followers: false });
    setCategory("");
    setExecution(seed?.execution || (seed?.batchSize ? "batch" : view === "collect" ? "batch" : "sample"));
    setScheduleCadence("once");
    setReplyStrategy("question_hook");
    setStep(1); setError(""); setBusy("load"); setSelected(new Set()); setPrepared(null); setSourceSelection(new Set()); setDrafts({}); setConsent(false); setPreflightResult(null);
    Promise.all([crmApi.list("accounts", "", 100), crmApi.list("pools", "", 200), crmApi.list("templates", "", 200)])
      .then(([accountPayload, poolPayload, templatePayload]) => {
        const nextAccounts = payloadItems(accountPayload) as CrmAccount[];
        const nextPools = payloadItems(poolPayload);
        const nextTemplates = payloadItems(templatePayload);
        const preferredType = view === "public" ? "comment" : view === "groups" ? "group_invite" : "message";
        const preferred = nextTemplates.find((row) => Boolean(row.is_default) && String(row.locale || language) === language && String(row.template_type || "message") === preferredType)
          || nextTemplates.find((row) => Boolean(row.is_default) && String(row.template_type || "message") === preferredType);
        setAccounts(nextAccounts); setPools(nextPools); setTemplates(nextTemplates);
        setCollectAccountIds({
          threads: String(nextAccounts.find((row) => String(row.platform || "").toLowerCase() === "threads" && accountReady(row))?.id || ""),
          instagram: String(nextAccounts.find((row) => String(row.platform || "").toLowerCase() === "instagram" && accountReady(row))?.id || ""),
        });
        setTemplateId(preferred ? rowId(preferred) : "");
        setContent(preferred ? String(preferred.content || "") : "");
        setPoolId(seed?.poolId && nextPools.some((pool) => rowId(pool) === seed.poolId) ? seed.poolId : rowId(nextPools[0] || {}));
      })
      .catch((next) => setError(localizedError(next, messages)))
      .finally(() => setBusy(""));
  }, [messages, seed?.batchSize, seed?.collectInput, seed?.collectMode, seed?.execution, seed?.poolId, view]);

  useEffect(() => {
    if (!view || !poolId || view === "collect") { setMembers([]); setMemberCursor(""); setMembersHaveMore(false); return; }
    setBusy("members"); setError("");
    crmApi.poolMembers(poolId, "", 200).then((payload) => {
      const rows = payloadItems(payload);
      const extras = (seed?.leads || []).filter((row) => !rows.some((item) => memberId(item) === memberId(row)));
      setMembers([...extras, ...rows]);
      const seeded = (seed?.leadIds || extras.map(memberId)).filter(Boolean);
      setSelected(new Set(seeded.length ? seeded : []));
      setMemberCursor(String(payload.next_cursor || ""));
      setMembersHaveMore(Boolean(payload.has_more && payload.next_cursor));
    }).catch((next) => setError(localizedError(next, messages))).finally(() => setBusy(""));
  }, [messages, poolId, seed?.leadIds, seed?.leads, view]);

  const loadMoreMembers = async () => {
    if (!poolId || !memberCursor || busy) return;
    setBusy("members-more"); setError("");
    try {
      const payload = await crmApi.poolMembers(poolId, memberCursor, 200);
      const appended = payloadItems(payload);
      setMembers((current) => {
        const byId = new Map(current.map((row) => [memberId(row), row]));
        appended.forEach((row) => byId.set(memberId(row), row));
        return [...byId.values()];
      });
      setMemberCursor(String(payload.next_cursor || ""));
      setMembersHaveMore(Boolean(payload.has_more && payload.next_cursor));
    } catch (next) { setError(localizedError(next, messages)); }
    finally { setBusy(""); }
  };

  useEffect(() => {
    if (!view) return;
    const candidates = supportedAccounts.filter((item) => accountReady(item));
    if (!candidates.some((item) => String(item.id) === accountId)) setAccountId(String(candidates[0]?.id || ""));
  }, [accountId, requiredPlatform, supportedAccounts, view]);

  useEffect(() => {
    setPreflightResult(null);
    setConsent(false);
  }, [accountId, collectAccountIds, content, drafts, execution, groupMode, poolId, publicAction, replyStrategy, scheduleAt, scheduleCadence, dailyTime, selected, templateId]);

  useEffect(() => {
    if (!view) return;
    const previous = document.activeElement as HTMLElement | null;
    window.requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>("button, select, input, textarea")?.focus());
    const onKey = (event: KeyboardEvent) => {
      const node = dialog.current;
      if (event.key === "Escape") onCloseRef.current();
      if (event.key !== "Tab" || !node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [view]);

  if (!view) return null;

  const selectTemplate = (id: string) => {
    setTemplateId(id);
    const template = templates.find((row) => rowId(row) === id);
    if (template) setContent(String(template.content || ""));
  };

  const effectiveCollectLimit = collectLimit === 0 ? 200 : collectLimit;
  const collectLinkPlatform = collectMode === "link" ? platformFromUrl(collectInput) : "";
  const prepareCollection = async () => {
    if (collectInput.trim().length < 2) { setError(t.required); return; }
    if (collectMode !== "link" && !platforms.threads && !platforms.instagram) { setError(t.required); return; }
    if (collectMode === "link" && !linkOptions.engagement && !linkOptions.followers) { setError(t.required); return; }
    setBusy("prepare"); setError("");
    try {
      let result: Row;
      if (collectMode === "persona") result = await crmApi.analyzeDemand({ text: collectInput.trim(), locale: language, audience_scope: audienceScope, lookback_days: lookbackDays, limit: effectiveCollectLimit });
      else if (collectMode === "hotspot") result = await crmApi.searchHotspots({ query: collectInput.trim(), platform: "threads", accountId: collectAccountIds.threads || accountId, account_id: collectAccountIds.threads || accountId, limit: 40, locale: language, lookback_days: lookbackDays, lookbackDays: lookbackDays });
      else {
        const url = new URL(collectInput.trim());
        if (url.protocol !== "https:" || !/(^|\.)(threads\.com|threads\.net|instagram\.com)$/i.test(url.hostname)) throw new Error(t.required);
        result = { mode: "link", data: [{ sourceUrl: url.href, text: url.href }] };
      }
      setPrepared(result);
      const rows = asRows(result.data || result.items || result.results);
      setSourceSelection(new Set(rows.map((row) => String(row.sourceUrl || row.source_url || row.url || "")).filter(Boolean)));
      setStep(2);
    } catch (next) { setError(localizedError(next, messages)); }
    finally { setBusy(""); }
  };

  const collectActions = () => {
    const rows = asRows(prepared?.data || prepared?.items || prepared?.results);
    if (collectMode === "hotspot" || collectMode === "link") {
      return rows.filter((row) => sourceSelection.has(String(row.sourceUrl || row.source_url || row.url || ""))).map((row) => {
        const target = String(row.sourceUrl || row.source_url || row.url || "");
        const platform = collectMode === "hotspot" ? "threads" : platformFromUrl(target);
        return { action_type: "collect_profile", account_id: platform ? collectAccountIds[platform] : "", target_key: target, content: "", payload: { target_url: target, source: collectMode, platform, query: collectInput.trim(), category: category.trim() || t.defaultBatch, lookback_days: lookbackDays, limit: effectiveCollectLimit, collect_engagement: linkOptions.engagement, collect_followers: linkOptions.followers } };
      });
    }
    const grouped = arrayOf(prepared?.keywordGroups ?? prepared?.keyword_groups).flatMap((group) => arrayOf(objectOf(group).keywords).map(String));
    const keywords = [...new Set([...arrayOf(prepared?.keywords).map(String), ...grouped].map((item) => item.trim()).filter(Boolean))].slice(0, Math.min(effectiveCollectLimit, 24));
    return keywords.flatMap((keyword) => collectPlatforms.map((platform) => ({
      action_type: "collect_feed", account_id: collectAccountIds[platform], target_key: `search:${platform}:${keyword}`, content: "",
      payload: { query: keyword, platform, platforms: { [platform]: true }, limit: effectiveCollectLimit, lookback_days: lookbackDays, audience_scope: audienceScope, category: category.trim() || t.defaultBatch, source: collectInput.trim() },
    })));
  };

  const preparePublicDrafts = async () => {
    if (view !== "public" || !poolId || !selectedMembers.length) { setError(t.required); return; }
    setBusy("drafts"); setError("");
    try {
      const result = await crmApi.generateCommentDrafts({
        poolId,
        selectedLeadIds: selectedMembers.map(memberId),
        limit: Math.min(20, selectedMembers.length),
        replyStrategy,
        mentionSourceAuthor: true,
        locale: language,
      });
      const nextDrafts: Record<string, string> = {};
      asRows(result.data).forEach((row) => {
        const leadId = String(row.leadId || row.lead_id || "");
        const draft = String(row.comment || "").trim();
        if (leadId && draft && row.selected !== false) nextDrafts[leadId] = draft;
      });
      setDrafts(nextDrafts);
      if (!Object.keys(nextDrafts).length) setError(t.required);
    } catch (next) { setError(localizedError(next, messages)); }
    finally { setBusy(""); }
  };

  const actionRows = () => {
    const recipients = effectiveRecipients;
    if (view === "public") return recipients.map((row) => {
      const comment = String(drafts[memberId(row)] || content).trim();
      return { action_type: publicAction, account_id: accountId, target_key: memberTarget(row), content: comment, payload: { target_url: memberTarget(row), content: comment, lead_id: memberId(row), recipient: memberUsername(row), interaction_mode: publicAction, reply_strategy: replyStrategy } };
    });
    if (view === "outreach") return recipients.map((row) => ({ action_type: "direct_message", account_id: accountId, target_key: memberUsername(row), content: content.trim(), payload: { recipient: memberUsername(row), content: content.trim(), message: content.trim(), lead_id: memberId(row), template_id: templateId, trust_first: true } }));
    if (view === "groups" && groupMode === "threads") return [{ action_type: "threads_group_invite_post", account_id: accountId, target_key: `threads:community:${poolId}`, content: content.trim(), payload: { content: content.trim(), pool_id: poolId, lead_ids: recipients.map(memberId), template_id: templateId } }];
    if (view === "groups" && groupMode === "instagram") return [{ action_type: "instagram_group_create", account_id: accountId, target_key: `instagram:direct:new:${poolId}`, content: content.trim(), payload: { confirmed: true, expected_username: String(selectedAccount?.username || "").replace(/^@/, ""), message: content.trim(), members: recipients.slice(0, 10).map(memberUsername).filter(Boolean), pool_id: poolId, lead_ids: recipients.slice(0, 10).map(memberId), template_id: templateId } }];
    return [];
  };

  const submit = async () => {
    setBusy("submit"); setError("");
    try {
      if (view === "relationships") {
        const result = await crmApi.verifyRelationships({ account_id: accountId, lead_ids: selectedMembers.map(memberId), idempotency_key: idempotency.current });
        onCreated(result.task_id); onClose(); return;
      }
      const actions = view === "collect" ? collectActions() : actionRows();
      if (!actions.length || actions.some((action) => !action.account_id)) { setError(t.required); return; }
      if (isWrite && !preflightResult) {
        const checked = await crmApi.preflight({ workflow_type: view, actions });
        setPreflightResult(checked);
        setConsent(false);
        return;
      }
      if (isWrite && !consent) { setError(t.required); return; }
      const executableActions = preflightResult?.actions?.length ? preflightResult.actions : actions;
      if (execution === "schedule") {
        const daily = view === "collect" && scheduleCadence === "daily";
        const at = daily ? nextDailyRun(dailyTime) : new Date(scheduleAt);
        if (!at) { setError(t.required); return; }
        if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now() + 60_000) { setError(t.required); return; }
        const schedule = await crmApi.createResource("schedules", {
          workflow_type: view, cron_expression: `${at.getMinutes()} ${at.getHours()} * * *`, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
          enabled: true, next_run_at: Math.floor(at.getTime() / 1000), payload: { run_once: !daily, confirmed: true, title: view === "collect" ? (category.trim() || t.collectTitle) : messages.views[view][0], input: { pool_id: poolId, template_id: templateId, account_id: accountId, execution, schedule_cadence: daily ? "daily" : "once", collect_mode: collectMode, source: collectInput.trim(), lookback_days: lookbackDays, audience_scope: audienceScope, category: category.trim() || t.defaultBatch, link_options: linkOptions }, actions: executableActions, preflight_token: preflightResult?.preflight_token || "" },
        });
        onCreated(`schedule:${rowId(schedule)}`); onClose(); return;
      }
      const result = await crmApi.createWorkflow({ workflow_type: view, title: view === "collect" ? (category.trim() || t.collectTitle) : messages.views[view][0], idempotency_key: idempotency.current, input: { pool_id: poolId, template_id: templateId, account_id: accountId, lead_ids: selectedMembers.map(memberId), execution, collect_mode: collectMode, source: collectInput.trim(), lookback_days: lookbackDays, audience_scope: audienceScope, category: category.trim() || t.defaultBatch, link_options: linkOptions }, actions: executableActions, ...(preflightResult ? { preflight_token: preflightResult.preflight_token } : {}), confirmed: isWrite ? consent : true });
      onCreated(result.task_id); onClose();
    } catch (next) { setError(localizedError(next, messages)); }
    finally { setBusy(""); }
  };

  const canContinue = () => {
    if (view === "collect") {
      if (step === 1) {
        if (collectInput.trim().length < 2) return false;
        if (collectMode === "link") return Boolean(collectLinkPlatform) && (linkOptions.engagement || linkOptions.followers);
        return platforms.threads || platforms.instagram;
      }
      const actions = collectActions();
      if (execution === "schedule") {
        const at = scheduleCadence === "daily" ? nextDailyRun(dailyTime) : new Date(scheduleAt);
        if (!at || Number.isNaN(at.getTime()) || at.getTime() <= Date.now() + 60_000) return false;
      }
      return actions.length > 0 && actions.every((action) => {
        const account = accounts.find((item) => String(item.id) === action.account_id);
        return accountReady(account);
      });
    }
    if (step === 1) return Boolean(poolId && selected.size && (view !== "groups" || groupMode !== "instagram" || selected.size >= 2));
    if (view === "relationships") return step === 2 ? Boolean(accountId) && selectedAccountReady : true;
    if (step === 2) {
      const draftTargets = effectiveRecipients;
      const allPublicDraftsReady = view === "public"
        && draftTargets.length > 0
        && draftTargets.every((row) => String(drafts[memberId(row)] || "").trim().length >= 2);
      const instagramGroupReady = view !== "groups" || groupMode !== "instagram" || (
        capabilities?.instagram_group_management?.enabled === true && selectedMembers.length >= 2
      );
      return (content.trim().length >= 2 || allPublicDraftsReady) && instagramGroupReady;
    }
    if (step === 3) return Boolean(
      accountId
      && selectedAccountReady
      && (execution !== "schedule" || Boolean(scheduleAt))
      && (execution !== "sample" || selectedMembers.length <= 20)
      && (view !== "groups" || groupMode !== "instagram" || selectedMembers.length <= 10)
    );
    return !preflightResult || consent;
  };

  const next = () => {
    setError("");
    if (!canContinue()) { setError(t.required); return; }
    if (view === "collect" && step === 1) { void prepareCollection(); return; }
    setStep((current) => Math.min(totalSteps, current + 1));
  };

  const renderPoolSelection = () => <>
    <label className="crm-field"><span>{t.pool}</span><SelectMenu value={poolId} onChange={setPoolId} placeholder={t.choosePool} searchPlaceholder={language === "zh-Hant" ? "篩選客戶池" : "筛选客户池"} emptyLabel={language === "zh-Hant" ? "沒有匹配的客戶池" : "没有匹配的客户池"} options={[{ value: "", label: t.choosePool }, ...pools.map((pool) => ({ value: rowId(pool), label: String(pool.name || rowId(pool)) }))]} /></label>
    <div className="crm-wizard-selection-head"><strong>{t.recipients}</strong><span>{t.selected(effectiveRecipients.length)}</span><div><button type="button" onClick={() => setSelected(new Set(members.filter(memberEligible).map(memberId).filter(Boolean)))}>{t.selectAll}</button><button type="button" onClick={() => setSelected(new Set())}>{t.clear}</button></div></div>
    {!members.length ? <p className="crm-quiet-empty">{busy === "members" ? t.loading : t.noMembers}</p> : <><div className="crm-wizard-members">{members.map((row) => { const id = memberId(row); const eligible = memberEligible(row); return <label key={id} title={eligible ? "" : t.unavailableMember}><input type="checkbox" disabled={!eligible} checked={eligible && selected.has(id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} /><span><strong>{memberLabel(row)}</strong><small>{eligible ? `@${memberUsername(row) || id}` : t.unavailableMember}</small></span></label>; })}</div>{membersHaveMore && <div className="crm-pagination"><button className="crm-secondary-button" type="button" disabled={busy === "members-more"} onClick={() => void loadMoreMembers()}>{busy === "members-more" ? t.loading : t.loadMoreMembers}</button></div>}</>}
  </>;

  const resultRows = asRows(prepared?.data || prepared?.items || prepared?.results);
  const keywordRows = arrayOf(prepared?.keywords).map(String).filter(Boolean);
  const analysisGroups = arrayOf(prepared?.keywordGroups ?? prepared?.keyword_groups).map(objectOf).filter((group) => arrayOf(group.keywords ?? group.items).length > 0);
  const analysisSegments = arrayOf(prepared?.segments).map(String).filter(Boolean);
  const analysisScenarios = arrayOf(prepared?.scenarios).map(String).filter(Boolean);
  const analysisTitle = String(prepared?.title || "").trim();
  const analysisIntent = String(prepared?.intent || "").trim();
  const analysisNeed = String(prepared?.need || "").trim();
  const analysisPain = String(prepared?.pain || "").trim();
  const hasPersonaAnalysis = collectMode === "persona" && Boolean(analysisTitle || analysisIntent || analysisNeed || analysisPain || analysisSegments.length || analysisScenarios.length || keywordRows.length || analysisGroups.length);
  const collectReviewPlatforms: Array<"threads" | "instagram"> = collectMode === "persona"
    ? collectPlatforms
    : [collectMode === "hotspot" ? "threads" : platformFromUrl(collectInput)].filter((item): item is "threads" | "instagram" => Boolean(item));

  const collectDemandLabel = collectMode === "persona" ? t.demand : collectMode === "hotspot" ? t.query : t.sourceLink;
  const collectAssistant = view === "collect"
    ? (step === 1 ? `${collectDemandLabel}${t.collectHint2}` : collectMode === "hotspot" ? t.collectHint3Hotspot : collectMode === "persona" ? t.collectHint3Persona : t.collectHint3Link)
    : t.assistantHints[view];
  const collectPrepareLabel = busy === "prepare"
    ? (collectMode === "hotspot" ? t.preparingHotspot : collectMode === "link" ? t.preparingLink : t.preparingPersona)
    : (collectMode === "hotspot" ? t.prepareHotspot : collectMode === "link" ? t.prepareLink : t.preparePersona);
  const collectModeLabel = collectMode === "persona" ? t.personaShort : collectMode === "hotspot" ? t.hotspotShort : t.linkShort;
  const collectPlatformNames = collectMode === "link"
    ? (collectLinkPlatform ? [collectLinkPlatform === "instagram" ? t.instagram : t.threads] : [])
    : [platforms.instagram ? t.instagram : "", platforms.threads ? t.threads : ""].filter(Boolean);
  const collectPlatformLabel = collectPlatformNames.join("＋") || "—";
  const goBack = () => {
    setError("");
    if (view === "collect" && step === 2) setPrepared(null);
    setStep((current) => Math.max(1, current - 1));
  };
  return <ConsoleModal title={view === "collect" ? t.collectTitle : `${t.title} · ${messages.views[view][0]}`} labelledBy="crmWorkflowTitle" onClose={onClose} onBack={step > 1 ? goBack : undefined} backLabel={t.back} wide dialogRef={dialog} actions={<>{step === 1 ? <button type="button" onClick={onClose}>{t.cancel}</button> : null}{step < totalSteps ? <button type="button" className="primary" disabled={Boolean(busy) || !canContinue()} onClick={next}>{view === "collect" ? collectPrepareLabel : busy === "prepare" ? t.prepare : t.next}</button> : <button type="button" className="primary" disabled={Boolean(busy) || !canContinue()} onClick={() => void submit()}>{busy === "submit" ? t.submitting : isWrite ? (preflightResult ? t.confirmAfterPreflight : t.runPreflight) : view === "collect" ? t.collectStart : t.submit}</button>}</>}>
      <div className="crm-wizard-progress" aria-label={t.step(step, totalSteps)}>{stepNames.map((name, index) => <span className={index + 1 === step ? "is-current" : index + 1 < step ? "is-complete" : ""} key={name}><i aria-hidden="true">{index + 1 < step ? <Icon name="check" /> : index + 1}</i><b>{name}</b></span>)}</div>
      <aside className="crm-wizard-assistant"><Icon name="signal" /><span>{view === "collect" ? null : <strong>{t.assistant}</strong>}{collectAssistant}</span></aside>
      <div className="crm-wizard-body">
        {busy === "load" && <p className="crm-quiet-empty">{t.loading}</p>}
        {view === "collect" && step === 1 && <div className="crm-form-grid crm-collect-form">
          {collectMode === "link" ? <div className="crm-field crm-field--wide"><span>{t.platform}</span><p className="crm-wizard-hint">{t.linkPlatformNote}{collectLinkPlatform ? ` ${collectLinkPlatform === "instagram" ? t.instagram : t.threads}` : ""}</p></div> : <fieldset className="crm-wizard-fieldset crm-platform-fieldset crm-field--wide"><legend>{t.platform}</legend><button className={platforms.instagram ? "is-active" : ""} type="button" data-account-platform="instagram" onClick={() => setPlatforms({ ...platforms, instagram: !platforms.instagram })}><PlatformLogo platform="instagram" /><strong>{t.instagram}</strong></button><button className={platforms.threads ? "is-active" : ""} type="button" data-account-platform="threads" onClick={() => setPlatforms({ ...platforms, threads: !platforms.threads })}><PlatformLogo platform="threads" /><strong>{t.threads}</strong></button><p className="crm-wizard-hint">{t.platformHint(collectPlatformNames)}</p></fieldset>}
          <label className="crm-field crm-field--wide"><span>{collectDemandLabel}</span><textarea rows={collectMode === "persona" ? 3 : 2} value={collectInput} onChange={(event) => setCollectInput(event.target.value)} placeholder={collectMode === "persona" ? t.demandPlaceholder : collectMode === "hotspot" ? t.queryPlaceholder : t.sourceLinkPlaceholder} /></label>
          {collectMode === "persona" && <fieldset className="crm-wizard-fieldset crm-field--wide crm-scope-cards"><legend>{t.audienceScope}</legend>
            <button type="button" className={audienceScope === "vertical" ? "is-active" : ""} onClick={() => { setAudienceScope("vertical"); if (lookbackDays === 30) setLookbackDays(7); }}><small>{t.recommended}</small><strong>{t.vertical}</strong></button>
            <button type="button" className={audienceScope === "expanded" ? "is-active" : ""} onClick={() => { setAudienceScope("expanded"); setLookbackDays(30); }}><small>{t.expand}</small><strong>{t.expanded}</strong></button>
            <p className="crm-wizard-hint">{audienceScope === "vertical" ? t.verticalHint : t.expandedHint}</p>
          </fieldset>}
          <fieldset className="crm-wizard-fieldset crm-field--wide crm-segmented-picks"><legend>{t.lookback}</legend>
            {([1, 3, 7, 15, 30] as const).map((days) => <button type="button" key={days} disabled={collectMode === "persona" && audienceScope === "expanded" && days !== 30} className={lookbackDays === days ? "is-active" : ""} onClick={() => setLookbackDays(days)}>{t.lookbackLabel(days)}</button>)}
            <p className="crm-wizard-hint">{t.lookbackNote(t.lookbackLabel(lookbackDays))}</p>
          </fieldset>
          {collectMode === "persona" && <fieldset className="crm-wizard-fieldset crm-field--wide crm-segmented-picks"><legend>{t.keywordLimit}</legend>
            {([[6, t.limitFast], [12, t.limitStandard], [30, t.limitDeep], [0, t.limitNone]] as const).map(([value, label]) => <button type="button" key={value} className={collectLimit === value ? "is-active" : ""} onClick={() => setCollectLimit(value)}>{label}</button>)}
          </fieldset>}
          {collectMode === "hotspot" && <fieldset className="crm-wizard-fieldset crm-field--wide crm-segmented-picks"><legend>{t.perPostUsers}</legend>
            {([[30, t.limit30], [100, t.limit100], [300, t.limit300], [0, t.limitNone]] as const).map(([value, label]) => <button type="button" key={value} className={collectLimit === value ? "is-active" : ""} onClick={() => setCollectLimit(value)}>{label}</button>)}
          </fieldset>}
          {collectMode === "link" && <fieldset className="crm-wizard-fieldset crm-field--wide"><legend>{t.mode}</legend>
            <label><input type="checkbox" checked={linkOptions.engagement} onChange={(event) => setLinkOptions({ ...linkOptions, engagement: event.target.checked })} />{t.linkEngagement}</label>
            <label><input type="checkbox" checked={linkOptions.followers} onChange={(event) => setLinkOptions({ ...linkOptions, followers: event.target.checked })} />{t.linkFollowers}</label>
          </fieldset>}
          <label className="crm-field crm-field--wide"><span>{t.batchName} · {t.batchNameHint}</span><input value={category} onChange={(event) => setCategory(event.target.value)} placeholder={t.batchPlaceholder} /></label>
        </div>}
        {view === "collect" && step === 2 && <div className="crm-wizard-review">
          <dl className="crm-collect-summary">
            <div><dt>{t.summaryMode}</dt><dd>{collectModeLabel}</dd></div>
            <div><dt>{t.summaryPlatform}</dt><dd>{collectPlatformLabel}</dd></div>
            <div><dt>{t.summaryBatch}</dt><dd>{category.trim() || t.defaultBatch}</dd></div>
            <div><dt>{t.summaryLookback}</dt><dd>{t.lookbackLabel(lookbackDays)}</dd></div>
            {collectMode === "persona" && <div><dt>{t.summaryScope}</dt><dd>{audienceScope === "vertical" ? t.vertical : t.expanded}</dd></div>}
          </dl>
          {collectReviewPlatforms.map((platform) => <label className="crm-field" key={platform}><span>{t.account} · {platform === "threads" ? t.threads : t.instagram}</span><SelectMenu value={collectAccountIds[platform]} onChange={(next) => setCollectAccountIds((current) => ({ ...current, [platform]: next }))} placeholder={t.chooseAccount} options={[{ value: "", label: t.chooseAccount }, ...accounts.filter((account) => String(account.platform || "").toLowerCase() === platform).map((account) => ({ value: String(account.id), label: `${account.display_name || account.username}${!accountReady(account) ? ` · ${t.accountLogin}` : ""}`, disabled: !accountReady(account) }))]} /></label>)}
          {hasPersonaAnalysis && <section className="crm-ai-result" aria-labelledby="crm-persona-analysis-title">
            <h3 id="crm-persona-analysis-title">{t.analysis}</h3>
            <dl className="crm-summary-grid">
              {analysisTitle && <div><dt>{t.targetPersona}</dt><dd>{analysisTitle}</dd></div>}
              {analysisIntent && <div><dt>{t.customerIntent}</dt><dd>{analysisIntent}</dd></div>}
              {analysisNeed && <div><dt>{t.mainNeed}</dt><dd>{analysisNeed}</dd></div>}
              {analysisPain && <div><dt>{t.painPoint}</dt><dd>{analysisPain}</dd></div>}
            </dl>
            {analysisSegments.length > 0 && <div className="crm-ai-detail"><strong>{t.segments}</strong><div className="crm-chip-row">{analysisSegments.map((item) => <span key={item}>{item}</span>)}</div></div>}
            {analysisScenarios.length > 0 && <div className="crm-ai-detail"><strong>{t.scenarios}</strong><div className="crm-chip-row">{analysisScenarios.map((item) => <span key={item}>{item}</span>)}</div></div>}
            {analysisGroups.length > 0 && <div className="crm-ai-groups">{analysisGroups.map((group, index) => {
              const items = arrayOf(group.keywords ?? group.items).map(String).filter(Boolean);
              return <article key={String(group.name || group.title || index)}><strong>{String(group.name || group.title || t.keywords)}</strong><div className="crm-chip-row">{items.map((item) => <span key={item}>{item}</span>)}</div></article>;
            })}</div>}
            {keywordRows.length > 0 && <div className="crm-ai-detail"><strong>{t.keywords}</strong><div className="crm-chip-row">{keywordRows.map((keyword) => <span key={keyword}>{keyword}</span>)}</div></div>}
          </section>}
          {resultRows.length > 0 && <section><h3>{t.results} · {t.selectedSources} {sourceSelection.size}</h3>
            <div className="crm-wizard-selection-head"><strong>{t.results}</strong><span>{sourceSelection.size}/{resultRows.length}</span><div><button type="button" onClick={() => setSourceSelection(new Set(resultRows.map((row) => String(row.sourceUrl || row.source_url || row.url || "")).filter(Boolean)))}>{t.selectAllSources} {resultRows.length}</button><button type="button" onClick={() => setSourceSelection(new Set())}>{t.clearSources}</button></div></div>
            <p className="crm-wizard-note">{t.searchWarning}</p>
            <div className="crm-wizard-results">{resultRows.map((row, index) => { const url = String(row.sourceUrl || row.source_url || row.url || ""); return <label key={url || index}><input type="checkbox" checked={sourceSelection.has(url)} onChange={() => setSourceSelection((current) => { const next = new Set(current); if (next.has(url)) next.delete(url); else next.add(url); return next; })} /><span><strong>{String(row.username || row.title || `#${index + 1}`)}</strong><small>{String(row.text || row.content || url).slice(0, 180)}</small></span></label>; })}</div>
          </section>}
          {!hasPersonaAnalysis && !resultRows.length && <p className="crm-quiet-empty">{t.noResults}</p>}
          <fieldset className="crm-wizard-fieldset crm-field--wide crm-segmented-picks" data-collect-execution="true"><legend>{t.execution}</legend>
            <button type="button" className={execution !== "schedule" ? "is-active" : ""} onClick={() => setExecution("batch")}>{language === "zh-Hant" ? "立即採集" : "立即采集"}</button>
            <button type="button" className={execution === "schedule" ? "is-active" : ""} onClick={() => setExecution("schedule")}>{t.schedule}</button>
          </fieldset>
          {execution === "schedule" && <><fieldset className="crm-wizard-fieldset crm-field--wide crm-segmented-picks"><legend>{t.scheduleCadence}</legend><button type="button" className={scheduleCadence === "once" ? "is-active" : ""} onClick={() => setScheduleCadence("once")}>{t.scheduleOnce}</button><button type="button" className={scheduleCadence === "daily" ? "is-active" : ""} onClick={() => setScheduleCadence("daily")}>{t.scheduleDaily}</button></fieldset>{scheduleCadence === "once" ? <label className="crm-field crm-field--wide"><span>{t.scheduleAt}</span><input type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} /></label> : <label className="crm-field crm-field--wide"><span>{t.dailyAt}</span><input type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} /><small>{t.dailyHint}</small></label>}</>}
        </div>}
        {view !== "collect" && step === 1 && <>{renderPoolSelection()}{view === "outreach" && <section className="crm-wizard-policy-card" aria-label={t.trustFirstTitle}><header><Icon name="relationships" /><div><strong>{t.trustFirstTitle}</strong><span>{t.trustFirstHint}</span></div></header><ol>{t.trustFirstSteps.map((item) => <li key={item}>{item}</li>)}</ol></section>}</>}
        {view !== "collect" && view !== "relationships" && step === 2 && <div className="crm-form-grid">
          {view === "public" && <><fieldset className="crm-wizard-fieldset crm-field--wide"><legend>{t.publicMode}</legend>{([['public_comment', t.publicComment], ['public_reply', t.publicReply]] as Array<[PublicActionType, string]>).map(([mode, label]) => <label key={mode}><input type="radio" name="publicMode" checked={publicAction === mode} onChange={() => { setPublicAction(mode); setDrafts({}); }} />{label}</label>)}<small>{t.publicReplyHint} {language === "zh-Hant" ? "跟進與培育請從已確認任務的證據卡片發起。" : "跟进与培育请从已确认任务的证据卡片发起。"}</small></fieldset>
            {publicAction === "public_comment" && <fieldset className="crm-wizard-fieldset crm-field--wide crm-strategy-cards"><legend>{t.publicStrategy}</legend>{([['question_hook', t.questionStrategy, t.questionStrategyHint], ['offer_hook', t.offerStrategy, t.offerStrategyHint], ['group_invite', t.groupStrategy, t.groupStrategyHint]] as Array<[ReplyStrategy, string, string]>).map(([strategy, label, hint]) => <label className={replyStrategy === strategy ? "is-active" : ""} key={strategy}><input type="radio" name="replyStrategy" checked={replyStrategy === strategy} onChange={() => { setReplyStrategy(strategy); setDrafts({}); }} /><span><strong>{label}</strong><small>{hint}</small></span></label>)}</fieldset>}
          </>}
          {view === "groups" && <fieldset className="crm-wizard-fieldset crm-platform-fieldset crm-field--wide"><legend>{t.groupMode}</legend><button className={groupMode === "threads" ? "is-active" : ""} type="button" data-account-platform="threads" onClick={() => setGroupMode("threads")}><PlatformLogo platform="threads" /><strong>{t.threadsPost}</strong></button><button className={groupMode === "instagram" ? "is-active" : ""} type="button" data-account-platform="instagram" disabled={capabilities?.instagram_group_management?.enabled !== true} onClick={() => setGroupMode("instagram")}><PlatformLogo platform="instagram" /><strong>{t.instagramDirect}</strong></button></fieldset>}
          <label className="crm-field crm-field--wide"><span>{t.template}</span><SelectMenu value={templateId} onChange={selectTemplate} placeholder={t.chooseTemplate} options={[{ value: "", label: t.chooseTemplate }, ...templates.map((row) => ({ value: rowId(row), label: String(row.name || rowId(row)) }))]} /></label>
          <label className="crm-field crm-field--wide"><span>{t.content}</span><textarea rows={8} value={content} onChange={(event) => setContent(event.target.value)} placeholder={t.contentPlaceholder} /></label>
          {view === "outreach" && <p className="crm-wizard-note crm-field--wide">{language === "zh-Hant" ? "首次信任私訊不附追蹤連結或媒體；取得客戶同意後，再從安全追蹤設定使用後續地址。" : "首次信任私信不附追踪链接或媒体；取得客户同意后，再从安全追踪设置使用后续地址。"}</p>}
          {view === "public" && publicAction === "public_comment" && <section className="crm-field--wide crm-wizard-drafts"><div><button className="crm-secondary-button" type="button" disabled={busy === "drafts"} onClick={() => void preparePublicDrafts()}>{busy === "drafts" ? t.aiDrafting : t.aiDrafts}</button><small>{t.aiDraftHint}</small></div>{selectedMembers.filter((row) => drafts[memberId(row)]).map((row) => <label className="crm-field" key={memberId(row)}><span>{t.draftFor} · @{memberUsername(row) || memberId(row)}</span><textarea rows={4} value={drafts[memberId(row)] || ""} onChange={(event) => setDrafts((current) => ({ ...current, [memberId(row)]: event.target.value }))} /></label>)}</section>}
        </div>}
        {view !== "collect" && ((view === "relationships" && step === 2) || (view !== "relationships" && step === 3)) && <div className="crm-form-grid"><label className="crm-field crm-field--wide"><span>{t.account}</span><SelectMenu value={accountId} onChange={setAccountId} placeholder={t.chooseAccount} options={[{ value: "", label: t.chooseAccount }, ...supportedAccounts.map((account) => ({ value: String(account.id), label: `${account.display_name || account.username} · ${account.platform}${!accountReady(account) ? ` · ${t.accountLogin}` : ""}`, disabled: !accountReady(account) }))]} /></label>{view !== "relationships" && <fieldset className="crm-wizard-fieldset crm-field--wide"><legend>{t.execution}</legend>{(["sample", "batch", "schedule"] as const).map((mode) => <label key={mode}><input type="radio" name="execution" checked={execution === mode} onChange={() => setExecution(mode)} /><span><strong>{t[mode]}</strong><small>{t[`${mode}Hint` as "sampleHint" | "batchHint" | "scheduleHint"]}</small></span></label>)}</fieldset>}{view !== "relationships" && execution === "schedule" && <label className="crm-field crm-field--wide"><span>{t.scheduleAt}</span><input type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} /></label>}</div>}
        {((view === "relationships" && step === 3) || (view !== "collect" && view !== "relationships" && step === 4)) && <section className="crm-confirmation-summary crm-wizard-confirmation">
          <h3>{t.confirmation}</h3>
          <dl><div><dt>{t.action}</dt><dd>{view === "public" ? messages.operationLabels[publicAction] : messages.views[view][0]}</dd></div><div><dt>{t.account}</dt><dd>{selectedAccount?.display_name || selectedAccount?.username || messages.notSelected}</dd></div><div><dt>{t.targetRange}</dt><dd>{t.selected(effectiveRecipients.length)}</dd></div>{view !== "relationships" && <div><dt>{t.execution}</dt><dd>{t[execution]}{execution === "schedule" ? ` · ${new Date(scheduleAt).toLocaleString(language)}` : ""}</dd></div>}{content.trim() && <div><dt>{t.content}</dt><dd>{content.trim()}</dd></div>}{templateId && <div><dt>{t.template}</dt><dd>{String(templates.find((row) => rowId(row) === templateId)?.name || templateId)} · {arrayOf(templates.find((row) => rowId(row) === templateId)?.media_ids).length} {language === "zh-Hant" ? "個附件" : "个附件"}</dd></div>}<div><dt>{t.billing}</dt><dd>{isWrite ? t.billingWrite : t.billingRead}</dd></div></dl>
          {isWrite && !preflightResult && <p className="crm-wizard-note">{t.preflightHint}</p>}
          {isWrite && preflightResult && <div className="crm-preflight-review" role="status">
            <header><span><Icon name="check" /><strong>{t.preflightTitle}</strong></span><small>{t.preflightHint}</small></header>
            <dl>
              <div><dt>{t.totalTargets}</dt><dd>{preflightResult.total_count ?? actionRows().length}</dd></div>
              <div><dt>{t.allowedTargets}</dt><dd>{preflightResult.allowed_count ?? preflightResult.actions?.length ?? 0}</dd></div>
              <div><dt>{t.duplicateTargets}</dt><dd>{preflightResult.duplicate_count ?? 0}</dd></div>
              <div><dt>{t.blockedTargets}</dt><dd>{preflightResult.blocked_count ?? 0}</dd></div>
              <div><dt>{t.estimatedPoints}</dt><dd>{preflightResult.quote?.total_points ?? t.noCharge}</dd></div>
              <div><dt>{t.expiresAt}</dt><dd>{preflightResult.expires_at ? new Date(Number(preflightResult.expires_at) * 1000).toLocaleString(language) : "—"}</dd></div>
            </dl>
            {preflightResult.decisions?.some((decision) => !decision.allowed) && <details><summary>{t.skippedTargets}</summary><ul>{preflightResult.decisions.filter((decision) => !decision.allowed).map((decision, index) => <li key={`${decision.index ?? index}:${decision.target_key || index}`}><span>{decision.target_key || `#${index + 1}`}</span><code>{decision.reason_code || "crm_action_blocked"}</code></li>)}</ul></details>}
          </div>}
          {isWrite && preflightResult && <label className="crm-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>{t.consent}</span></label>}
        </section>}
      </div>
      {error && <div className="crm-inline-error" role="alert"><Icon name="warning" />{error}</div>}
    </ConsoleModal>;
}
