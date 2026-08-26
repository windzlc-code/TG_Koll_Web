import { useEffect, useMemo, useRef, useState } from "react";
import { crmApi, payloadItems } from "./api";
import { localizedError, type Messages } from "./i18n";
import { Icon } from "./icons";
import { PlatformLogo } from "./platform";
import { ConsoleModal } from "./confirm-dialog";
import type { CrmAccount, Language, ViewId } from "./types";

type Row = Record<string, unknown>;
export type WizardView = Extract<ViewId, "collect" | "public" | "outreach" | "groups" | "relationships">;
type ExecutionMode = "sample" | "batch" | "schedule";
type PublicActionType = "public_comment" | "public_reply" | "followup_reply" | "nurture_reply";
type PreflightResult = Awaited<ReturnType<typeof crmApi.preflight>>;

const copy = {
  "zh-Hans": {
    title: "建立 CRM 任务", close: "关闭", back: "上一步", next: "下一步", cancel: "取消", prepare: "分析并继续",
    submit: "确认并开始", submitting: "正在建立任务…", loading: "正在读取客户池、模板和账号…", required: "请完成当前步骤的必填内容。",
    step: (current: number, total: number) => `步骤 ${current}/${total}`,
    collectSteps: ["选择采集方式", "填写需求与范围", "确认并启动"],
    engageSteps: ["选择客户", "准备内容", "执行方式", "最终确认"],
    relationSteps: ["选择客户", "选择账号", "确认验证"],
    assistant: "Vecto AI 操作助手", assistantHints: {
      collect: "沿用原 CRM 的三步采集：先选方式，再分析需求或搜索热点，最后核对范围并启动。",
      public: "先从客户池选择目标，再准备公开留言内容，最后通过预检确认发布。",
      outreach: "先选客户、再绑定模板，最后选择样本、批次或排程；不会跳过重复触达检查。",
      groups: "先确定邀请对象与平台，再准备邀请内容；Instagram 群聊和 Threads 邀请帖会明确区分。",
      relationships: "从客户池选择要复核的客户，再使用 Instagram 账号进行只读关系检查。",
    },
    mode: "采集方式", persona: "依需求定向采集", personaHint: "输入用户画像、产品或营销方案", hotspot: "热点全域采集", hotspotHint: "搜索高互动 Threads 帖子", link: "链接精准采集", linkHint: "从指定帖子或主页开始",
    demand: "需求、画像或产品方案", demandPlaceholder: "例如：寻找近期有房贷月付压力、正在比较转贷方案的用户", query: "热点关键词", queryPlaceholder: "例如：房贷、品牌增长、AI 自动化", sourceLink: "指定链接", sourceLinkPlaceholder: "https://www.threads.com/@username/post/...",
    platform: "采集平台", threads: "Threads", instagram: "Instagram", limit: "采集上限", analysis: "分析结果", keywords: "搜索关键词", results: "真实搜索结果", selectedSources: "已选择来源", noResults: "没有找到可用结果，可返回修改关键词。",
    pool: "客户池", choosePool: "请选择客户池", recipients: "选择客户", selectAll: "选择本页全部", clear: "清空选择", loadMoreMembers: "加载更多客户", selected: (count: number) => `实际执行 ${count} 位客户`, noMembers: "该客户池暂无可用客户。", unavailableMember: "缺少平台账号或原帖链接，无法用于当前动作",
    template: "消息模板", chooseTemplate: "不使用已保存模板", content: "任务内容", contentPlaceholder: "填写公开留言、私信或邀请内容", publicMode: "公开互动方式", publicComment: "首次公开留言", publicReply: "公开回复", followupReply: "跟进回复", nurtureReply: "持续互动培育", publicReplyHint: "回复类动作必须选择带有原帖或评论链接的客户；系统会逐条保留提交证据。", groupMode: "群组方式", threadsPost: "Threads 社群邀请帖", instagramDirect: "Instagram Direct 群聊",
    account: "执行账号", chooseAccount: "请选择账号", accountLogin: "需要先登录", execution: "执行方式", sample: "少量样本", sampleHint: "手动选择 1–20 位真实客户先行测试", batch: "稳定分批", batchHint: "按所选客户逐个执行并记录证据", schedule: "定时排程", scheduleHint: "到指定时间创建任务；真实动作仍按确认与计费规则执行", scheduleAt: "执行时间",
    confirmation: "提交前确认", action: "任务类型", targetRange: "目标范围", billing: "计费", billingWrite: "后端预检通过后按批准批次预占与结算", billingRead: "只读操作免费，但保留任务与证据记录", consent: "我已核对账号、目标客户与内容，并确认允许系统执行以上真实平台动作。",
    aiDrafts: "按原帖生成 AI 留言草稿", aiDrafting: "正在逐条生成草稿…", aiDraftHint: "每位客户会保留独立草稿；提交前仍可逐条修改。", draftFor: "给这位客户的留言",
    prepared: "准备完成", taskQueued: "任务已进入队列", scheduleSaved: "排程已保存", searchWarning: "结果来自实时搜索，请在继续前勾选正确来源。",
    runPreflight: "检查目标与计费", confirmAfterPreflight: "确认预检并开始", preflightTitle: "服务端执行预检", preflightHint: "请确认可执行目标、跳过原因和预计扣点，再进行第二次确认。",
    totalTargets: "提交目标", allowedTargets: "可执行", duplicateTargets: "重复跳过", blockedTargets: "策略拦截", estimatedPoints: "预计扣点", expiresAt: "确认有效至", skippedTargets: "跳过明细", noCharge: "本次不扣点",
  },
  "zh-Hant": {
    title: "建立 CRM 任務", close: "關閉", back: "上一步", next: "下一步", cancel: "取消", prepare: "分析並繼續",
    submit: "確認並開始", submitting: "正在建立任務…", loading: "正在讀取客戶池、範本和帳號…", required: "請完成目前步驟的必填內容。",
    step: (current: number, total: number) => `步驟 ${current}/${total}`,
    collectSteps: ["選擇採集方式", "填寫需求與範圍", "確認並啟動"],
    engageSteps: ["選擇客戶", "準備內容", "執行方式", "最終確認"],
    relationSteps: ["選擇客戶", "選擇帳號", "確認驗證"],
    assistant: "Vecto AI 操作助手", assistantHints: {
      collect: "沿用原 CRM 的三步採集：先選方式，再分析需求或搜尋熱點，最後核對範圍並啟動。",
      public: "先從客戶池選擇目標，再準備公開留言內容，最後透過預檢確認發佈。",
      outreach: "先選客戶、再綁定範本，最後選擇樣本、批次或排程；不會跳過重複觸達檢查。",
      groups: "先確定邀請對象與平台，再準備邀請內容；Instagram 群聊和 Threads 邀請貼文會明確區分。",
      relationships: "從客戶池選擇要複核的客戶，再使用 Instagram 帳號進行唯讀關係檢查。",
    },
    mode: "採集方式", persona: "依需求定向採集", personaHint: "輸入用戶畫像、產品或行銷方案", hotspot: "熱點全域採集", hotspotHint: "搜尋高互動 Threads 貼文", link: "連結精準採集", linkHint: "從指定貼文或主頁開始",
    demand: "需求、畫像或產品方案", demandPlaceholder: "例如：尋找近期有房貸月付壓力、正在比較轉貸方案的用戶", query: "熱點關鍵詞", queryPlaceholder: "例如：房貸、品牌增長、AI 自動化", sourceLink: "指定連結", sourceLinkPlaceholder: "https://www.threads.com/@username/post/...",
    platform: "採集平台", threads: "Threads", instagram: "Instagram", limit: "採集上限", analysis: "分析結果", keywords: "搜尋關鍵詞", results: "真實搜尋結果", selectedSources: "已選擇來源", noResults: "沒有找到可用結果，可返回修改關鍵詞。",
    pool: "客戶池", choosePool: "請選擇客戶池", recipients: "選擇客戶", selectAll: "選擇本頁全部", clear: "清空選擇", loadMoreMembers: "載入更多客戶", selected: (count: number) => `實際執行 ${count} 位客戶`, noMembers: "該客戶池暫無可用客戶。", unavailableMember: "缺少平台帳號或原貼文連結，無法用於目前動作",
    template: "訊息範本", chooseTemplate: "不使用已儲存範本", content: "任務內容", contentPlaceholder: "填寫公開留言、私訊或邀請內容", publicMode: "公開互動方式", publicComment: "首次公開留言", publicReply: "公開回覆", followupReply: "跟進回覆", nurtureReply: "持續互動培育", publicReplyHint: "回覆類動作必須選擇帶有原貼文或留言連結的客戶；系統會逐則保留提交證據。", groupMode: "群組方式", threadsPost: "Threads 社群邀請貼文", instagramDirect: "Instagram Direct 群聊",
    account: "執行帳號", chooseAccount: "請選擇帳號", accountLogin: "需要先登入", execution: "執行方式", sample: "少量樣本", sampleHint: "手動選擇 1–20 位真實客戶先行測試", batch: "穩定分批", batchHint: "按所選客戶逐個執行並記錄證據", schedule: "定時排程", scheduleHint: "到指定時間建立任務；真實動作仍按確認與計費規則執行", scheduleAt: "執行時間",
    confirmation: "提交前確認", action: "任務類型", targetRange: "目標範圍", billing: "計費", billingWrite: "後端預檢通過後按批准批次預佔與結算", billingRead: "唯讀操作免費，但保留任務與證據記錄", consent: "我已核對帳號、目標客戶與內容，並確認允許系統執行以上真實平台動作。",
    aiDrafts: "按原貼文生成 AI 留言草稿", aiDrafting: "正在逐則生成草稿…", aiDraftHint: "每位客戶會保留獨立草稿；提交前仍可逐則修改。", draftFor: "給這位客戶的留言",
    prepared: "準備完成", taskQueued: "任務已進入佇列", scheduleSaved: "排程已儲存", searchWarning: "結果來自即時搜尋，請在繼續前勾選正確來源。",
    runPreflight: "檢查目標與計費", confirmAfterPreflight: "確認預檢並開始", preflightTitle: "服務端執行預檢", preflightHint: "請確認可執行目標、跳過原因和預計扣點，再進行第二次確認。",
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
  if (!account || String(account.status || "").toLowerCase() !== "ready") return false;
  return !["abnormal", "banned", "needs_login", "cookie_expired", "pending_login"]
    .includes(String(account.health_status || "").toLowerCase());
}

function asRows(value: unknown): Row[] { return Array.isArray(value) ? value.filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item))) : []; }
function futureLocalValue() { const date = new Date(Date.now() + 60 * 60 * 1000); date.setSeconds(0, 0); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }

export function WorkflowWizard({
  view, messages, language, capabilities, onClose, onCreated,
}: {
  view: WizardView | null;
  messages: Messages;
  language: Language;
  capabilities?: Record<string, { enabled?: boolean }>;
  onClose: () => void;
  onCreated: (taskId: string) => void;
}) {
  const t = copy[language];
  const dialog = useRef<HTMLElement>(null);
  const idempotency = useRef("");
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [accounts, setAccounts] = useState<CrmAccount[]>([]);
  const [pools, setPools] = useState<Row[]>([]);
  const [templates, setTemplates] = useState<Row[]>([]);
  const [destinations, setDestinations] = useState<Row[]>([]);
  const [poolId, setPoolId] = useState("");
  const [members, setMembers] = useState<Row[]>([]);
  const [memberCursor, setMemberCursor] = useState("");
  const [membersHaveMore, setMembersHaveMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [accountId, setAccountId] = useState("");
  const [collectAccountIds, setCollectAccountIds] = useState<Record<"threads" | "instagram", string>>({ threads: "", instagram: "" });
  const [templateId, setTemplateId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [content, setContent] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [execution, setExecution] = useState<ExecutionMode>("sample");
  const [scheduleAt, setScheduleAt] = useState(futureLocalValue());
  const [collectMode, setCollectMode] = useState<"persona" | "hotspot" | "link">("persona");
  const [collectInput, setCollectInput] = useState("");
  const [collectLimit, setCollectLimit] = useState(30);
  const [platforms, setPlatforms] = useState({ threads: true, instagram: false });
  const [prepared, setPrepared] = useState<Row | null>(null);
  const [sourceSelection, setSourceSelection] = useState<Set<string>>(new Set());
  const [groupMode, setGroupMode] = useState<"threads" | "instagram">("threads");
  const [publicAction, setPublicAction] = useState<PublicActionType>("public_comment");
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);

  const totalSteps = view === "collect" ? 3 : view === "relationships" ? 3 : 4;
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
  const effectiveRecipients = useMemo(
    () => execution === "sample" ? selectedMembers.slice(0, 20) : selectedMembers,
    [execution, selectedMembers],
  );
  const selectedAccount = accounts.find((account) => String(account.id) === accountId);
  const selectedAccountReady = accountReady(selectedAccount);
  const collectPlatforms = (["threads", "instagram"] as const).filter((platform) => platforms[platform]);
  const isWrite = view === "public" || view === "outreach" || view === "groups";
  const requiredPlatform = view === "relationships" || (view === "groups" && groupMode === "instagram") ? "instagram" : view === "public" || view === "groups" ? "threads" : "";
  const supportedAccounts = accounts.filter((account) => !requiredPlatform || String(account.platform || "").toLowerCase() === requiredPlatform);

  useEffect(() => {
    if (!view) return;
    idempotency.current = `crm-wizard:${view}:${window.crypto.randomUUID()}`;
    setStep(1); setError(""); setBusy("load"); setSelected(new Set()); setPrepared(null); setSourceSelection(new Set()); setDrafts({}); setConsent(false); setPreflightResult(null);
    Promise.all([crmApi.list("accounts", "", 100), crmApi.list("pools", "", 200), crmApi.list("templates", "", 200), crmApi.list("destinations", "", 200)])
      .then(([accountPayload, poolPayload, templatePayload, destinationPayload]) => {
        const nextAccounts = payloadItems(accountPayload) as CrmAccount[];
        const nextPools = payloadItems(poolPayload);
        const nextTemplates = payloadItems(templatePayload);
        const nextDestinations = payloadItems(destinationPayload).filter((row) => Boolean(row.enabled));
        const preferredType = view === "public" ? "comment" : view === "groups" ? "group_invite" : "message";
        const preferred = nextTemplates.find((row) => Boolean(row.is_default) && String(row.locale || language) === language && String(row.template_type || "message") === preferredType)
          || nextTemplates.find((row) => Boolean(row.is_default) && String(row.template_type || "message") === preferredType);
        setAccounts(nextAccounts); setPools(nextPools); setTemplates(nextTemplates); setDestinations(nextDestinations);
        setCollectAccountIds({
          threads: String(nextAccounts.find((row) => String(row.platform || "").toLowerCase() === "threads" && accountReady(row))?.id || ""),
          instagram: String(nextAccounts.find((row) => String(row.platform || "").toLowerCase() === "instagram" && accountReady(row))?.id || ""),
        });
        setTemplateId(preferred ? rowId(preferred) : "");
        setContent(preferred ? String(preferred.content || "") : "");
        setPoolId(rowId(nextPools[0] || {}));
      })
      .catch((next) => setError(localizedError(next, messages)))
      .finally(() => setBusy(""));
  }, [messages, view]);

  useEffect(() => {
    if (!view || !poolId || view === "collect") { setMembers([]); setMemberCursor(""); setMembersHaveMore(false); return; }
    setBusy("members"); setError("");
    crmApi.poolMembers(poolId, "", 200).then((payload) => {
      const rows = payloadItems(payload);
      setMembers(rows); setSelected(new Set());
      setMemberCursor(String(payload.next_cursor || ""));
      setMembersHaveMore(Boolean(payload.has_more && payload.next_cursor));
    }).catch((next) => setError(localizedError(next, messages))).finally(() => setBusy(""));
  }, [messages, poolId, view]);

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
  }, [accountId, collectAccountIds, content, destinationId, drafts, execution, groupMode, poolId, publicAction, scheduleAt, selected, templateId]);

  useEffect(() => {
    if (!view) return;
    const previous = document.activeElement as HTMLElement | null;
    window.requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>("button, select, input, textarea")?.focus());
    const onKey = (event: KeyboardEvent) => {
      const node = dialog.current;
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [onClose, view]);

  if (!view) return null;

  const selectTemplate = (id: string) => {
    setTemplateId(id);
    const template = templates.find((row) => rowId(row) === id);
    if (template) setContent(String(template.content || ""));
  };

  const prepareCollection = async () => {
    if (collectInput.trim().length < 2 || (!platforms.threads && !platforms.instagram)) { setError(t.required); return; }
    setBusy("prepare"); setError("");
    try {
      let result: Row;
      if (collectMode === "persona") result = await crmApi.analyzeDemand({ text: collectInput.trim(), locale: language });
      else if (collectMode === "hotspot") result = await crmApi.searchHotspots({ query: collectInput.trim(), platform: "threads", accountId, limit: collectLimit, locale: language });
      else {
        const url = new URL(collectInput.trim());
        if (url.protocol !== "https:" || !/(^|\.)(threads\.com|threads\.net|instagram\.com)$/i.test(url.hostname)) throw new Error(t.required);
        result = { mode: "link", data: [{ sourceUrl: url.href, text: url.href }] };
      }
      setPrepared(result);
      const rows = asRows(result.data || result.items || result.results);
      setSourceSelection(new Set(rows.map((row) => String(row.sourceUrl || row.source_url || row.url || "")).filter(Boolean)));
      setStep(3);
    } catch (next) { setError(localizedError(next, messages)); }
    finally { setBusy(""); }
  };

  const collectActions = () => {
    const rows = asRows(prepared?.data || prepared?.items || prepared?.results);
    if (collectMode === "hotspot" || collectMode === "link") {
      return rows.filter((row) => sourceSelection.has(String(row.sourceUrl || row.source_url || row.url || ""))).map((row) => {
        const target = String(row.sourceUrl || row.source_url || row.url || "");
        const platform = collectMode === "hotspot" ? "threads" : platformFromUrl(target);
        return { action_type: "collect_profile", account_id: platform ? collectAccountIds[platform] : "", target_key: target, content: "", payload: { target_url: target, source: collectMode, platform } };
      });
    }
    const keywords = arrayOf(prepared?.keywords).map(String).filter(Boolean).slice(0, Math.min(collectLimit, 24));
    return keywords.flatMap((keyword) => collectPlatforms.map((platform) => ({
      action_type: "collect_feed", account_id: collectAccountIds[platform], target_key: `search:${platform}:${keyword}`, content: "",
      payload: { query: keyword, platform, platforms: { [platform]: true }, limit: collectLimit },
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
        replyStrategy: "question_hook",
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
      return { action_type: publicAction, account_id: accountId, target_key: memberTarget(row), content: comment, payload: { target_url: memberTarget(row), content: comment, lead_id: memberId(row), recipient: memberUsername(row), interaction_mode: publicAction } };
    });
    if (view === "outreach") return recipients.map((row) => ({ action_type: "direct_message", account_id: accountId, target_key: memberUsername(row), content: content.trim(), payload: { recipient: memberUsername(row), content: content.trim(), message: content.trim(), lead_id: memberId(row), template_id: templateId, ...(destinationId ? { destination_id: destinationId, campaign_id: idempotency.current } : {}) } }));
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
      if (execution === "schedule" && view !== "collect") {
        const at = new Date(scheduleAt);
        if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now() + 60_000) { setError(t.required); return; }
        const schedule = await crmApi.createResource("schedules", {
          workflow_type: view, cron_expression: `${at.getMinutes()} ${at.getHours()} * * *`, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
          enabled: true, next_run_at: Math.floor(at.getTime() / 1000), payload: { run_once: true, confirmed: true, title: messages.views[view][0], input: { pool_id: poolId, template_id: templateId, account_id: accountId, execution }, actions: executableActions, preflight_token: preflightResult?.preflight_token || "" },
        });
        onCreated(`schedule:${rowId(schedule)}`); onClose(); return;
      }
      const result = await crmApi.createWorkflow({ workflow_type: view, title: messages.views[view][0], idempotency_key: idempotency.current, input: { pool_id: poolId, template_id: templateId, account_id: accountId, lead_ids: selectedMembers.map(memberId), execution, collect_mode: collectMode, source: collectInput.trim() }, actions: executableActions, ...(preflightResult ? { preflight_token: preflightResult.preflight_token } : {}), confirmed: isWrite ? consent : true });
      onCreated(result.task_id); onClose();
    } catch (next) { setError(localizedError(next, messages)); }
    finally { setBusy(""); }
  };

  const canContinue = () => {
    if (view === "collect") {
      if (step === 1) return true;
      if (step === 2) return collectInput.trim().length >= 2 && (platforms.threads || platforms.instagram);
      const actions = collectActions();
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
      && (execution !== "schedule" || scheduleAt)
      && (execution !== "sample" || selectedMembers.length <= 20)
      && (view !== "groups" || groupMode !== "instagram" || selectedMembers.length <= 10)
    );
    return !preflightResult || consent;
  };

  const next = () => {
    setError("");
    if (!canContinue()) { setError(t.required); return; }
    if (view === "collect" && step === 2) { void prepareCollection(); return; }
    setStep((current) => Math.min(totalSteps, current + 1));
  };

  const choice = (active: boolean) => active ? "crm-wizard-choice is-active" : "crm-wizard-choice";
  const renderPoolSelection = () => <>
    <label className="crm-field"><span>{t.pool}</span><select value={poolId} onChange={(event) => setPoolId(event.target.value)}><option value="">{t.choosePool}</option>{pools.map((pool) => <option key={rowId(pool)} value={rowId(pool)}>{String(pool.name || rowId(pool))}</option>)}</select></label>
    <div className="crm-wizard-selection-head"><strong>{t.recipients}</strong><span>{t.selected(effectiveRecipients.length)}</span><div><button type="button" onClick={() => setSelected(new Set(members.filter(memberEligible).map(memberId).filter(Boolean)))}>{t.selectAll}</button><button type="button" onClick={() => setSelected(new Set())}>{t.clear}</button></div></div>
    {!members.length ? <p className="crm-quiet-empty">{busy === "members" ? t.loading : t.noMembers}</p> : <><div className="crm-wizard-members">{members.map((row) => { const id = memberId(row); const eligible = memberEligible(row); return <label key={id} title={eligible ? "" : t.unavailableMember}><input type="checkbox" disabled={!eligible} checked={eligible && selected.has(id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} /><span><strong>{memberLabel(row)}</strong><small>{eligible ? `@${memberUsername(row) || id}` : t.unavailableMember}</small></span></label>; })}</div>{membersHaveMore && <div className="crm-pagination"><button className="crm-secondary-button" type="button" disabled={busy === "members-more"} onClick={() => void loadMoreMembers()}>{busy === "members-more" ? t.loading : t.loadMoreMembers}</button></div>}</>}
  </>;

  const resultRows = asRows(prepared?.data || prepared?.items || prepared?.results);
  const keywordRows = arrayOf(prepared?.keywords).map(String).filter(Boolean);
  const collectReviewPlatforms: Array<"threads" | "instagram"> = collectMode === "persona"
    ? collectPlatforms
    : [collectMode === "hotspot" ? "threads" : platformFromUrl(collectInput)].filter((item): item is "threads" | "instagram" => Boolean(item));

  return <ConsoleModal title={`${t.title} · ${messages.views[view][0]}`} labelledBy="crmWorkflowTitle" onClose={onClose} wide dialogRef={dialog} actions={<><button type="button" onClick={step === 1 ? onClose : () => { setError(""); setStep((current) => Math.max(1, current - 1)); }}>{step === 1 ? t.cancel : t.back}</button>{step < totalSteps && !(view === "collect" && step === 3) ? <button type="button" className="primary" disabled={Boolean(busy) || !canContinue()} onClick={next}>{busy === "prepare" ? t.prepare : t.next}</button> : <button type="button" className="primary" disabled={Boolean(busy) || !canContinue()} onClick={() => void submit()}>{busy === "submit" ? t.submitting : isWrite ? (preflightResult ? t.confirmAfterPreflight : t.runPreflight) : t.submit}</button>}</>}>
      <div className="crm-wizard-progress" aria-label={t.step(step, totalSteps)}>{stepNames.map((name, index) => <span className={index + 1 === step ? "is-current" : index + 1 < step ? "is-complete" : ""} key={name}><i>{index + 1 < step ? "✓" : index + 1}</i><b>{name}</b></span>)}</div>
      <aside className="crm-wizard-assistant"><Icon name="signal" /><span><strong>{t.assistant}</strong>{t.assistantHints[view]}</span></aside>
      <div className="crm-wizard-body">
        {busy === "load" && <p className="crm-quiet-empty">{t.loading}</p>}
        {view === "collect" && step === 1 && <div className="crm-wizard-choices">{(["persona", "hotspot", "link"] as const).map((mode) => <button className={choice(collectMode === mode)} type="button" key={mode} onClick={() => { setCollectMode(mode); setPrepared(null); }}><Icon name={mode === "persona" ? "collect" : mode === "hotspot" ? "signal" : "external"} /><span><strong>{t[mode]}</strong><small>{t[`${mode}Hint` as "personaHint" | "hotspotHint" | "linkHint"]}</small></span><i>›</i></button>)}</div>}
        {view === "collect" && step === 2 && <div className="crm-form-grid"><label className="crm-field crm-field--wide"><span>{collectMode === "persona" ? t.demand : collectMode === "hotspot" ? t.query : t.sourceLink}</span><textarea rows={collectMode === "persona" ? 6 : 3} value={collectInput} onChange={(event) => setCollectInput(event.target.value)} placeholder={collectMode === "persona" ? t.demandPlaceholder : collectMode === "hotspot" ? t.queryPlaceholder : t.sourceLinkPlaceholder} /></label><fieldset className="crm-wizard-fieldset crm-platform-fieldset"><legend>{t.platform}</legend><button className={platforms.threads ? "is-active" : ""} type="button" data-account-platform="threads" onClick={() => setPlatforms({ ...platforms, threads: !platforms.threads })}><PlatformLogo platform="threads" /><strong>{t.threads}</strong></button><button className={platforms.instagram ? "is-active" : ""} type="button" data-account-platform="instagram" disabled={collectMode === "hotspot"} onClick={() => setPlatforms({ ...platforms, instagram: !platforms.instagram })}><PlatformLogo platform="instagram" /><strong>{t.instagram}</strong></button></fieldset><label className="crm-field"><span>{t.limit}</span><input type="number" min="3" max="200" value={collectLimit} onChange={(event) => setCollectLimit(Math.max(3, Math.min(200, Number(event.target.value) || 30)))} /></label></div>}
        {view === "collect" && step === 3 && <div className="crm-wizard-review">
          {collectReviewPlatforms.map((platform) => <label className="crm-field" key={platform}><span>{t.account} · {platform === "threads" ? t.threads : t.instagram}</span><select value={collectAccountIds[platform]} onChange={(event) => setCollectAccountIds((current) => ({ ...current, [platform]: event.target.value }))}><option value="">{t.chooseAccount}</option>{accounts.filter((account) => String(account.platform || "").toLowerCase() === platform).map((account) => <option key={String(account.id)} value={String(account.id)} disabled={!accountReady(account)}>{account.display_name || account.username}{!accountReady(account) ? ` · ${t.accountLogin}` : ""}</option>)}</select></label>)}
          {keywordRows.length > 0 && <section><h3>{t.analysis} · {t.keywords}</h3><div className="crm-chip-row">{keywordRows.map((keyword) => <span key={keyword}>{keyword}</span>)}</div></section>}{resultRows.length > 0 && <section><h3>{t.results} · {t.selectedSources} {sourceSelection.size}</h3><p className="crm-wizard-note">{t.searchWarning}</p><div className="crm-wizard-results">{resultRows.map((row, index) => { const url = String(row.sourceUrl || row.source_url || row.url || ""); return <label key={url || index}><input type="checkbox" checked={sourceSelection.has(url)} onChange={() => setSourceSelection((current) => { const next = new Set(current); if (next.has(url)) next.delete(url); else next.add(url); return next; })} /><span><strong>{String(row.username || row.title || `#${index + 1}`)}</strong><small>{String(row.text || row.content || url).slice(0, 180)}</small></span></label>; })}</div></section>}{!keywordRows.length && !resultRows.length && <p className="crm-quiet-empty">{t.noResults}</p>}
        </div>}
        {view !== "collect" && step === 1 && renderPoolSelection()}
        {view !== "collect" && view !== "relationships" && step === 2 && <div className="crm-form-grid">{view === "public" && <fieldset className="crm-wizard-fieldset crm-field--wide"><legend>{t.publicMode}</legend>{([['public_comment', t.publicComment], ['public_reply', t.publicReply]] as Array<[PublicActionType, string]>).map(([mode, label]) => <label key={mode}><input type="radio" name="publicMode" checked={publicAction === mode} onChange={() => { setPublicAction(mode); setDrafts({}); }} />{label}</label>)}<small>{t.publicReplyHint} {language === "zh-Hant" ? "跟進與培育請從已確認任務的證據卡片發起。" : "跟进与培育请从已确认任务的证据卡片发起。"}</small></fieldset>}{view === "groups" && <fieldset className="crm-wizard-fieldset crm-platform-fieldset crm-field--wide"><legend>{t.groupMode}</legend><button className={groupMode === "threads" ? "is-active" : ""} type="button" data-account-platform="threads" onClick={() => setGroupMode("threads")}><PlatformLogo platform="threads" /><strong>{t.threadsPost}</strong></button><button className={groupMode === "instagram" ? "is-active" : ""} type="button" data-account-platform="instagram" disabled={capabilities?.instagram_group_management?.enabled !== true} onClick={() => setGroupMode("instagram")}><PlatformLogo platform="instagram" /><strong>{t.instagramDirect}</strong></button></fieldset>}<label className="crm-field crm-field--wide"><span>{t.template}</span><select value={templateId} onChange={(event) => selectTemplate(event.target.value)}><option value="">{t.chooseTemplate}</option>{templates.map((row) => <option key={rowId(row)} value={rowId(row)}>{String(row.name || rowId(row))}</option>)}</select></label><label className="crm-field crm-field--wide"><span>{t.content}</span><textarea rows={8} value={content} onChange={(event) => setContent(event.target.value)} placeholder={t.contentPlaceholder} /></label>{view === "outreach" && <label className="crm-field crm-field--wide"><span>{language === "zh-Hant" ? "追蹤目的地（選填）" : "追踪目的地（选填）"}</span><select value={destinationId} onChange={(event) => setDestinationId(event.target.value)}><option value="">{language === "zh-Hant" ? "不加入追蹤連結" : "不加入追踪链接"}</option>{destinations.map((row) => <option key={rowId(row)} value={rowId(row)}>{String(row.name || row.url || rowId(row))}</option>)}</select><small>{language === "zh-Hant" ? "選擇後會為每位客戶產生不同的安全連結。" : "选择后会为每位客户生成不同的安全链接。"}</small></label>}{view === "public" && publicAction === "public_comment" && <section className="crm-field--wide crm-wizard-drafts"><div><button className="crm-secondary-button" type="button" disabled={busy === "drafts"} onClick={() => void preparePublicDrafts()}>{busy === "drafts" ? t.aiDrafting : t.aiDrafts}</button><small>{t.aiDraftHint}</small></div>{selectedMembers.filter((row) => drafts[memberId(row)]).map((row) => <label className="crm-field" key={memberId(row)}><span>{t.draftFor} · @{memberUsername(row) || memberId(row)}</span><textarea rows={4} value={drafts[memberId(row)] || ""} onChange={(event) => setDrafts((current) => ({ ...current, [memberId(row)]: event.target.value }))} /></label>)}</section>}</div>}
        {view !== "collect" && ((view === "relationships" && step === 2) || (view !== "relationships" && step === 3)) && <div className="crm-form-grid"><label className="crm-field crm-field--wide"><span>{t.account}</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">{t.chooseAccount}</option>{supportedAccounts.map((account) => <option key={String(account.id)} value={String(account.id)} disabled={!accountReady(account)}>{account.display_name || account.username} · {account.platform}{!accountReady(account) ? ` · ${t.accountLogin}` : ""}</option>)}</select></label>{view !== "relationships" && <fieldset className="crm-wizard-fieldset crm-field--wide"><legend>{t.execution}</legend>{(["sample", "batch", "schedule"] as const).map((mode) => <label key={mode}><input type="radio" name="execution" checked={execution === mode} onChange={() => setExecution(mode)} /><span><strong>{t[mode]}</strong><small>{t[`${mode}Hint` as "sampleHint" | "batchHint" | "scheduleHint"]}</small></span></label>)}</fieldset>}{view !== "relationships" && execution === "schedule" && <label className="crm-field crm-field--wide"><span>{t.scheduleAt}</span><input type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} /></label>}</div>}
        {((view === "collect" && step === 3) || (view === "relationships" && step === 3) || (view !== "collect" && view !== "relationships" && step === 4)) && <section className="crm-confirmation-summary crm-wizard-confirmation">
          <h3>{t.confirmation}</h3>
          <dl><div><dt>{t.action}</dt><dd>{view === "public" ? messages.operationLabels[publicAction] : messages.views[view][0]}</dd></div><div><dt>{t.account}</dt><dd>{view === "collect" ? collectActions().map((action) => accounts.find((item) => String(item.id) === action.account_id)?.display_name || action.account_id).filter((name, index, all) => name && all.indexOf(name) === index).join("、") || messages.notSelected : selectedAccount?.display_name || selectedAccount?.username || messages.notSelected}</dd></div><div><dt>{t.targetRange}</dt><dd>{view === "collect" ? `${t[collectMode]} · ${collectActions().length}` : t.selected(effectiveRecipients.length)}</dd></div>{view !== "collect" && view !== "relationships" && <div><dt>{t.execution}</dt><dd>{t[execution]}{execution === "schedule" ? ` · ${new Date(scheduleAt).toLocaleString(language)}` : ""}</dd></div>}{content.trim() && <div><dt>{t.content}</dt><dd>{content.trim()}</dd></div>}{templateId && <div><dt>{t.template}</dt><dd>{String(templates.find((row) => rowId(row) === templateId)?.name || templateId)} · {arrayOf(templates.find((row) => rowId(row) === templateId)?.media_ids).length} {language === "zh-Hant" ? "個附件" : "个附件"}</dd></div>}<div><dt>{t.billing}</dt><dd>{isWrite ? t.billingWrite : t.billingRead}</dd></div></dl>
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
