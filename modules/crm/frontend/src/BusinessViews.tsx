import { useCallback, useEffect, useMemo, useState } from "react";
import { CrmApiError, crmApi, payloadItems } from "./api";
import { Icon } from "./icons";
import { PlatformChip, PlatformLogo, normalizePlatform, platformLabel } from "./platform";
import { cronFriendly, groupEventMix, humanText, isEnglishMachineLabel, isOpaqueUserValue, isTechnicalId, isTechnicalKey, metricLabel, mixFromValues, mixParts, mixTone, poolInsightCards, readableTags, workflowLabel, type MixPart } from "./present";
import { ConsoleModal, requestConfirm } from "./confirm-dialog";
import { SelectMenu } from "./select-menu";
import type { Language } from "./types";

type Row = Record<string, unknown>;
type PageState = "loading" | "ready" | "error";

const labels = {
  "zh-Hans": {
    pools: "客户池", poolHint: "查看分组快照和池内客户，成员来自服务端客户池关联表。", poolDetails: "客户池详情", members: "池内客户",
    groups: "拉群邀请", groupHint: "创建 Threads 邀请帖或 Instagram Direct 群聊，并在同一工作台检查状态、发帖、改名和补充成员。", newGroup: "创建拉群任务", noGroups: "尚无已验证群组", groupMembers: "群成员", inspectStatus: "检查群组状态", inspectMembers: "检查群成员", groupPost: "群内发帖", renameGroup: "修改群名", addMembers: "补充成员", manageGroup: "管理 Instagram 群组", conversationUrl: "Direct 会话", memberUsernames: "成员账号（最多 3 个，逗号分隔）", groupMessage: "群内消息", prepareAction: "检查目标与计费", confirmAction: "确认并执行", actionPrepared: "检查完成，请确认目标、跳过原因和预计扣点。", readQueued: "检查任务已进入队列", writeQueued: "群组任务已进入队列", instagramUnavailable: "当前环境暂不支持 Instagram 群组管理。",
    noPools: "尚无客户池", choosePool: "选择客户池", choosePoolHint: "选择一个客户池查看成员", noMembers: "该客户池尚无成员", noPlatformMembers: "该平台暂无客户", member: "客户", platform: "平台", platformFilter: "平台", stage: "阶段", score: "评分", source: "来源", tags: "标签", handle: "账号", viewMember: "查看", memberDetail: "客户资料", detailIdentity: "基本信息", detailProfile: "客户概况", detailInsights: "客户洞察", detailSources: "来源", mixStages: "跟进阶段", customerCount: "位客户", editPool: "编辑客户池", poolName: "客户池名称", poolTags: "标签（逗号或换行分隔，最多 50 个）", savePool: "保存", poolSaved: "客户池已保存", deduplicate: "去重", deduplicated: "已完成成员去重", removed: "移除重复", opcHistory: "OPC 历史客户", opcHint: "先预览筛选结果，再导入为新的客户池。", searchHistory: "搜索账号、内容或关键词", keywords: "关键词（逗号分隔）", allPlatforms: "全部平台", allContacts: "全部状态", newContact: "全新名单", contacted: "已触达", failed: "失败重试", preview: "预览匹配客户", previewing: "正在查询…", matched: "匹配客户", excludeExisting: "排除已在客户池中的账号", excludeInteracted: "排除已有互动记录", importPool: "导入为客户池", importing: "正在导入…", imported: "历史客户已导入", opcEmpty: "没有匹配的历史客户",
    templates: "触达模板", templateHint: "管理公开互动、私信和拉群任务可复用的文字与媒体。", newTemplate: "新建模板", name: "模板名称", type: "使用场景", locale: "内容语言", content: "模板内容", defaultTemplate: "设为默认模板", media: "图片附件", upload: "上传图片", uploading: "正在上传…", save: "保存模板", saving: "正在保存…", edit: "编辑", delete: "删除", deleteConfirm: "确认删除这条模板？历史任务和审计记录不会删除。", deleted: "模板已删除", noTemplates: "尚无触达模板", saved: "模板已保存", uploaded: "图片已上传",
    destinations: "客户资料链接", destinationHint: "管理客户明确同意后可发送的官网、预约页或活动页；首次私信不会附加链接。", newDestination: "新增资料链接", destinationUrl: "HTTPS 链接", noDestinations: "尚无客户资料链接",
    schedules: "任务排程", scheduleHint: "集中管理定时采集和触达任务；立即运行前会重新检查目标与计费。", newSchedule: "新建排程", workflowType: "任务类型", cron: "执行周期", timezone: "时区", enabled: "已启用", disabled: "已停用", nextRun: "下次运行", lastRun: "上次运行", createSchedule: "创建排程", runNow: "立即运行", running: "正在提交…", enable: "启用", disable: "停用", noSchedules: "尚无任务排程", taskCreated: "任务已创建", stop: "停止后续运行", preflight: "运行前检查", confirmRun: "确认并立即运行", preflightHint: "确认可执行目标、跳过原因和预计扣点后再运行。", allowed: "可执行", skipped: "已跳过", points: "预计扣点", scheduleMissingActions: "该排程缺少完整任务快照，请重新创建。",
    analytics: "任务与转化数据", analyticsHint: "数据来自实际任务和平台确认结果，不使用模拟进度。", workflowStatuses: "任务进度", eventTypes: "互动记录", actionStates: "平台执行结果", confirmedActions: "已完成操作", funnel: "互动转化", totalWorkflows: "任务总数", totalEvents: "互动记录", totalConfirmed: "已完成平台操作", noAnalytics: "尚无可分析的数据",
    collectModes: "采集方式", collectPersona: "依需求定向采集", collectPersonaHint: "输入用户画像、产品或营销方案", collectHotspot: "热点推文全域采集", collectHotspotHint: "抓取热门贴文的按赞与留言用户", collectLink: "账号／贴文链接采集", collectLinkHint: "依指定链接精准采集互动或粉丝",
    refresh: "刷新", retry: "重试", loading: "正在读取…", loadMore: "加载更多", close: "关闭", cancel: "取消", ok: "确定", confirmTitle: "确认操作", required: "请填写必填字段", requestFailed: "请求失败", selectFile: "选择 JPG、PNG、WebP 或 GIF，最大容量由服务端验证。", active: "有效", unknown: "未知", status: "状态",
  },
  "zh-Hant": {
    pools: "客戶池", poolHint: "查看分組快照和池內客戶，成員來自服務端客戶池關聯表。", poolDetails: "客戶池詳情", members: "池內客戶",
    groups: "拉群邀請", groupHint: "建立 Threads 邀請貼文或 Instagram Direct 群聊，並在同一工作台檢查狀態、發文、改名和補充成員。", newGroup: "建立拉群任務", noGroups: "尚無已驗證群組", groupMembers: "群成員", inspectStatus: "檢查群組狀態", inspectMembers: "檢查群成員", groupPost: "群內發文", renameGroup: "修改群名", addMembers: "補充成員", manageGroup: "管理 Instagram 群組", conversationUrl: "Direct 會話", memberUsernames: "成員帳號（最多 3 個，逗號分隔）", groupMessage: "群內訊息", prepareAction: "檢查目標與計費", confirmAction: "確認並執行", actionPrepared: "檢查完成，請確認目標、略過原因和預計扣點。", readQueued: "檢查任務已進入佇列", writeQueued: "群組任務已進入佇列", instagramUnavailable: "目前環境暫不支援 Instagram 群組管理。",
    noPools: "尚無客戶池", choosePool: "選擇客戶池", choosePoolHint: "選擇一個客戶池查看成員", noMembers: "該客戶池尚無成員", noPlatformMembers: "該平台暫無客戶", member: "客戶", platform: "平台", platformFilter: "平台", stage: "階段", score: "評分", source: "來源", tags: "標籤", handle: "帳號", viewMember: "查看", memberDetail: "客戶資料", detailIdentity: "基本資訊", detailProfile: "客戶概況", detailInsights: "客戶洞察", detailSources: "來源", mixStages: "跟進階段", customerCount: "位客戶", editPool: "編輯客戶池", poolName: "客戶池名稱", poolTags: "標籤（逗號或換行分隔，最多 50 個）", savePool: "儲存", poolSaved: "客戶池已儲存", deduplicate: "去重", deduplicated: "已完成成員去重", removed: "移除重複", opcHistory: "OPC 歷史客戶", opcHint: "先預覽篩選結果，再匯入為新的客戶池。", searchHistory: "搜尋帳號、內容或關鍵詞", keywords: "關鍵詞（逗號分隔）", allPlatforms: "全部平台", allContacts: "全部狀態", newContact: "全新名單", contacted: "已觸達", failed: "失敗重試", preview: "預覽匹配客戶", previewing: "正在查詢…", matched: "匹配客戶", excludeExisting: "排除已在客戶池中的帳號", excludeInteracted: "排除已有互動記錄", importPool: "匯入為客戶池", importing: "正在匯入…", imported: "歷史客戶已匯入", opcEmpty: "沒有匹配的歷史客戶",
    templates: "觸達範本", templateHint: "管理公開互動、私訊和拉群任務可重用的文字與媒體。", newTemplate: "新增範本", name: "範本名稱", type: "使用場景", locale: "內容語言", content: "範本內容", defaultTemplate: "設為預設範本", media: "圖片附件", upload: "上傳圖片", uploading: "正在上傳…", save: "儲存範本", saving: "正在儲存…", edit: "編輯", delete: "刪除", deleteConfirm: "確認刪除這個範本？歷史任務和稽核記錄不會刪除。", deleted: "範本已刪除", noTemplates: "尚無觸達範本", saved: "範本已儲存", uploaded: "圖片已上傳",
    destinations: "客戶資料連結", destinationHint: "管理客戶明確同意後可發送的官網、預約頁或活動頁；首次私訊不會附加連結。", newDestination: "新增資料連結", destinationUrl: "HTTPS 連結", noDestinations: "尚無客戶資料連結",
    schedules: "任務排程", scheduleHint: "集中管理定時採集和觸達任務；立即執行前會重新檢查目標與計費。", newSchedule: "新增排程", workflowType: "任務類型", cron: "執行週期", timezone: "時區", enabled: "已啟用", disabled: "已停用", nextRun: "下次執行", lastRun: "上次執行", createSchedule: "建立排程", runNow: "立即執行", running: "正在提交…", enable: "啟用", disable: "停用", noSchedules: "尚無任務排程", taskCreated: "任務已建立", stop: "停止後續執行", preflight: "執行前檢查", confirmRun: "確認並立即執行", preflightHint: "確認可執行目標、略過原因和預計扣點後再執行。", allowed: "可執行", skipped: "已略過", points: "預計扣點", scheduleMissingActions: "該排程缺少完整任務快照，請重新建立。",
    analytics: "任務與轉化資料", analyticsHint: "資料來自實際任務和平台確認結果，不使用模擬進度。", workflowStatuses: "任務進度", eventTypes: "互動記錄", actionStates: "平台執行結果", confirmedActions: "已完成操作", funnel: "互動轉化", totalWorkflows: "任務總數", totalEvents: "互動記錄", totalConfirmed: "已完成平台操作", noAnalytics: "尚無可分析的資料",
    collectModes: "採集方式", collectPersona: "依需求定向採集", collectPersonaHint: "輸入用戶畫像、產品或行銷方案", collectHotspot: "熱點推文全域採集", collectHotspotHint: "抓取熱門貼文的按讚與留言用戶", collectLink: "帳號／貼文連結採集", collectLinkHint: "依指定連結精準採集互動或粉絲",
    refresh: "重新整理", retry: "重試", loading: "正在讀取…", loadMore: "載入更多", close: "關閉", cancel: "取消", ok: "確定", confirmTitle: "確認操作", required: "請填寫必填欄位", requestFailed: "請求失敗", selectFile: "選擇 JPG、PNG、WebP 或 GIF，最大容量由服務端驗證。", active: "有效", unknown: "未知", status: "狀態",
  },
} as const;

function errorText(error: unknown, language: Language) {
  if (error instanceof CrmApiError) {
    const message = String(error.body.message || "").trim();
    if (message && !/^crm\./i.test(message) && !isTechnicalId(message)) return message;
    return labels[language].requestFailed;
  }
  return error instanceof Error && error.message && !/^crm\./i.test(error.message) ? error.message : labels[language].requestFailed;
}

function idOf(row: Row) { return String(row.id || row.pool_id || row.task_id || ""); }
function textOf(value: unknown, fallback = "—") { return humanText(value, fallback); }
export function MixBar({ title, parts }: { title?: string; parts: MixPart[] }) {
  if (!parts.length) return null;
  return <div className="crm-mix">
    {title ? <strong className="crm-mix-title">{title}</strong> : null}
    <div className="crm-mix-bar" aria-hidden="true">{parts.map((part) => <i key={part.key} data-tone={mixTone(part.key)} style={{ flexGrow: Math.max(part.count, 1) }} />)}</div>
    <div className="crm-mix-legend">{parts.map((part) => <span key={part.key}><i data-tone={mixTone(part.key)} />{part.label} {part.count}</span>)}</div>
  </div>;
}
function arrayOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
  return [];
}
function objectOf(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  if (typeof value === "string") { try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
  return {};
}
function dateText(value: unknown, language: Language) {
  if (!value) return "—";
  const raw = Number(value);
  const date = Number.isFinite(raw) ? new Date(raw < 1e12 ? raw * 1000 : raw) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? textOf(value) : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function memberLead(member: Row) {
  return objectOf(member.lead || member.profile);
}

function memberHandle(member: Row) {
  const lead = memberLead(member);
  return textOf(member.username || lead.username, "").replace(/^@/, "");
}

function memberTitle(member: Row, fallback: string) {
  const lead = memberLead(member);
  const handle = memberHandle(member);
  const name = textOf(member.display_name || lead.display_name || member.username || lead.username, fallback);
  return handle || name;
}

function memberTagEntries(member: Row): Array<[string, string]> {
  const lead = memberLead(member);
  const rows: Array<[string, string]> = [];
  for (const tag of readableTags(arrayOf(member.tags ?? lead.tags ?? member.tags_json ?? lead.tags_json))) {
    const parts = tag.split(/[:：]/);
    const key = parts[0].trim();
    const value = parts.slice(1).join("：").trim();
    if (key && value) rows.push([key, value]);
    else if (tag) rows.push(["", tag]);
  }
  return rows;
}

function memberTimeLabel(member: Row): string {
  const dates = memberTagEntries(member).filter(([key]) => /^(日期|时间|時間)$/.test(key)).map(([, value]) => value);
  return dates.find((value) => /\d{4}-\d{2}-\d{2}/.test(value)) || dates[0] || "";
}

function memberPreview(member: Row, language: Language): { chips: string[]; portrait: string } {
  const lead = memberLead(member);
  const entries = memberTagEntries(member);
  const chips: string[] = [];
  const stage = String(member.stage || lead.stage || member.status || "");
  if (stage) chips.push(metricLabel(stage, language));
  const intent = entries.find(([key]) => key === "意向")?.[1];
  if (intent) chips.push(`意向 ${intent}`);
  const time = memberTimeLabel(member);
  if (time) chips.push(time);
  const portrait = entries.find(([key]) => /^(画像|畫像)$/.test(key))?.[1] || "";
  return { chips, portrait };
}

function memberFieldKind(label: string): "identity" | "profile" | "insight" | "source" {
  if (/^(账号|帳號|客户|客戶|平台|阶段|階段)$/.test(label)) return "identity";
  if (/^(画像|畫像|需求|痛点|痛點)$/.test(label)) return "insight";
  if (/^(来源|來源)$/.test(label)) return "source";
  return "profile";
}

function sortMemberFields(rows: Array<[string, string]>, order: string[]) {
  return [...rows].sort((left, right) => {
    const leftIndex = order.indexOf(left[0]);
    const rightIndex = order.indexOf(right[0]);
    return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
  });
}

function localizeMemberKey(key: string, language: Language) {
  const hant = language === "zh-Hant";
  const table: Record<string, [string, string]> = {
    画像: ["画像", "畫像"], 畫像: ["画像", "畫像"],
    需求: ["需求", "需求"],
    痛点: ["痛点", "痛點"], 痛點: ["痛点", "痛點"],
    来源: ["来源", "來源"], 來源: ["来源", "來源"],
    关键词: ["关键词", "關鍵詞"], 關鍵詞: ["关键词", "關鍵詞"], 關鍵字: ["关键词", "關鍵詞"],
    分类: ["分类", "分類"], 分類: ["分类", "分類"],
    意向: ["意向", "意向"],
    日期: ["日期", "日期"],
    时间: ["时间", "時間"], 時間: ["时间", "時間"],
    行为: ["行为", "行為"], 行為: ["行为", "行為"],
    账号: ["账号", "帳號"], 帳號: ["账号", "帳號"],
    平台: ["平台", "平台"],
    阶段: ["阶段", "階段"], 階段: ["阶段", "階段"],
    评分: ["评分", "評分"], 評分: ["评分", "評分"],
    客户: ["客户", "客戶"], 客戶: ["客户", "客戶"],
  };
  const pair = table[key];
  return pair ? (hant ? pair[1] : pair[0]) : key;
}

function isInternalTagKey(key: string) {
  return /^(渠道|采集|採集|批次|验证|驗證|筛选|篩選|人设|人設)$/.test(key);
}

function memberDetailGroups(member: Row, t: { member: string; handle: string; platform: string; stage: string; score: string; source: string; tags: string }, language: Language): { identity: Array<[string, string]>; profile: Array<[string, string]>; insights: Array<[string, string]>; sources: string[] } {
  const lead = memberLead(member);
  const handle = memberHandle(member);
  const name = textOf(member.display_name || lead.display_name, "");
  const stage = String(member.stage || lead.stage || member.status || "");
  const scoreRaw = member.score ?? lead.score ?? member.priority ?? lead.priority;
  const scoreNum = Number(scoreRaw);
  const score = Number.isFinite(scoreNum) && scoreNum === 0 ? "" : textOf(scoreRaw, "");
  const buckets = {
    identity: [] as Array<[string, string]>,
    profile: [] as Array<[string, string]>,
    insights: [] as Array<[string, string]>,
    sources: [] as string[],
  };
  const seen = new Set<string>();
  const dateLabels = /^(日期|时间|時間)$/;
  const push = (rawLabel: string, rawValue: string) => {
    const label = localizeMemberKey(rawLabel, language);
    const value = String(rawValue || "").trim();
    if (!label || !value || value === "—" || isInternalTagKey(rawLabel) || isOpaqueUserValue(value) || isEnglishMachineLabel(label) || isEnglishMachineLabel(value)) return;
    const kind = memberFieldKind(label);
    if (dateLabels.test(label)) {
      const existing = buckets.profile.findIndex(([key]) => dateLabels.test(key));
      if (existing >= 0) {
        const current = buckets.profile[existing][1];
        if (/\d{4}-\d{2}-\d{2}/.test(current) || !/\d{4}-\d{2}-\d{2}/.test(value)) return;
        buckets.profile[existing] = [label, value];
        return;
      }
    }
    const fingerprint = `${label}:${value}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    if (kind === "source") buckets.sources.push(value);
    else if (kind === "identity") buckets.identity.push([label, value]);
    else if (kind === "insight") buckets.insights.push([label, value]);
    else buckets.profile.push([label, value]);
  };
  if (name && name !== handle) push(t.member, name);
  push(t.handle, handle ? `@${handle}` : "");
  push(t.platform, platformLabel(member.platform || lead.platform));
  if (stage) push(t.stage, metricLabel(stage, language));
  if (score) push(t.score, score);
  const shown = new Set(["username", "display_name", "platform", "stage", "status", "score", "priority", "source", "origin", "tags", "tags_json", "lead", "profile"]);
  for (const [key, value] of memberTagEntries(member)) {
    push(key || t.tags, value);
  }
  for (const [key, value] of Object.entries({ ...lead, ...member })) {
    if (shown.has(key) || isTechnicalKey(key) || /^(active|enabled|ok|status)$/i.test(key)) continue;
    if (value && typeof value === "object") continue;
    const text = textOf(value, "");
    if (!text) continue;
    push(metricLabel(key, language), text);
    shown.add(key);
  }
  return {
    identity: sortMemberFields(buckets.identity, language === "zh-Hant" ? ["客戶", "帳號", "平台", "階段"] : ["客户", "账号", "平台", "阶段"]),
    profile: sortMemberFields(buckets.profile, language === "zh-Hant" ? ["日期", "時間", "意向", "行為", "關鍵詞", "分類", "評分"] : ["日期", "时间", "意向", "行为", "关键词", "分类", "评分"]),
    insights: sortMemberFields(buckets.insights, language === "zh-Hant" ? ["畫像", "需求", "痛點"] : ["画像", "需求", "痛点"]),
    sources: buckets.sources,
  };
}

function PageHeader({ title, hint, language, onRefresh, action }: { title: string; hint: string; language?: Language; onRefresh: () => void; action?: React.ReactNode }) {
  const resolvedLanguage = language || (document.documentElement.lang === "zh-Hant" ? "zh-Hant" : "zh-Hans");
  return <div className="crm-panel-head crm-business-head"><div><span className="crm-kicker">CRM</span><div className="crm-panel-title-row"><h2>{title}</h2><button className="unified-action-icon-button" type="button" aria-label={labels[resolvedLanguage].refresh} title={labels[resolvedLanguage].refresh} onClick={onRefresh}><Icon name="refresh" className="ui-action-icon" /></button></div><p>{hint}</p></div>{action ? <div className="crm-business-actions">{action}</div> : null}</div>;
}

function Loading({ language }: { language: Language }) { return <div className="crm-list-skeleton" aria-live="polite"><span>{labels[language].loading}</span><i /><i /><i /></div>; }
function ErrorBox({ error, language, retry }: { error: string; language: Language; retry: () => void }) { return <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{error}</span><button type="button" onClick={retry}><Icon name="refresh" />{labels[language].retry}</button></div>; }

export function PoolsView({ language, onEngage, onCollectMode }: { language: Language; onEngage?: () => void; onCollectMode?: (mode: "persona" | "hotspot" | "link") => void }) {
  const t = labels[language];
  const [state, setState] = useState<PageState>("loading");
  const [pools, setPools] = useState<Row[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Row | null>(null);
  const [members, setMembers] = useState<Row[]>([]);
  const [memberCursor, setMemberCursor] = useState("");
  const [detailState, setDetailState] = useState<PageState>("ready");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [poolDraft, setPoolDraft] = useState({ name: "", tags: "" });
  const [opcOpen, setOpcOpen] = useState(false);
  const [opcFilter, setOpcFilter] = useState({ search: "", keywords: "", platform: "", contact: "", category: "OPC 历史客户池", excludeExisting: true, excludeInteracted: true });
  const [opcRows, setOpcRows] = useState<Row[]>([]);
  const [opcTotal, setOpcTotal] = useState<number | null>(null);
  const [inspecting, setInspecting] = useState<Row | null>(null);
  const [platformFilter, setPlatformFilter] = useState<"threads" | "instagram">("threads");
  const [poolOpen, setPoolOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const loadPools = useCallback(async () => {
    setState("loading"); setError("");
    try {
      const payload = await crmApi.list("pools", "", 200);
      const rows = payloadItems(payload);
      setPools(rows); setState("ready");
      setSelectedId((current) => current || idOf(rows[0] || {}));
    } catch (next) { setError(errorText(next, language)); setState("error"); }
  }, [language]);

  const loadPool = useCallback(async (poolId: string, cursor = "") => {
    if (!poolId) { setDetail(null); setMembers([]); return; }
    setDetailState("loading"); setError("");
    try {
      const [pool, memberPayload] = await Promise.all([crmApi.resource("pools", poolId), crmApi.poolMembers(poolId, cursor)]);
      const nextMembers = payloadItems(memberPayload);
      setDetail(pool); setMembers((current) => cursor ? [...current, ...nextMembers] : nextMembers);
      if (!cursor) setPoolDraft({ name: textOf(pool.name, ""), tags: arrayOf(pool.tags ?? pool.tags_json).map(String).join(", ") });
      setMemberCursor(String(memberPayload.next_cursor || "")); setDetailState("ready");
    } catch (next) { setError(errorText(next, language)); setDetailState("error"); }
  }, [language]);

  useEffect(() => { void loadPools(); }, [loadPools]);
  useEffect(() => { void loadPool(selectedId); }, [loadPool, selectedId]);
  useEffect(() => {
    if (!opcOpen) return;
    let cancelled = false;
    setBusy("opc-preview");
    setError("");
    const payload = {
      search: opcFilter.search.trim(),
      keywords: [...new Set(opcFilter.keywords.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean))],
      platform: opcFilter.platform,
      contact: opcFilter.contact,
      limit: 30,
      excludeExisting: opcFilter.excludeExisting,
      excludeInteracted: opcFilter.excludeInteracted,
      category: opcFilter.category.trim(),
      locale: language,
    };
    void crmApi.queryOpcHistory(payload).then((result) => {
      if (cancelled) return;
      const rows = arrayOf(result.data ?? result.items).filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item)));
      const total = Number(result.total);
      setOpcRows(rows);
      setOpcTotal(Number.isFinite(total) ? total : rows.length);
    }).catch((next) => {
      if (cancelled) return;
      setError(errorText(next, language));
      setOpcTotal(null);
    }).finally(() => {
      if (!cancelled) setBusy("");
    });
    return () => { cancelled = true; };
  }, [opcOpen]);
  const snapshot = objectOf(detail?.snapshot ?? detail?.snapshot_json);
  const tags = readableTags(arrayOf(detail?.tags ?? detail?.tags_json));
  const insights = detail ? poolInsightCards(detail, snapshot, members, tags, language) : [];
  const stageMix = mixFromValues(members.map((member) => member.stage || objectOf(member.lead || member.profile).stage || member.status), language);
  const visibleMembers = members.filter((member) => normalizePlatform(member.platform || memberLead(member).platform) === platformFilter);
  const inspectingDetail = inspecting ? memberDetailGroups(inspecting, t, language) : null;
  const splitValues = (value: string) => [...new Set(value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean))];
  const savePool = async () => {
    if (!selectedId || poolDraft.name.trim().length < 2) { setError(t.required); return; }
    setBusy("save-pool"); setError("");
    try { await crmApi.updateResource("pools", selectedId, { name: poolDraft.name.trim(), tags: splitValues(poolDraft.tags).map((tag) => tag.slice(0, 64)).slice(0, 50) }); setNotice(t.poolSaved); setEditOpen(false); await Promise.all([loadPools(), loadPool(selectedId)]); }
    catch (next) { setError(errorText(next, language)); }
    finally { setBusy(""); }
  };
  const deduplicate = async () => {
    if (!selectedId) return; setBusy("deduplicate"); setError("");
    try { const result = await crmApi.deduplicatePoolMembers(selectedId); setNotice(`${t.deduplicated} · ${t.removed} ${Number(result.removed_count || 0)}`); await loadPool(selectedId); }
    catch (next) { setError(errorText(next, language)); }
    finally { setBusy(""); }
  };
  const opcPayload = () => ({ search: opcFilter.search.trim(), keywords: splitValues(opcFilter.keywords), platform: opcFilter.platform, contact: opcFilter.contact, limit: 30, excludeExisting: opcFilter.excludeExisting, excludeInteracted: opcFilter.excludeInteracted, category: opcFilter.category.trim(), locale: language });
  const applyOpcResult = (result: Record<string, unknown>) => {
    const rows = arrayOf(result.data ?? result.items).filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    const total = Number(result.total);
    setOpcRows(rows);
    setOpcTotal(Number.isFinite(total) ? total : rows.length);
  };
  const previewOpc = async () => {
    setBusy("opc-preview"); setError("");
    try { applyOpcResult(await crmApi.queryOpcHistory(opcPayload())); }
    catch (next) { setError(errorText(next, language)); setOpcTotal(null); }
    finally { setBusy(""); }
  };
  const importOpc = async () => {
    if (opcFilter.category.trim().length < 2) { setError(t.required); return; }
    if (opcTotal === 0) { setError(t.opcEmpty); return; }
    setBusy("opc-import"); setError("");
    try {
      const result = await crmApi.importOpcHistory({ ...opcPayload(), idempotencyKey: `crm-opc-import:${window.crypto.randomUUID()}`, tags: splitValues(opcFilter.keywords) });
      const pool = objectOf(result.pool); const importedId = idOf(pool); setNotice(`${t.imported} · ${Number(result.importedCount || pool.leadCount || 0)}`); setOpcOpen(false); setOpcRows([]); setOpcTotal(null); await loadPools(); if (importedId) setSelectedId(importedId);
    } catch (next) {
      const empty = next instanceof CrmApiError && (next.status === 409 || /opc_history_empty|opcHistoryEmpty/i.test(`${next.body.code || ""} ${next.body.message_key || ""}`));
      setError(empty ? t.opcEmpty : errorText(next, language));
    }
    finally { setBusy(""); }
  };

  const pickPool = (id: string) => {
    setSelectedId(id);
    setPoolOpen(false);
  };

  return <section className="crm-panel crm-business-panel" aria-busy={state === "loading" || detailState === "loading"}>
    <PageHeader title={t.pools} hint={language === "zh-Hant" ? "採集完成的客戶會進入客戶池，再到互動頁繼續留言。" : "采集完成的客户会进入客户池，再到互动页继续留言。"} language={language} onRefresh={loadPools} />
    {onCollectMode && <div className="crm-collect-modes" role="group" aria-label={t.collectModes}>
      {([
        ["persona", t.collectPersona, t.collectPersonaHint, "collect"],
        ["hotspot", t.collectHotspot, t.collectHotspotHint, "signal"],
        ["link", t.collectLink, t.collectLinkHint, "external"],
      ] as const).map(([mode, title, hint, icon]) => (
        <button className="crm-collect-mode" type="button" key={mode} onClick={() => onCollectMode(mode)}>
          <Icon name={icon} /><span><strong>{title}</strong><small>{hint}</small></span>
        </button>
      ))}
    </div>}
    <div className="crm-pool-launch crm-pool-launch--pool">
      <button className="crm-primary-button" type="button" onClick={() => setPoolOpen(true)}>{t.choosePool}</button>
      <button className="crm-primary-button" type="button" onClick={() => setOpcOpen(true)}>{t.opcHistory}</button>
      {onEngage && <button className="crm-secondary-button" type="button" onClick={onEngage}>{language === "zh-Hant" ? "去互動" : "去互动"}</button>}
    </div>
    {error && !opcOpen && !editOpen && <ErrorBox error={error} language={language} retry={loadPools} />}
    {notice && !opcOpen && !editOpen && <div className="crm-success-note" role="status"><Icon name="check" />{notice}</div>}
    {opcOpen && <ConsoleModal title={t.opcHistory} labelledBy="crmOpcHistoryTitle" onClose={() => setOpcOpen(false)} wide actions={<><button type="button" disabled={Boolean(busy)} onClick={() => void previewOpc()}>{busy === "opc-preview" ? t.previewing : t.preview}</button><button type="button" className="primary" disabled={Boolean(busy) || opcFilter.category.trim().length < 2 || opcTotal === 0} onClick={() => void importOpc()}>{busy === "opc-import" ? t.importing : t.importPool}</button></>}>
      <p>{t.opcHint}</p>
      {error && <ErrorBox error={error} language={language} retry={() => void previewOpc()} />}
      {notice && <div className="crm-success-note" role="status"><Icon name="check" />{notice}</div>}
      <div className="crm-opc-history">
        <div className="crm-form-grid">
          <label className="crm-field crm-field--wide"><span>{t.searchHistory}</span><input value={opcFilter.search} autoComplete="off" onChange={(event) => setOpcFilter({ ...opcFilter, search: event.target.value })} /></label>
          <label className="crm-field"><span>{t.keywords}</span><input value={opcFilter.keywords} autoComplete="off" onChange={(event) => setOpcFilter({ ...opcFilter, keywords: event.target.value })} /></label>
          <label className="crm-field"><span>{t.poolName}</span><input value={opcFilter.category} autoComplete="off" maxLength={120} onChange={(event) => setOpcFilter({ ...opcFilter, category: event.target.value })} /></label>
          <label className="crm-field"><span>{t.platform}</span><SelectMenu value={opcFilter.platform} onChange={(platform) => setOpcFilter({ ...opcFilter, platform })} placeholder={t.allPlatforms} options={[{ value: "", label: t.allPlatforms }, { value: "threads", label: "Threads" }, { value: "instagram", label: "Instagram" }]} /></label>
          <label className="crm-field"><span>{t.status}</span><SelectMenu value={opcFilter.contact} onChange={(contact) => setOpcFilter({ ...opcFilter, contact })} placeholder={t.allContacts} options={[{ value: "", label: t.allContacts }, { value: "new", label: t.newContact }, { value: "contacted", label: t.contacted }, { value: "failed", label: t.failed }]} /></label>
          <label className="crm-consent"><input type="checkbox" checked={opcFilter.excludeExisting} onChange={(event) => setOpcFilter({ ...opcFilter, excludeExisting: event.target.checked })} /><span>{t.excludeExisting}</span></label>
          <label className="crm-consent"><input type="checkbox" checked={opcFilter.excludeInteracted} onChange={(event) => setOpcFilter({ ...opcFilter, excludeInteracted: event.target.checked })} /><span>{t.excludeInteracted}</span></label>
        </div>
        {opcTotal !== null && <div className="crm-opc-summary" role="status"><strong>{t.matched} · {opcTotal}</strong><span>{opcTotal > 0 ? opcRows.slice(0, 8).map((row) => `@${textOf(row.username)}`).join(" · ") : t.opcEmpty}</span></div>}
      </div>
    </ConsoleModal>}
    {state === "loading" && <Loading language={language} />}
    {state === "error" && <ErrorBox error={error} language={language} retry={loadPools} />}
    {state === "ready" && !pools.length && <div className="crm-empty"><Icon name="pools" /><strong>{t.noPools}</strong></div>}
    {state === "ready" && selectedId && detailState === "loading" && <Loading language={language} />}
    {state === "ready" && detailState === "error" && <ErrorBox error={error} language={language} retry={() => void loadPool(selectedId)} />}
    {poolOpen && <ConsoleModal title={t.choosePool} labelledBy="crm-pool-window-title" onClose={() => setPoolOpen(false)}>
      <p>{t.choosePoolHint}</p>
      {!pools.length ? <p className="crm-quiet-empty">{t.noPools}</p> : <nav className="crm-pool-list crm-master-list" aria-label={t.pools}>{pools.map((pool) => { const count = Number(pool.lead_count || pool.leadCount || 0); const id = idOf(pool); return <button className={selectedId === id ? "is-active" : ""} type="button" key={id} onClick={() => pickPool(id)}><strong>{textOf(pool.name)}</strong><small>{count > 0 ? `${count} ${t.customerCount}` : textOf(pool.description, t.choosePoolHint)}</small></button>; })}</nav>}
    </ConsoleModal>}
    {state === "ready" && detail && <>
          <header className="crm-detail-heading"><div><span className="crm-kicker">{t.poolDetails}</span><h3>{textOf(detail.name)}</h3><p>{textOf(detail.description, t.choosePoolHint)}</p></div></header>
          <button className="crm-pool-settings" type="button" onClick={() => setEditOpen(true)}>{t.editPool}</button>
          {editOpen && <ConsoleModal title={t.editPool} labelledBy="crm-pool-edit-title" onClose={() => setEditOpen(false)} wide actions={<><button type="button" disabled={Boolean(busy)} onClick={() => void deduplicate()}>{busy === "deduplicate" ? t.loading : t.deduplicate}</button><button type="button" className="primary" disabled={Boolean(busy) || poolDraft.name.trim().length < 2} onClick={() => void savePool()}>{busy === "save-pool" ? t.saving : t.savePool}</button></>}>
            {error && <ErrorBox error={error} language={language} retry={() => void loadPool(selectedId)} />}
            {notice && <div className="crm-success-note" role="status"><Icon name="check" />{notice}</div>}
            <div className="crm-pool-editor">
              <label className="crm-field"><span>{t.poolName}</span><input value={poolDraft.name} autoComplete="off" maxLength={120} onChange={(event) => setPoolDraft({ ...poolDraft, name: event.target.value })} /></label>
              <label className="crm-field crm-field--wide"><span>{t.poolTags}</span><textarea rows={6} value={poolDraft.tags} autoComplete="off" onChange={(event) => setPoolDraft({ ...poolDraft, tags: event.target.value })} /></label>
            </div>
          </ConsoleModal>}
          {insights.length > 0 && <dl className="crm-summary-grid crm-insight-grid">{insights.map((card) => <div key={card.label}><dt>{card.label}</dt><dd>{card.value}</dd></div>)}</dl>}
          {stageMix.length > 0 && <MixBar title={t.mixStages} parts={stageMix} />}
          <h3 className="crm-section-title">{t.members} <span>{members.length}</span></h3>
          <div className="crm-account-platforms" role="tablist" aria-label={t.platformFilter}>
            <button type="button" role="tab" aria-selected={platformFilter === "threads"} className={platformFilter === "threads" ? "is-active" : ""} data-account-platform="threads" onClick={() => setPlatformFilter("threads")}><PlatformLogo platform="threads" /><strong>Threads</strong></button>
            <button type="button" role="tab" aria-selected={platformFilter === "instagram"} className={platformFilter === "instagram" ? "is-active" : ""} data-account-platform="instagram" onClick={() => setPlatformFilter("instagram")}><PlatformLogo platform="instagram" /><strong>Instagram</strong></button>
          </div>
          {!members.length ? <p className="crm-quiet-empty">{t.noMembers}</p> : !visibleMembers.length ? <p className="crm-quiet-empty">{t.noPlatformMembers}</p> : <div className="crm-member-grid">{visibleMembers.map((member, index) => {
            const platform = member.platform || memberLead(member).platform;
            const preview = memberPreview(member, language);
            return <article className="crm-member-card" data-account-platform={normalizePlatform(platform) || undefined} key={String(member.lead_id || member.id || index)}>
              <div className="crm-member-card-head">
                <PlatformLogo platform={platform} />
                <strong>{memberTitle(member, t.member)}</strong>
              </div>
              <div className="crm-member-card-meta">
                {preview.chips.map((chip) => <span className="crm-member-tag" key={chip}>{chip}</span>)}
                {preview.portrait ? <span className="crm-member-portrait">{preview.portrait}</span> : null}
              </div>
              <button className="crm-account-card-action" type="button" onClick={() => setInspecting(member)}>{t.viewMember}</button>
            </article>;
          })}</div>}
          {memberCursor && <div className="crm-pagination"><button className="crm-secondary-button" type="button" onClick={() => void loadPool(selectedId, memberCursor)}>{t.loadMore}</button></div>}
          {inspecting && inspectingDetail && <ConsoleModal title={t.memberDetail} labelledBy="crm-member-detail-title" onClose={() => setInspecting(null)} actions={<button type="button" className="primary" onClick={() => setInspecting(null)}>{t.close}</button>}>
            <div className="crm-member-detail">
              {inspectingDetail.identity.length > 0 && <section className="crm-member-detail-section"><h3>{t.detailIdentity}</h3><dl className="crm-member-detail-dl">{inspectingDetail.identity.map(([label, value]) => <div key={`${label}:${value}`}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>}
              {inspectingDetail.profile.length > 0 && <section className="crm-member-detail-section"><h3>{t.detailProfile}</h3><dl className="crm-member-detail-dl">{inspectingDetail.profile.map(([label, value]) => <div key={`${label}:${value}`}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>}
              {inspectingDetail.insights.length > 0 && <section className="crm-member-detail-section"><h3>{t.detailInsights}</h3><div className="crm-member-detail-blocks">{inspectingDetail.insights.map(([label, value]) => <div className="crm-member-detail-block" key={`${label}:${value}`}><dt>{label}</dt><dd>{value}</dd></div>)}</div></section>}
              {inspectingDetail.sources.length > 0 && <section className="crm-member-detail-section"><h3>{t.detailSources}</h3><div className="crm-member-detail-blocks">{inspectingDetail.sources.map((value) => <div className="crm-member-detail-block" key={value}><dd>{value}</dd></div>)}</div></section>}
            </div>
          </ConsoleModal>}
        </>}
  </section>;
}

type GroupOperation = "instagram_group_post" | "instagram_group_settings_update" | "instagram_group_members_add";

export function GroupsView({ language, instagramEnabled, advisory, onCreate }: { language: Language; instagramEnabled: boolean; advisory?: string; onCreate: () => void }) {
  const t = labels[language];
  const [groups, setGroups] = useState<Row[]>([]);
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [state, setState] = useState<PageState>("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<Row | null>(null);
  const [operation, setOperation] = useState<GroupOperation>("instagram_group_post");
  const [value, setValue] = useState("");
  const [preflight, setPreflight] = useState<Awaited<ReturnType<typeof crmApi.preflight>> | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const load = useCallback(async () => {
    setState("loading"); setError("");
    try {
      const [groupPayload, accountPayload] = await Promise.all([crmApi.list("groups", "", 200), crmApi.list("accounts", "", 100)]);
      setGroups(payloadItems(groupPayload)); setAccounts(payloadItems(accountPayload)); setState("ready");
    } catch (next) { setError(errorText(next, language)); setState("error"); }
  }, [language]);
  useEffect(() => { void load(); }, [load]);
  const instagramAccount = accounts.find((row) => String(row.platform || "").toLowerCase() === "instagram" && String(row.status || "").toLowerCase() === "ready");
  const groupMembers = (row: Row) => arrayOf(row.members ?? row.members_json).map((item) => String(item || "").replace(/^@/, "")).filter(Boolean);
  const groupTarget = (row: Row) => String(row.platform_group_key || row.target_url || "").trim();
  const actionFor = (row: Row, actionType: string, rawValue = "") => {
    const accountId = idOf(instagramAccount || {});
    const expectedUsername = String(instagramAccount?.username || "").replace(/^@/, "");
    const targetUrl = groupTarget(row);
    const members = [...new Set(rawValue.split(/[，,\n]/).map((item) => item.trim().replace(/^@/, "")).filter(Boolean))];
    const payload: Row = { confirmed: true, expected_username: expectedUsername, target_url: targetUrl, group_id: idOf(row) };
    if (actionType === "instagram_group_members_inspect") payload.expected_members = groupMembers(row);
    if (actionType === "instagram_group_members_add") payload.members = members;
    if (actionType === "instagram_group_settings_update") payload.group_name = rawValue.trim();
    if (actionType === "instagram_group_post") payload.message = rawValue.trim();
    if (actionType === "instagram_group_status_inspect") payload.message = "";
    return { action_type: actionType, account_id: accountId, target_key: targetUrl, content: actionType === "instagram_group_post" ? rawValue.trim() : "", payload };
  };
  const queueRead = async (row: Row, actionType: "instagram_group_status_inspect" | "instagram_group_members_inspect") => {
    if (!instagramEnabled || !instagramAccount || !groupTarget(row)) { setError(t.instagramUnavailable); return; }
    if (actionType === "instagram_group_members_inspect" && !groupMembers(row).length) { setError(t.required); return; }
    setBusy(`${actionType}:${idOf(row)}`); setError("");
    try {
      const result = await crmApi.createWorkflow({ workflow_type: "groups", title: `${t.groups} · ${actionType === "instagram_group_members_inspect" ? t.inspectMembers : t.inspectStatus}`, idempotency_key: `crm-group-read:${actionType}:${idOf(row)}:${window.crypto.randomUUID()}`, input: { group_id: idOf(row) }, actions: [actionFor(row, actionType)], confirmed: true });
      setNotice(t.readQueued);
    } catch (next) { setError(errorText(next, language)); }
    finally { setBusy(""); }
  };
  const openManage = (row: Row, nextOperation: GroupOperation) => {
    setEditing(row); setOperation(nextOperation); setValue(nextOperation === "instagram_group_settings_update" ? String(row.name || "") : ""); setPreflight(null); setConfirmed(false); setError("");
  };
  const prepare = async () => {
    if (!editing || !instagramEnabled || !instagramAccount || !groupTarget(editing)) { setError(t.instagramUnavailable); return; }
    const members = value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean);
    if (!value.trim() || (operation === "instagram_group_members_add" && (members.length < 1 || members.length > 3))) { setError(t.required); return; }
    setBusy("preflight"); setError("");
    try { setPreflight(await crmApi.preflight({ workflow_type: "groups", actions: [actionFor(editing, operation, value)] })); setConfirmed(false); setNotice(t.actionPrepared); }
    catch (next) { setError(errorText(next, language)); }
    finally { setBusy(""); }
  };
  const submit = async () => {
    if (!editing || !preflight || !confirmed) return;
    setBusy("submit"); setError("");
    try {
      const actions = preflight.actions?.length ? preflight.actions : [actionFor(editing, operation, value)];
      const result = await crmApi.createWorkflow({ workflow_type: "groups", title: `${t.groups} · ${operation === "instagram_group_post" ? t.groupPost : operation === "instagram_group_settings_update" ? t.renameGroup : t.addMembers}`, idempotency_key: `crm-group-write:${operation}:${idOf(editing)}:${window.crypto.randomUUID()}`, input: { group_id: idOf(editing) }, actions, preflight_token: preflight.preflight_token, confirmed: true });
      setNotice(t.writeQueued); setEditing(null); setPreflight(null); setConfirmed(false);
    } catch (next) { setError(errorText(next, language)); }
    finally { setBusy(""); }
  };
  return <section className="crm-panel crm-business-panel" role="tabpanel" aria-labelledby="crm-tab-groups">
    <PageHeader title={t.groups} hint={t.groupHint} language={language} onRefresh={load} action={<button className="crm-primary-button" type="button" onClick={onCreate}>{t.newGroup}</button>} />
    {advisory && <div className="crm-banner crm-banner--partial" role="status"><Icon name="warning" /><span>{advisory}</span></div>}
    {!instagramEnabled && <div className="crm-banner crm-banner--partial" role="status"><Icon name="warning" /><span>{t.instagramUnavailable}</span></div>}
    {error && <ErrorBox error={error} language={language} retry={load} />}{notice && <div className="crm-success-note" role="status"><Icon name="check" />{notice}</div>}
    {state === "loading" && <Loading language={language} />}{state === "error" && <ErrorBox error={error} language={language} retry={load} />}
    {state === "ready" && !groups.length && <p className="crm-quiet-empty">{t.noGroups}</p>}
    {state === "ready" && groups.length > 0 && <div className="crm-template-grid">{groups.map((row) => { const instagram = String(row.platform || "").toLowerCase() === "instagram"; const id = idOf(row); return <article className="crm-template-card" data-account-platform={String(row.platform || "").toLowerCase()} key={id}><header><div><strong>{textOf(row.name, t.groups)}</strong><small><PlatformChip platform={row.platform} /> · {metricLabel(String(row.status || ""), language)}</small></div><span className="crm-chip">{t.groupMembers}: {groupMembers(row).length}</span></header><p>{groupTarget(row) || "—"}</p>{groupMembers(row).length > 0 && <div className="crm-chip-row">{groupMembers(row).slice(0, 8).map((member) => <span key={member}>@{member}</span>)}</div>}<footer className="crm-inline-actions"><button type="button" disabled={!instagram || !instagramEnabled || Boolean(busy)} onClick={() => void queueRead(row, "instagram_group_status_inspect")}>{t.inspectStatus}</button><button type="button" disabled={!instagram || !instagramEnabled || !groupMembers(row).length || Boolean(busy)} onClick={() => void queueRead(row, "instagram_group_members_inspect")}>{t.inspectMembers}</button><button type="button" disabled={!instagram || !instagramEnabled} onClick={() => openManage(row, "instagram_group_post")}>{t.groupPost}</button><button type="button" disabled={!instagram || !instagramEnabled} onClick={() => openManage(row, "instagram_group_settings_update")}>{t.renameGroup}</button><button type="button" disabled={!instagram || !instagramEnabled} onClick={() => openManage(row, "instagram_group_members_add")}>{t.addMembers}</button></footer></article>; })}</div>}
    {editing && <ConsoleModal title={t.manageGroup} labelledBy="crm-group-editor" onClose={() => setEditing(null)} actions={<><button type="button" onClick={() => setEditing(null)}>{t.cancel}</button><button type="button" className="primary" disabled={Boolean(busy) || (preflight ? !confirmed : !value.trim())} onClick={() => void (preflight ? submit() : prepare())}>{preflight ? t.confirmAction : t.prepareAction}</button></>}>
      <dl className="crm-summary-grid"><div><dt>{t.name}</dt><dd>{textOf(editing.name)}</dd></div><div><dt>{t.conversationUrl}</dt><dd>{groupTarget(editing)}</dd></div></dl>
      <label className="crm-field"><span>{operation === "instagram_group_members_add" ? t.memberUsernames : operation === "instagram_group_settings_update" ? t.renameGroup : t.groupMessage}</span>{operation === "instagram_group_post" ? <textarea rows={5} value={value} onChange={(event) => { setValue(event.target.value); setPreflight(null); setConfirmed(false); }} /> : <input value={value} onChange={(event) => { setValue(event.target.value); setPreflight(null); setConfirmed(false); }} />}</label>
      {preflight && <div className="crm-preflight-review" role="status"><dl><div><dt>{t.allowed}</dt><dd>{preflight.allowed_count ?? preflight.actions?.length ?? 0}</dd></div><div><dt>{t.skipped}</dt><dd>{(preflight.blocked_count ?? 0) + (preflight.duplicate_count ?? 0)}</dd></div><div><dt>{t.points}</dt><dd>{preflight.quote?.total_points ?? 0}</dd></div></dl><label className="crm-consent"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{t.preflightHint}</span></label></div>}
    </ConsoleModal>}
  </section>;
}

type TemplateDraft = { id: string; name: string; template_type: string; locale: string; content: string; media_ids: string[]; is_default: boolean };
const emptyTemplate = (language: Language): TemplateDraft => ({ id: "", name: "", template_type: "message", locale: language, content: "", media_ids: [], is_default: false });

export function TemplatesView({ language }: { language: Language }) {
  const t = labels[language];
  const [templates, setTemplates] = useState<Row[]>([]);
  const [media, setMedia] = useState<Row[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [previewMediaId, setPreviewMediaId] = useState("");
  const [state, setState] = useState<PageState>("loading");
  const [draft, setDraft] = useState<TemplateDraft>(() => emptyTemplate(language));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => { setState("loading"); setError(""); try { const [templatePayload, mediaPayload] = await Promise.all([crmApi.list("templates", "", 200), crmApi.list("media", "", 200)]); setTemplates(payloadItems(templatePayload)); setMedia(payloadItems(mediaPayload)); setState("ready"); } catch (next) { setError(errorText(next, language)); setState("error"); } }, [language]);
  useEffect(() => { void load(); }, [load]);
  const referencedMediaIds = useMemo(() => [...new Set([
    ...templates.flatMap((item) => arrayOf(item.media_ids ?? item.media_ids_json).map(String)),
    ...draft.media_ids,
  ].filter(Boolean))], [templates, draft.media_ids]);
  useEffect(() => {
    let active = true;
    const createdUrls: string[] = [];
    const loadPreviews = async () => {
      const entries = await Promise.all(referencedMediaIds.map(async (mediaId) => {
        try {
          const blob = await crmApi.mediaContent(mediaId);
          const url = URL.createObjectURL(blob);
          createdUrls.push(url);
          return [mediaId, url] as const;
        } catch {
          return [mediaId, ""] as const;
        }
      }));
      if (active) setPreviewUrls(Object.fromEntries(entries));
    };
    void loadPreviews();
    return () => {
      active = false;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [referencedMediaIds]);
  const mediaById = useMemo(() => new Map(media.map((item) => [idOf(item), item])), [media]);
  const mediaName = (mediaId: string) => textOf(mediaById.get(mediaId)?.original_name, language === "zh-Hant" ? "已保存圖片" : "已保存图片");
  const mediaThumbs = (mediaIds: string[], removable = false) => <div className="crm-template-media" aria-label={t.media}>{mediaIds.map((mediaId) => <article key={mediaId}>
    <button className="crm-template-thumb" type="button" disabled={!previewUrls[mediaId]} onClick={() => setPreviewMediaId(mediaId)} aria-label={`${language === "zh-Hant" ? "預覽" : "预览"} ${mediaName(mediaId)}`}>
      {previewUrls[mediaId] ? <img src={previewUrls[mediaId]} alt={mediaName(mediaId)} loading="lazy" /> : <span><Icon name="templates" />{language === "zh-Hant" ? "圖片讀取中" : "图片读取中"}</span>}
    </button>
    <small title={mediaName(mediaId)}>{mediaName(mediaId)}</small>
    {removable && <button className="crm-template-media-remove" type="button" onClick={() => setDraft((current) => ({ ...current, media_ids: current.media_ids.filter((item) => item !== mediaId) }))}>{language === "zh-Hant" ? "移除" : "移除"}</button>}
  </article>)}</div>;
  const edit = (row?: Row) => {
    setDraft(row ? { id: idOf(row), name: textOf(row.name, ""), template_type: textOf(row.template_type, "message"), locale: textOf(row.locale, language), content: textOf(row.content, ""), media_ids: arrayOf(row.media_ids ?? row.media_ids_json).map(String), is_default: Boolean(row.is_default) } : emptyTemplate(language));
    setEditing(true); setError(""); setNotice("");
  };
  const upload = async (file?: File) => {
    if (!file) return; setBusy("upload"); setError("");
    try { const uploadedMedia = await crmApi.uploadMedia(file); const mediaId = idOf(uploadedMedia); if (mediaId) { setMedia((current) => [...current.filter((item) => idOf(item) !== mediaId), uploadedMedia]); setDraft((current) => ({ ...current, media_ids: [...new Set([...current.media_ids, mediaId])] })); } setNotice(t.uploaded); }
    catch (next) { setError(errorText(next, language)); } finally { setBusy(""); }
  };
  const save = async () => {
    if (!draft.name.trim() || !draft.content.trim()) { setError(t.required); return; }
    setBusy("save"); setError("");
    const payload = { name: draft.name.trim(), template_type: draft.template_type, locale: draft.locale, content: draft.content, media_ids: draft.media_ids, is_default: draft.is_default };
    try { if (draft.id) await crmApi.updateResource("templates", draft.id, payload); else await crmApi.createResource("templates", payload); setNotice(t.saved); setEditing(false); await load(); }
    catch (next) { setError(errorText(next, language)); } finally { setBusy(""); }
  };
  const remove = async (row: Row) => {
    const id = idOf(row); if (!id || !await requestConfirm({ title: t.confirmTitle, message: t.deleteConfirm, confirmText: t.ok, cancelText: t.cancel, danger: true })) return;
    setBusy(`delete:${id}`); setError("");
    try { await crmApi.deleteResource("templates", id); setNotice(t.deleted); await load(); }
    catch (next) { setError(errorText(next, language)); }
    finally { setBusy(""); }
  };
  return <section className="crm-panel crm-business-panel">
    <PageHeader title={t.templates} hint={t.templateHint} language={language} onRefresh={load} action={<button className="crm-primary-button" type="button" onClick={() => edit()}>{t.newTemplate}</button>} />
    {error && <ErrorBox error={error} language={language} retry={load} />}{notice && <div className="crm-success-note" role="status"><Icon name="check" />{notice}</div>}
    {state === "loading" && <Loading language={language} />}{state === "ready" && !templates.length && <p className="crm-quiet-empty">{t.noTemplates}</p>}
    {state === "ready" && templates.length > 0 && <div className="crm-template-grid">{templates.map((item) => { const mediaIds = arrayOf(item.media_ids ?? item.media_ids_json).map(String); return <article key={idOf(item)} className="crm-template-card"><header><div><strong>{textOf(item.name)}</strong><small>{textOf(item.template_type)} · {textOf(item.locale)}</small></div>{Boolean(item.is_default) && <span className="crm-chip">{t.defaultTemplate}</span>}</header>{mediaIds.length > 0 && mediaThumbs(mediaIds)}<p>{textOf(item.content)}</p><footer><span>{t.media}: {mediaIds.length}</span><span className="row-actions"><button type="button" onClick={() => edit(item)}>{t.edit}</button><button type="button" className="danger unified-action-icon-button" disabled={busy === `delete:${idOf(item)}`} title={t.delete} aria-label={t.delete} onClick={() => void remove(item)}><Icon name="trash" className="ui-trash-icon" /></button></span></footer></article>; })}</div>}
    {editing && <ConsoleModal title={draft.id ? t.edit : t.newTemplate} labelledBy="crm-template-editor" onClose={() => setEditing(false)} actions={<><button type="button" onClick={() => setEditing(false)}>{t.cancel}</button><button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void save()}>{busy === "save" ? t.saving : t.save}</button></>}><div className="crm-form-grid"><label className="crm-field"><span>{t.name}</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label className="crm-field"><span>{t.type}</span><SelectMenu value={draft.template_type} onChange={(template_type) => setDraft({ ...draft, template_type })} options={[{ value: "message", label: language === "zh-Hant" ? "私訊／通用" : "私信／通用" }, { value: "comment", label: language === "zh-Hant" ? "公開留言" : "公开留言" }, { value: "reply", label: language === "zh-Hant" ? "回覆" : "回复" }, { value: "group_invite", label: language === "zh-Hant" ? "拉群邀請" : "拉群邀请" }]} /></label><label className="crm-field"><span>{t.locale}</span><SelectMenu value={draft.locale} onChange={(locale) => setDraft({ ...draft, locale })} options={[{ value: "zh-Hans", label: "简体中文" }, { value: "zh-Hant", label: "繁體中文" }]} /></label><label className="crm-field crm-field--wide"><span>{t.content}</span><textarea rows={8} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label><label className="crm-file-field crm-field--wide"><span>{t.media}</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={busy === "upload"} onChange={(event) => { void upload(event.target.files?.[0]); event.currentTarget.value = ""; }} /><small>{busy === "upload" ? t.uploading : t.selectFile}</small></label>{draft.media_ids.length > 0 && <div className="crm-field--wide">{mediaThumbs(draft.media_ids, true)}</div>}<label className="crm-consent crm-field--wide"><input type="checkbox" checked={draft.is_default} onChange={(event) => setDraft({ ...draft, is_default: event.target.checked })} /><span>{t.defaultTemplate}</span></label></div></ConsoleModal>}
    {previewMediaId && previewUrls[previewMediaId] && <ConsoleModal title={mediaName(previewMediaId)} labelledBy="crm-template-media-preview" onClose={() => setPreviewMediaId("")} actions={<button type="button" className="primary" onClick={() => setPreviewMediaId("")}>{t.close}</button>}><div className="crm-template-media-preview"><img src={previewUrls[previewMediaId]} alt={mediaName(previewMediaId)} /></div></ConsoleModal>}
  </section>;
}

type DestinationDraft = { id: string; name: string; url: string; enabled: boolean };
const emptyDestination: DestinationDraft = { id: "", name: "", url: "", enabled: true };

export function DestinationsView({ language }: { language: Language }) {
  const t = labels[language];
  const [rows, setRows] = useState<Row[]>([]); const [state, setState] = useState<PageState>("loading");
  const [draft, setDraft] = useState<DestinationDraft>(emptyDestination); const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const load = useCallback(async () => { setState("loading"); setError(""); try { setRows(payloadItems(await crmApi.list("destinations", "", 200))); setState("ready"); } catch (next) { setError(errorText(next, language)); setState("error"); } }, [language]);
  useEffect(() => { void load(); }, [load]);
  const open = (row?: Row) => { setDraft(row ? { id: idOf(row), name: textOf(row.name, ""), url: textOf(row.url, ""), enabled: Boolean(row.enabled) } : emptyDestination); setEditing(true); setError(""); };
  const save = async () => {
    let parsed: URL; try { parsed = new URL(draft.url.trim()); } catch { setError(t.required); return; }
    if (!draft.name.trim() || parsed.protocol !== "https:") { setError(t.required); return; }
    setBusy("save-destination"); setError("");
    try { const payload = { name: draft.name.trim(), url: parsed.href, enabled: draft.enabled }; if (draft.id) await crmApi.updateResource("destinations", draft.id, payload); else await crmApi.createResource("destinations", payload); setEditing(false); setNotice(t.saved); await load(); }
    catch (next) { setError(errorText(next, language)); } finally { setBusy(""); }
  };
  const remove = async (row: Row) => { const id = idOf(row); if (!id || !await requestConfirm({ title: t.confirmTitle, message: t.deleteConfirm, confirmText: t.ok, cancelText: t.cancel, danger: true })) return; setBusy(`delete:${id}`); try { await crmApi.deleteResource("destinations", id); setNotice(t.deleted); await load(); } catch (next) { setError(errorText(next, language)); } finally { setBusy(""); } };
  return <section className="crm-panel crm-business-panel"><PageHeader title={t.destinations} hint={t.destinationHint} language={language} onRefresh={load} action={<button className="crm-primary-button" type="button" onClick={() => open()}>{t.newDestination}</button>} />
    {error && <ErrorBox error={error} language={language} retry={load} />}{notice && <div className="crm-success-note" role="status"><Icon name="check" />{notice}</div>}
    {state === "loading" && <Loading language={language} />}{state === "ready" && !rows.length && <p className="crm-quiet-empty">{t.noDestinations}</p>}
    {state === "ready" && rows.length > 0 && <div className="crm-template-grid">{rows.map((row) => <article className="crm-template-card" key={idOf(row)}><header><div><strong>{textOf(row.name)}</strong><small>{textOf(row.url)}</small></div><span className="crm-chip">{Boolean(row.enabled) ? t.enabled : t.disabled}</span></header><footer><span>HTTPS</span><span className="row-actions"><button type="button" onClick={() => open(row)}>{t.edit}</button><button type="button" className="danger unified-action-icon-button" disabled={busy === `delete:${idOf(row)}`} title={t.delete} aria-label={t.delete} onClick={() => void remove(row)}><Icon name="trash" className="ui-trash-icon" /></button></span></footer></article>)}</div>}
    {editing && <ConsoleModal title={draft.id ? t.edit : t.newDestination} labelledBy="crm-destination-editor" onClose={() => setEditing(false)} actions={<><button type="button" onClick={() => setEditing(false)}>{t.cancel}</button><button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void save()}>{busy ? t.saving : t.save}</button></>}><div className="crm-form-grid"><label className="crm-field"><span>{t.name}</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label className="crm-field crm-field--wide"><span>{t.destinationUrl}</span><input type="url" placeholder="https://" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label><label className="crm-consent crm-field--wide"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>{t.enabled}</span></label></div></ConsoleModal>}
  </section>;
}

export function SchedulesView({ language, onCreate }: { language: Language; onCreate: (workflow: "collect" | "public" | "outreach" | "groups") => void }) {
  const t = labels[language];
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<PageState>("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [workflowType, setWorkflowType] = useState<"collect" | "public" | "outreach" | "groups">("collect");
  const [pendingRun, setPendingRun] = useState<{ row: Row; preflight: Awaited<ReturnType<typeof crmApi.preflight>> } | null>(null);
  const [runConfirmed, setRunConfirmed] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Row | null>(null);
  const [scheduleAt, setScheduleAt] = useState("");
  const load = useCallback(async () => { setState("loading"); setError(""); try { setRows(payloadItems(await crmApi.list("schedules", "", 200))); setState("ready"); } catch (next) { setError(errorText(next, language)); setState("error"); } }, [language]);
  useEffect(() => { void load(); }, [load]);
  const toggle = async (row: Row) => { const id = idOf(row); setBusy(`toggle:${id}`); setError(""); try { await crmApi.updateResource("schedules", id, { enabled: !Boolean(row.enabled) }); await load(); } catch (next) { setError(errorText(next, language)); } finally { setBusy(""); } };
  const prepareRun = async (row: Row) => {
    const id = idOf(row);
    const payload = objectOf(row.payload ?? row.payload_json);
    const actions = arrayOf(payload.actions).filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    if (!actions.length) { setError(t.scheduleMissingActions); return; }
    setBusy(`preflight:${id}`); setError(""); setNotice("");
    try {
      const preflight = await crmApi.preflight({ workflow_type: textOf(row.workflow_type, "scheduled"), actions });
      setPendingRun({ row, preflight }); setRunConfirmed(false);
    } catch (next) { setError(errorText(next, language)); }
    finally { setBusy(""); }
  };
  const confirmRun = async () => {
    if (!pendingRun || !runConfirmed) return;
    const id = idOf(pendingRun.row); setBusy(`run:${id}`); setError("");
    try {
      const result = await crmApi.runSchedule(id, { confirmed: true, preflight_token: pendingRun.preflight.preflight_token, idempotency_key: `crm-schedule-manual:${id}:${window.crypto.randomUUID()}` });
      setNotice(t.taskCreated); setPendingRun(null); setRunConfirmed(false); await load();
    } catch (next) { setError(errorText(next, language)); }
    finally { setBusy(""); }
  };
  const stop = async (row: Row) => { const id = idOf(row); setBusy(`stop:${id}`); setError(""); try { await crmApi.stopSchedule(id); setNotice(t.stop); await load(); } catch (next) { setError(errorText(next, language)); } finally { setBusy(""); } };
  const editSchedule = (row: Row) => {
    const date = new Date(Number(row.next_run_at || 0) * 1000);
    const local = Number.isNaN(date.getTime()) ? "" : new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    setScheduleAt(local); setEditingSchedule(row); setError("");
  };
  const saveSchedule = async () => {
    if (!editingSchedule) return; const date = new Date(scheduleAt);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now() + 60_000) { setError(t.required); return; }
    const id = idOf(editingSchedule); setBusy(`edit:${id}`); setError("");
    try { await crmApi.updateResource("schedules", id, { next_run_at: Math.floor(date.getTime() / 1000), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai" }); setEditingSchedule(null); setNotice(t.saved); await load(); }
    catch (next) { setError(errorText(next, language)); } finally { setBusy(""); }
  };
  return <section className="crm-panel crm-business-panel">
    <PageHeader title={t.schedules} hint={t.scheduleHint} onRefresh={load} />
    {error && <ErrorBox error={error} language={language} retry={load} />}{notice && <div className="crm-success-note" role="status"><Icon name="check" />{notice}</div>}
    <div className="crm-schedule-create"><label className="crm-field"><span>{t.workflowType}</span><SelectMenu value={workflowType} onChange={(next) => setWorkflowType(next as typeof workflowType)} options={(["collect", "public", "outreach", "groups"] as const).map((item) => ({ value: item, label: workflowLabel(item, language) }))} /></label><p>{t.preflightHint}</p><button className="crm-primary-button" type="button" onClick={() => onCreate(workflowType)}>{t.createSchedule}</button></div>
    {pendingRun && <ConsoleModal title={t.preflight} labelledBy="crmSchedulePreflightTitle" onClose={() => setPendingRun(null)} actions={<><button type="button" onClick={() => setPendingRun(null)}>{t.cancel}</button><button type="button" className="primary" disabled={!runConfirmed || Boolean(busy)} onClick={() => void confirmRun()}>{t.confirmRun}</button></>}><dl className="crm-summary-grid"><div><dt>{t.allowed}</dt><dd>{pendingRun.preflight.allowed_count ?? pendingRun.preflight.actions?.length ?? 0}</dd></div><div><dt>{t.skipped}</dt><dd>{(pendingRun.preflight.duplicate_count ?? 0) + (pendingRun.preflight.blocked_count ?? 0)}</dd></div><div><dt>{t.points}</dt><dd>{pendingRun.preflight.quote?.total_points ?? 0}</dd></div></dl><label className="crm-consent"><input type="checkbox" checked={runConfirmed} onChange={(event) => setRunConfirmed(event.target.checked)} /><span>{t.preflightHint}</span></label></ConsoleModal>}
    {editingSchedule && <ConsoleModal title={`${t.edit} · ${workflowLabel(String(editingSchedule.workflow_type || ""), language)}`} labelledBy="crmScheduleEditor" onClose={() => setEditingSchedule(null)} actions={<><button type="button" onClick={() => setEditingSchedule(null)}>{t.cancel}</button><button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void saveSchedule()}>{t.save}</button></>}><label className="crm-field"><span>{t.nextRun}</span><input type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} /></label></ConsoleModal>}
    {state === "loading" && <Loading language={language} />}{state === "ready" && !rows.length && <p className="crm-quiet-empty">{t.noSchedules}</p>}{state === "ready" && rows.length > 0 && <div className="crm-schedule-list">{rows.map((row) => { const id = idOf(row); const enabled = Boolean(row.enabled); return <article key={id}><div><strong>{workflowLabel(String(row.workflow_type || ""), language)}</strong><small>{cronFriendly(row.cron_expression, language)}</small></div><span className={`task-status-text ${enabled ? "is-success" : "is-muted"}`}>{enabled ? t.enabled : t.disabled}</span><dl><div><dt>{t.nextRun}</dt><dd>{dateText(row.next_run_at, language)}</dd></div><div><dt>{t.lastRun}</dt><dd>{dateText(row.last_run_at, language)}</dd></div></dl><div className="row-actions"><button type="button" disabled={Boolean(busy)} onClick={() => void toggle(row)}>{enabled ? t.disable : t.enable}</button><button type="button" disabled={Boolean(busy)} onClick={() => editSchedule(row)}>{t.edit}</button><button type="button" disabled={Boolean(busy)} onClick={() => void prepareRun(row)}>{busy === `preflight:${id}` ? t.running : t.runNow}</button><button type="button" disabled={Boolean(busy)} onClick={() => void stop(row)}>{busy === `stop:${id}` ? t.running : t.stop}</button></div></article>; })}</div>}
  </section>;
}

function metricEntries(value: unknown): Array<[string, number]> {
  return Object.entries(objectOf(value)).map(([key, count]): [string, number] => [key, Number(count) || 0]).filter(([, count]) => count >= 0);
}
export function AnalyticsView({ language }: { language: Language }) {
  const t = labels[language]; const [state, setState] = useState<PageState>("loading"); const [data, setData] = useState<Row>({}); const [error, setError] = useState("");
  const load = useCallback(async () => { setState("loading"); setError(""); try { setData(await crmApi.analytics()); setState("ready"); } catch (next) { setError(errorText(next, language)); setState("error"); } }, [language]);
  useEffect(() => { void load(); }, [load]);
  const workflows = useMemo(() => metricEntries(data.workflow_statuses), [data.workflow_statuses]);
  const eventEntries = useMemo(() => metricEntries(data.event_types), [data.event_types]);
  const events = useMemo(() => groupEventMix(eventEntries, language).map((part) => [part.key, part.count] as [string, number]), [eventEntries, language]);
  const actionStates = useMemo(() => metricEntries(data.action_states), [data.action_states]); const confirmedActions = useMemo(() => metricEntries(data.confirmed_action_types), [data.confirmed_action_types]); const funnel = useMemo(() => metricEntries(data.funnel), [data.funnel]); const historicalFunnel = useMemo(() => metricEntries(data.historical_funnel), [data.historical_funnel]); const workflowTotal = workflows.reduce((sum, [, count]) => sum + count, 0); const eventTotal = eventEntries.reduce((sum, [, count]) => sum + count, 0); const confirmedTotal = confirmedActions.reduce((sum, [, count]) => sum + count, 0);
  const bars = (items: Array<[string, number]>) => { const max = Math.max(...items.map(([, count]) => count), 1); return <div className="crm-analytics-bars">{items.map(([key, count]) => <div key={key}><span><strong>{metricLabel(key, language)}</strong><b>{count}</b></span><i><span style={{ width: `${(count / max) * 100}%` }} /></i></div>)}</div>; };
  return <section className="crm-panel crm-business-panel"><PageHeader title={t.analytics} hint={t.analyticsHint} onRefresh={load} />{state === "loading" && <Loading language={language} />}{state === "error" && <ErrorBox error={error} language={language} retry={load} />}{state === "ready" && <><div className="crm-analytics-totals"><div><span>{t.totalWorkflows}</span><strong>{workflowTotal}</strong></div><div><span>{t.totalEvents}</span><strong>{eventTotal}</strong></div><div><span>{t.totalConfirmed}</span><strong>{confirmedTotal}</strong></div></div>{funnel.length > 0 && <MixBar title={t.funnel} parts={mixParts(funnel, language)} />}{!workflowTotal && !eventTotal && !actionStates.length ? <p className="crm-quiet-empty">{t.noAnalytics}</p> : <div className="crm-analytics-grid"><section><h3>{t.workflowStatuses}</h3>{bars(workflows)}</section><section><h3>{t.actionStates}</h3>{bars(actionStates)}</section><section><h3>{t.confirmedActions}</h3>{bars(confirmedActions)}</section><section><h3>{t.funnel}</h3>{bars(funnel)}</section>{historicalFunnel.length > 0 && <section><h3>{language === "zh-Hant" ? "歷史資料漏斗" : "历史数据漏斗"}</h3>{bars(historicalFunnel)}</section>}<section><h3>{t.eventTypes}</h3>{bars(events)}</section></div>}</>}</section>;
}

function evidenceUrl(value: unknown) {
  const raw = String(value || "").trim(); if (!raw) return "";
  try { const url = new URL(raw, window.location.origin); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
}
export function StructuredEvidence({ evidence, language }: { evidence: Row; language: Language }) {
  const t = labels[language]; const platformUrl = evidenceUrl(evidence.platform_url || evidence.url || evidence.post_url || evidence.target_url); const screenshotUrl = evidenceUrl(evidence.screenshot_url || evidence.screenshot || evidence.image_url);
  const fields = [[t.platform, evidence.platform], [t.member, evidence.username || evidence.target_username || evidence.target], [t.status, metricLabel(String(evidence.status || evidence.result || ""), language)], [t.source, evidence.confirmation_source || evidence.source], [language === "zh-Hant" ? "確認時間" : "确认时间", evidence.confirmed_at || evidence.timestamp]] as Array<[string, unknown]>;
  const visible = fields.filter(([, value]) => value !== undefined && value !== null && value !== "" && textOf(value, "") !== "");
  if (!visible.length && !platformUrl && !screenshotUrl) return <p className="crm-quiet-empty">{language === "zh-Hant" ? "已保留平台證據" : "已保留平台证据"}</p>;
  return <div className="crm-structured-evidence">{screenshotUrl && <a href={screenshotUrl} target="_blank" rel="noreferrer"><img src={screenshotUrl} alt={t.media} loading="lazy" /></a>}<dl>{visible.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{key.includes("时间") || key.includes("時間") ? dateText(value, language) : textOf(value)}</dd></div>)}</dl>{platformUrl && <a className="crm-secondary-button" href={platformUrl} target="_blank" rel="noreferrer"><Icon name="external" />{t.active}</a>}</div>;
}

const engageCopy = {
  "zh-Hans": {
    title: "公开互动",
    hint: "先查看可互动人数，再准备当前批次；完成后可继续下一批。",
    choosePool: "选择客户池",
    poolReady: "有原文且通过需求过滤的客户才会进入互动。",
    total: "名单总数",
    unique: "不重复",
    eligible: "可互动",
    excluded: "已排除",
    qualified: "合格数",
    processed: "已处理",
    remaining: "待互动",
    batchLimit: "每批人数",
    why: "为什么不是全部名单",
    missing: "缺少原文",
    duplicate: "重复原文",
    noReason: "没有排除项目",
    tags: "按采集标签筛选",
    tagsHint: "未选时使用全部可互动客户",
    allTags: "全选",
    clearTags: "清除",
    start: "开始这一批互动",
    continueNext: "继续下一批",
    empty: "这个客户池还没有可互动的客户。请先完成采集，或换一个池。",
    loading: "正在读取可互动名单…",
    batchNote: "每次按 5、10 或 20 人准备一个批次；完成后再继续下一批。",
  },
  "zh-Hant": {
    title: "公開互動",
    hint: "先查看可互動人數，再準備目前批次；完成後可繼續下一批。",
    choosePool: "選擇客戶池",
    poolReady: "有原文且通過需求過濾的客戶才會進入互動。",
    total: "名單總數",
    unique: "不重複",
    eligible: "可互動",
    excluded: "已排除",
    qualified: "合格數",
    processed: "已處理",
    remaining: "待互動",
    batchLimit: "每批人數",
    why: "為什麼不是全部名單",
    missing: "缺少原文",
    duplicate: "重複原文",
    noReason: "沒有排除項目",
    tags: "按採集標籤篩選",
    tagsHint: "未選時使用全部可互動客戶",
    allTags: "全選",
    clearTags: "清除",
    start: "開始這一批互動",
    continueNext: "繼續下一批",
    empty: "這個客戶池還沒有可互動的客戶。請先完成採集，或換一個池。",
    loading: "正在讀取可互動名單…",
    batchNote: "每次按 5、10 或 20 人準備一個批次；完成後再繼續下一批。",
  },
} as const;

type EngageStart = {
  poolId: string;
  leadIds: string[];
  leads: Row[];
  batchSize: 5 | 10 | 20;
};

export function PublicEngageView({
  language,
  enabled,
  blockedHint,
  onStart,
  onRefreshTasks,
}: {
  language: Language;
  enabled: boolean;
  blockedHint?: string;
  onStart: (seed: EngageStart) => void;
  onRefreshTasks?: () => void;
}) {
  const t = engageCopy[language];
  const [pools, setPools] = useState<Row[]>([]);
  const [poolId, setPoolId] = useState("");
  const [progress, setProgress] = useState<Row | null>(null);
  const [state, setState] = useState<PageState>("loading");
  const [error, setError] = useState("");
  const [batchSize, setBatchSize] = useState<5 | 10 | 20>(10);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  const loadPools = useCallback(async () => {
    setState("loading"); setError("");
    try {
      const payload = await crmApi.list("pools", "", 200);
      const rows = payloadItems(payload);
      setPools(rows);
      setPoolId((current) => current || idOf(rows[0] || {}));
      setState("ready");
    } catch (next) {
      setError(errorText(next, language));
      setState("error");
    }
  }, [language]);

  const loadProgress = useCallback(async (targetId: string, tags: string[], size: 5 | 10 | 20) => {
    if (!targetId) { setProgress(null); return; }
    setError("");
    try {
      setProgress(await crmApi.commentProgress(targetId, tags, size));
    } catch (next) {
      setError(errorText(next, language));
      setProgress(null);
    }
  }, [language]);

  useEffect(() => { void loadPools(); }, [loadPools]);
  useEffect(() => { void loadProgress(poolId, selectedTags, batchSize); }, [batchSize, loadProgress, poolId, selectedTags]);

  const eligibility = objectOf(progress?.eligibility);
  const tagOptions = arrayOf(progress?.tagOptions).filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const remaining = Number(progress?.remaining || 0);
  const nextLeadIds = arrayOf(progress?.nextLeadIds).map(String).filter(Boolean);
  const nextLeads = arrayOf(progress?.nextLeads).filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const exclusionEntries = Object.entries(objectOf(eligibility.exclusionReasons)).filter(([, count]) => Number(count) > 0);
  const whyParts = [
    ...exclusionEntries.map(([reason, count]) => `${reason} ${Number(count)}`),
    Number(eligibility.missingSourcePost || 0) ? `${t.missing} ${Number(eligibility.missingSourcePost)}` : "",
    Number(eligibility.duplicateSourcePost || 0) ? `${t.duplicate} ${Number(eligibility.duplicateSourcePost)}` : "",
  ].filter(Boolean);
  const start = () => {
    if (!poolId || !nextLeadIds.length) return;
    onStart({ poolId, leadIds: nextLeadIds, leads: nextLeads, batchSize });
  };

  return <section className="crm-panel crm-business-panel" aria-busy={state === "loading"}>
    <PageHeader title={t.title} hint={t.hint} language={language} onRefresh={() => { void loadPools(); void loadProgress(poolId, selectedTags, batchSize); onRefreshTasks?.(); }} />
    {!enabled && blockedHint && <div className="crm-inline-error" role="status"><Icon name="warning" /><span>{blockedHint}</span></div>}
    {error && <ErrorBox error={error} language={language} retry={() => { void loadPools(); void loadProgress(poolId, selectedTags, batchSize); }} />}
    {state === "loading" && !pools.length && <p className="crm-quiet-empty">{t.loading}</p>}
    {enabled && <>
      <label className="crm-field"><span>{t.choosePool}</span><SelectMenu value={poolId} onChange={(next) => { setPoolId(next); setSelectedTags([]); }} placeholder={t.choosePool} searchPlaceholder={language === "zh-Hant" ? "篩選客戶池" : "筛选客户池"} emptyLabel={language === "zh-Hant" ? "沒有匹配的客戶池" : "没有匹配的客户池"} options={pools.map((pool) => ({ value: idOf(pool), label: textOf(pool.name, idOf(pool)) }))} /><small>{progress?.poolName ? `${textOf(progress.poolName)} · ${t.poolReady}` : t.poolReady}</small></label>
      <div className="crm-engage-metrics">
        <div><b>{Number(eligibility.poolLeads || 0)}</b><span>{t.total}</span></div>
        <div><b>{Number(eligibility.uniqueSourcePosts || 0)}</b><span>{t.unique}</span></div>
        <div><b>{Number(eligibility.eligible || 0)}</b><span>{t.eligible}</span></div>
        <div><b>{Number(eligibility.excluded || 0)}</b><span>{t.excluded}</span></div>
        <div><b>{Number(progress?.total || 0)}</b><span>{t.qualified}</span></div>
        <div><b>{Number(progress?.processed || 0)}</b><span>{t.processed}</span></div>
        <div><b>{remaining}</b><span>{t.remaining}</span></div>
        <div><b>{Number(progress?.batchSize || batchSize)}</b><span>{t.batchLimit}</span></div>
      </div>
      <div className="crm-engage-note"><strong>{t.why}</strong><span>{whyParts.join("、") || t.noReason}</span></div>
      <div className="crm-engage-note"><span>{t.batchNote}</span></div>
      <div className="crm-engage-batch">{([5, 10, 20] as const).map((size) => <button type="button" className={batchSize === size ? "is-active" : ""} key={size} onClick={() => setBatchSize(size)}>{size}</button>)}</div>
      <div className="crm-engage-tags">
        <div className="crm-wizard-selection-head"><strong>{t.tags}</strong><small>{selectedTags.length ? `${selectedTags.length}/${tagOptions.length}` : t.tagsHint}</small><div><button type="button" disabled={!tagOptions.length} onClick={() => setSelectedTags(tagOptions.map((item) => textOf(item.tag)).filter(Boolean))}>{t.allTags}</button><button type="button" onClick={() => setSelectedTags([])}>{t.clearTags}</button></div></div>
        <div className="crm-chip-row">{tagOptions.map((item) => { const tag = textOf(item.tag); const active = selectedTags.includes(tag); return <button type="button" className={active ? "is-active" : ""} key={tag} onClick={() => setSelectedTags((current) => current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag])}>{tag} {Number(item.count || 0)}</button>; })}</div>
      </div>
      {!remaining ? <p className="crm-quiet-empty">{t.empty}</p> : <div className="crm-pool-launch"><button className="crm-primary-button" type="button" onClick={start}>{Number(progress?.processed || 0) > 0 ? t.continueNext : t.start} · {nextLeadIds.length}</button></div>}
    </>}
  </section>;
}
