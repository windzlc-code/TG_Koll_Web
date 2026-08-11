import { useCallback, useEffect, useMemo, useState } from "react";
import { CrmApiError, crmApi, payloadItems } from "./api";
import { Icon } from "./icons";
import type { Language } from "./types";

type Row = Record<string, unknown>;
type PageState = "loading" | "ready" | "error";

const labels = {
  "zh-Hans": {
    pools: "客户池", poolHint: "查看分组快照和池内客户，成员来自服务端客户池关联表。", poolDetails: "客户池详情", members: "池内客户",
    groups: "群组运营", groupHint: "创建 Threads 邀请帖或 Instagram Direct 群聊，并在同一工作台复核状态、发帖、改名和补充成员。", newGroup: "创建群组流程", noGroups: "尚无已验证群组", groupMembers: "群成员", inspectStatus: "复核状态", inspectMembers: "复核成员", groupPost: "群内发帖", renameGroup: "修改群名", addMembers: "补充成员", manageGroup: "管理 Instagram 群组", conversationUrl: "Direct 会话", memberUsernames: "成员账号（最多 3 个，逗号分隔）", groupMessage: "群内消息", prepareAction: "执行预检", confirmAction: "确认并执行", actionPrepared: "预检完成，请再次确认目标和扣点。", readQueued: "只读复核任务已进入队列", writeQueued: "群组动作已进入队列", instagramUnavailable: "Instagram 群组管理尚未通过当前运行环境能力检查。",
    noPools: "尚无客户池", choosePool: "选择一个客户池查看成员", noMembers: "该客户池尚无成员", member: "客户", platform: "平台", stage: "阶段", score: "评分", source: "来源", tags: "标签", editPool: "编辑客户池", poolName: "客户池名称", poolTags: "标签（逗号或换行分隔）", savePool: "保存名称与标签", deduplicate: "检查并移除重复成员", deduplicated: "已完成成员去重", removed: "移除重复", opcHistory: "OPC 历史客户", opcHint: "先预览筛选结果，再导入为新的客户池。", searchHistory: "搜索账号、内容或关键词", keywords: "关键词（逗号分隔）", allPlatforms: "全部平台", allContacts: "全部状态", newContact: "全新名单", contacted: "已触达", failed: "失败重试", preview: "预览匹配客户", previewing: "正在查询…", matched: "匹配客户", excludeExisting: "排除已在客户池中的账号", excludeInteracted: "排除已有互动记录", importPool: "导入为客户池", importing: "正在导入…", imported: "历史客户已导入",
    templates: "消息模板", templateHint: "编辑可复用内容并关联已验证的媒体文件。", newTemplate: "新建模板", name: "名称", type: "类型", locale: "语言", content: "内容", defaultTemplate: "设为默认模板", media: "模板媒体", upload: "上传媒体", uploading: "正在上传…", save: "保存模板", saving: "正在保存…", edit: "编辑", delete: "删除", deleteConfirm: "确认删除这条记录？此操作会保留审计记录。", deleted: "记录已删除", noTemplates: "尚无模板", saved: "模板已保存", uploaded: "媒体已上传",
    destinations: "追踪目的地", destinationHint: "配置私信与活动使用的 HTTPS 白名单目的地；停用后旧链接不再跳转。", newDestination: "新增目的地", destinationUrl: "HTTPS 地址", noDestinations: "尚无追踪目的地",
    schedules: "自动排程", scheduleHint: "排程必须从完整客户、账号和动作流程创建；立即运行会重新预检。", newSchedule: "新建排程", workflowType: "工作流类型", cron: "Cron 表达式", timezone: "时区", enabled: "已启用", disabled: "已停用", nextRun: "下次运行", lastRun: "上次运行", createSchedule: "配置完整排程", runNow: "立即运行", running: "正在提交…", enable: "启用", disable: "停用", noSchedules: "尚无排程", taskCreated: "已创建父流程", stop: "安全停止", preflight: "执行预检", confirmRun: "确认并立即运行", preflightHint: "核对可执行目标和预计扣点后再运行。", allowed: "可执行", skipped: "跳过", points: "预计扣点", scheduleMissingActions: "该排程没有完整动作快照，请重新创建。",
    analytics: "运营分析", analyticsHint: "所有指标来自 CRM 事件、动作账本和父流程状态，不使用前端估算。", workflowStatuses: "任务状态", eventTypes: "事件类型", actionStates: "平台动作状态", confirmedActions: "已确认动作类型", funnel: "互动转化漏斗", totalWorkflows: "工作流总数", totalEvents: "事件总数", totalConfirmed: "已确认平台动作", noAnalytics: "尚无可分析的数据",
    refresh: "刷新", retry: "重试", loading: "正在读取…", loadMore: "加载更多", close: "关闭", cancel: "取消", required: "请填写必填字段", requestFailed: "请求失败", selectFile: "选择 JPG、PNG、WebP 或 GIF，最大容量由服务端验证。", active: "有效", unknown: "未知", status: "状态",
  },
  "zh-Hant": {
    pools: "客戶池", poolHint: "查看分組快照和池內客戶，成員來自服務端客戶池關聯表。", poolDetails: "客戶池詳情", members: "池內客戶",
    groups: "群組營運", groupHint: "建立 Threads 邀請貼文或 Instagram Direct 群聊，並在同一工作台複核狀態、發文、改名和補充成員。", newGroup: "建立群組流程", noGroups: "尚無已驗證群組", groupMembers: "群成員", inspectStatus: "複核狀態", inspectMembers: "複核成員", groupPost: "群內發文", renameGroup: "修改群名", addMembers: "補充成員", manageGroup: "管理 Instagram 群組", conversationUrl: "Direct 會話", memberUsernames: "成員帳號（最多 3 個，逗號分隔）", groupMessage: "群內訊息", prepareAction: "執行預檢", confirmAction: "確認並執行", actionPrepared: "預檢完成，請再次確認目標和扣點。", readQueued: "唯讀複核任務已進入佇列", writeQueued: "群組動作已進入佇列", instagramUnavailable: "Instagram 群組管理尚未通過目前執行環境能力檢查。",
    noPools: "尚無客戶池", choosePool: "選擇一個客戶池查看成員", noMembers: "該客戶池尚無成員", member: "客戶", platform: "平台", stage: "階段", score: "評分", source: "來源", tags: "標籤", editPool: "編輯客戶池", poolName: "客戶池名稱", poolTags: "標籤（逗號或換行分隔）", savePool: "儲存名稱與標籤", deduplicate: "檢查並移除重複成員", deduplicated: "已完成成員去重", removed: "移除重複", opcHistory: "OPC 歷史客戶", opcHint: "先預覽篩選結果，再匯入為新的客戶池。", searchHistory: "搜尋帳號、內容或關鍵詞", keywords: "關鍵詞（逗號分隔）", allPlatforms: "全部平台", allContacts: "全部狀態", newContact: "全新名單", contacted: "已觸達", failed: "失敗重試", preview: "預覽匹配客戶", previewing: "正在查詢…", matched: "匹配客戶", excludeExisting: "排除已在客戶池中的帳號", excludeInteracted: "排除已有互動記錄", importPool: "匯入為客戶池", importing: "正在匯入…", imported: "歷史客戶已匯入",
    templates: "訊息範本", templateHint: "編輯可重用內容並關聯已驗證的媒體檔案。", newTemplate: "新增範本", name: "名稱", type: "類型", locale: "語言", content: "內容", defaultTemplate: "設為預設範本", media: "範本媒體", upload: "上傳媒體", uploading: "正在上傳…", save: "儲存範本", saving: "正在儲存…", edit: "編輯", delete: "刪除", deleteConfirm: "確認刪除這筆記錄？系統會保留稽核記錄。", deleted: "記錄已刪除", noTemplates: "尚無範本", saved: "範本已儲存", uploaded: "媒體已上傳",
    destinations: "追蹤目的地", destinationHint: "設定私訊與活動使用的 HTTPS 白名單目的地；停用後舊連結不再跳轉。", newDestination: "新增目的地", destinationUrl: "HTTPS 位址", noDestinations: "尚無追蹤目的地",
    schedules: "自動排程", scheduleHint: "排程必須從完整客戶、帳號和動作流程建立；立即執行會重新預檢。", newSchedule: "新增排程", workflowType: "工作流類型", cron: "Cron 表達式", timezone: "時區", enabled: "已啟用", disabled: "已停用", nextRun: "下次執行", lastRun: "上次執行", createSchedule: "配置完整排程", runNow: "立即執行", running: "正在提交…", enable: "啟用", disable: "停用", noSchedules: "尚無排程", taskCreated: "已建立父流程", stop: "安全停止", preflight: "執行預檢", confirmRun: "確認並立即執行", preflightHint: "核對可執行目標和預計扣點後再執行。", allowed: "可執行", skipped: "跳過", points: "預計扣點", scheduleMissingActions: "該排程沒有完整動作快照，請重新建立。",
    analytics: "營運分析", analyticsHint: "所有指標來自 CRM 事件、動作帳本和父流程狀態，不使用前端估算。", workflowStatuses: "任務狀態", eventTypes: "事件類型", actionStates: "平台動作狀態", confirmedActions: "已確認動作類型", funnel: "互動轉化漏斗", totalWorkflows: "工作流總數", totalEvents: "事件總數", totalConfirmed: "已確認平台動作", noAnalytics: "尚無可分析的資料",
    refresh: "重新整理", retry: "重試", loading: "正在讀取…", loadMore: "載入更多", close: "關閉", cancel: "取消", required: "請填寫必填欄位", requestFailed: "請求失敗", selectFile: "選擇 JPG、PNG、WebP 或 GIF，最大容量由服務端驗證。", active: "有效", unknown: "未知", status: "狀態",
  },
} as const;

function errorText(error: unknown, language: Language) {
  if (error instanceof CrmApiError) return error.body.message || error.body.message_key || error.body.code || `${labels[language].requestFailed} (${error.status})`;
  return error instanceof Error ? error.message : labels[language].requestFailed;
}

function idOf(row: Row) { return String(row.id || row.pool_id || row.task_id || ""); }
function textOf(value: unknown, fallback = "—") { return value === null || value === undefined || value === "" ? fallback : String(value); }
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

function PageHeader({ title, hint, language, onRefresh, action }: { title: string; hint: string; language?: Language; onRefresh: () => void; action?: React.ReactNode }) {
  const resolvedLanguage = language || (document.documentElement.lang === "zh-Hant" ? "zh-Hant" : "zh-Hans");
  return <div className="crm-panel-head crm-business-head"><div><span className="crm-kicker">CRM</span><h2>{title}</h2><p>{hint}</p></div><div className="crm-business-actions"><button className="crm-secondary-button" type="button" onClick={onRefresh}><Icon name="refresh" />{labels[resolvedLanguage].refresh}</button>{action}</div></div>;
}

function Loading({ language }: { language: Language }) { return <div className="crm-list-skeleton" aria-live="polite"><span>{labels[language].loading}</span><i /><i /><i /></div>; }
function ErrorBox({ error, language, retry }: { error: string; language: Language; retry: () => void }) { return <div className="crm-inline-error" role="alert"><Icon name="warning" /><span>{error}</span><button type="button" onClick={retry}><Icon name="refresh" />{labels[language].retry}</button></div>; }

export function PoolsView({ language }: { language: Language }) {
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
  const snapshot = objectOf(detail?.snapshot ?? detail?.snapshot_json);
  const tags = arrayOf(detail?.tags ?? detail?.tags_json);
  const splitValues = (value: string) => [...new Set(value.split(/[，,\n]/).map((item) => item.trim()).filter(Boolean))];
  const savePool = async () => {
    if (!selectedId || poolDraft.name.trim().length < 2) { setError(t.required); return; }
    setBusy("save-pool"); setError("");
    try { await crmApi.updateResource("pools", selectedId, { name: poolDraft.name.trim(), tags: splitValues(poolDraft.tags) }); setNotice(t.saved); await Promise.all([loadPools(), loadPool(selectedId)]); }
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
  const previewOpc = async () => {
    setBusy("opc-preview"); setError("");
    try { const result = await crmApi.queryOpcHistory(opcPayload()); setOpcRows(arrayOf(result.data).filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item)))); setOpcTotal(Number(result.total || 0)); }
    catch (next) { setError(errorText(next, language)); }
    finally { setBusy(""); }
  };
  const importOpc = async () => {
    if (opcTotal === null || opcTotal < 1 || opcFilter.category.trim().length < 2) { setError(t.required); return; }
    setBusy("opc-import"); setError("");
    try {
      const result = await crmApi.importOpcHistory({ ...opcPayload(), idempotencyKey: `crm-opc-import:${window.crypto.randomUUID()}`, tags: splitValues(opcFilter.keywords) });
      const pool = objectOf(result.pool); const importedId = idOf(pool); setNotice(`${t.imported} · ${Number(result.importedCount || pool.leadCount || 0)}`); setOpcOpen(false); setOpcRows([]); setOpcTotal(null); await loadPools(); if (importedId) setSelectedId(importedId);
    } catch (next) { setError(errorText(next, language)); }
    finally { setBusy(""); }
  };

  return <section className="crm-panel crm-business-panel" aria-busy={state === "loading" || detailState === "loading"}>
    <PageHeader title={t.pools} hint={t.poolHint} language={language} onRefresh={loadPools} action={<button className="crm-primary-button" type="button" onClick={() => setOpcOpen((current) => !current)}>{t.opcHistory}</button>} />
    {error && <ErrorBox error={error} language={language} retry={loadPools} />}{notice && <div className="crm-success-note" role="status"><Icon name="check" />{notice}</div>}
    {opcOpen && <section className="crm-opc-history" aria-labelledby="crmOpcHistoryTitle"><header><div><span className="crm-kicker">OPC</span><h3 id="crmOpcHistoryTitle">{t.opcHistory}</h3><p>{t.opcHint}</p></div><button className="crm-icon-button" type="button" aria-label={t.close} onClick={() => setOpcOpen(false)}><Icon name="close" /></button></header><div className="crm-form-grid"><label className="crm-field crm-field--wide"><span>{t.searchHistory}</span><input value={opcFilter.search} onChange={(event) => setOpcFilter({ ...opcFilter, search: event.target.value })} /></label><label className="crm-field"><span>{t.keywords}</span><input value={opcFilter.keywords} onChange={(event) => setOpcFilter({ ...opcFilter, keywords: event.target.value })} /></label><label className="crm-field"><span>{t.platform}</span><select value={opcFilter.platform} onChange={(event) => setOpcFilter({ ...opcFilter, platform: event.target.value })}><option value="">{t.allPlatforms}</option><option value="threads">Threads</option><option value="instagram">Instagram</option></select></label><label className="crm-field"><span>{t.status}</span><select value={opcFilter.contact} onChange={(event) => setOpcFilter({ ...opcFilter, contact: event.target.value })}><option value="">{t.allContacts}</option><option value="new">{t.newContact}</option><option value="contacted">{t.contacted}</option><option value="failed">{t.failed}</option></select></label><label className="crm-field"><span>{t.poolName}</span><input value={opcFilter.category} onChange={(event) => setOpcFilter({ ...opcFilter, category: event.target.value })} /></label><label className="crm-consent"><input type="checkbox" checked={opcFilter.excludeExisting} onChange={(event) => setOpcFilter({ ...opcFilter, excludeExisting: event.target.checked })} /><span>{t.excludeExisting}</span></label><label className="crm-consent"><input type="checkbox" checked={opcFilter.excludeInteracted} onChange={(event) => setOpcFilter({ ...opcFilter, excludeInteracted: event.target.checked })} /><span>{t.excludeInteracted}</span></label></div><div className="crm-inline-actions"><button className="crm-secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void previewOpc()}>{busy === "opc-preview" ? t.previewing : t.preview}</button><button className="crm-primary-button" type="button" disabled={opcTotal === null || opcTotal < 1 || Boolean(busy)} onClick={() => void importOpc()}>{busy === "opc-import" ? t.importing : t.importPool}</button></div>{opcTotal !== null && <div className="crm-opc-summary" role="status"><strong>{t.matched} · {opcTotal}</strong><span>{opcRows.slice(0, 8).map((row) => `@${textOf(row.username)}`).join(" · ") || t.noMembers}</span></div>}</section>}
    {state === "loading" && <Loading language={language} />}
    {state === "error" && <ErrorBox error={error} language={language} retry={loadPools} />}
    {state === "ready" && !pools.length && <div className="crm-empty"><Icon name="pools" /><strong>{t.noPools}</strong></div>}
    {state === "ready" && pools.length > 0 && <div className="crm-split-workspace">
      <nav className="crm-master-list" aria-label={t.pools}>{pools.map((pool) => <button className={selectedId === idOf(pool) ? "is-active" : ""} type="button" key={idOf(pool)} onClick={() => setSelectedId(idOf(pool))}><strong>{textOf(pool.name)}</strong><small>{textOf(pool.description, t.choosePool)}</small></button>)}</nav>
      <div className="crm-detail-pane">
        {detailState === "loading" && <Loading language={language} />}
        {detailState === "error" && <ErrorBox error={error} language={language} retry={() => void loadPool(selectedId)} />}
        {detailState === "ready" && detail && <>
          <header className="crm-detail-heading"><div><span className="crm-kicker">{t.poolDetails}</span><h3>{textOf(detail.name)}</h3><p>{textOf(detail.description, t.choosePool)}</p></div>{tags.length > 0 && <div className="crm-chip-row">{tags.map((tag) => <span key={String(tag)}>{String(tag)}</span>)}</div>}</header>
          <div className="crm-pool-editor"><label className="crm-field"><span>{t.poolName}</span><input value={poolDraft.name} onChange={(event) => setPoolDraft({ ...poolDraft, name: event.target.value })} /></label><label className="crm-field crm-field--wide"><span>{t.poolTags}</span><input value={poolDraft.tags} onChange={(event) => setPoolDraft({ ...poolDraft, tags: event.target.value })} /></label><div className="crm-inline-actions"><button className="crm-primary-button" type="button" disabled={Boolean(busy)} onClick={() => void savePool()}>{busy === "save-pool" ? t.saving : t.savePool}</button><button className="crm-secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void deduplicate()}>{busy === "deduplicate" ? t.loading : t.deduplicate}</button></div></div>
          {Object.keys(snapshot).length > 0 && <dl className="crm-summary-grid">{Object.entries(snapshot).slice(0, 6).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{textOf(value)}</dd></div>)}</dl>}
          <h3 className="crm-section-title">{t.members} <span>{members.length}</span></h3>
          {!members.length ? <p className="crm-quiet-empty">{t.noMembers}</p> : <div className="crm-table-scroll"><table className="crm-data-table"><thead><tr><th>{t.member}</th><th>{t.platform}</th><th>{t.stage}</th><th>{t.score}</th><th>{t.source}</th></tr></thead><tbody>{members.map((member, index) => { const lead = objectOf(member.lead || member.profile); return <tr key={String(member.lead_id || member.id || index)}><td><strong>{textOf(member.display_name || lead.display_name || member.username || lead.username)}</strong><small>{textOf(member.username || lead.username, "")}</small></td><td>{textOf(member.platform || lead.platform)}</td><td>{textOf(member.stage || lead.stage || member.status)}</td><td>{textOf(member.score ?? lead.score)}</td><td>{textOf(member.source)}</td></tr>; })}</tbody></table></div>}
          {memberCursor && <div className="crm-pagination"><button className="crm-secondary-button" type="button" onClick={() => void loadPool(selectedId, memberCursor)}>{t.loadMore}</button></div>}
        </>}
      </div>
    </div>}
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
      const result = await crmApi.createWorkflow({ workflow_type: "groups", title: `${t.groups} · ${actionType}`, idempotency_key: `crm-group-read:${actionType}:${idOf(row)}:${window.crypto.randomUUID()}`, input: { group_id: idOf(row) }, actions: [actionFor(row, actionType)], confirmed: true });
      setNotice(`${t.readQueued}${result.task_id ? ` · ${result.task_id}` : ""}`);
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
      const result = await crmApi.createWorkflow({ workflow_type: "groups", title: `${t.groups} · ${operation}`, idempotency_key: `crm-group-write:${operation}:${idOf(editing)}:${window.crypto.randomUUID()}`, input: { group_id: idOf(editing) }, actions, preflight_token: preflight.preflight_token, confirmed: true });
      setNotice(`${t.writeQueued}${result.task_id ? ` · ${result.task_id}` : ""}`); setEditing(null); setPreflight(null); setConfirmed(false);
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
    {state === "ready" && groups.length > 0 && <div className="crm-template-grid">{groups.map((row) => { const instagram = String(row.platform || "").toLowerCase() === "instagram"; const id = idOf(row); return <article className="crm-template-card" key={id}><header><div><strong>{textOf(row.name, `${t.groups} · ${id}`)}</strong><small>{textOf(row.platform)} · {textOf(row.status)}</small></div><span className="crm-chip">{t.groupMembers}: {groupMembers(row).length}</span></header><p>{groupTarget(row) || "—"}</p>{groupMembers(row).length > 0 && <div className="crm-chip-row">{groupMembers(row).slice(0, 8).map((member) => <span key={member}>@{member}</span>)}</div>}<footer className="crm-inline-actions"><button type="button" disabled={!instagram || !instagramEnabled || Boolean(busy)} onClick={() => void queueRead(row, "instagram_group_status_inspect")}>{t.inspectStatus}</button><button type="button" disabled={!instagram || !instagramEnabled || !groupMembers(row).length || Boolean(busy)} onClick={() => void queueRead(row, "instagram_group_members_inspect")}>{t.inspectMembers}</button><button type="button" disabled={!instagram || !instagramEnabled} onClick={() => openManage(row, "instagram_group_post")}>{t.groupPost}</button><button type="button" disabled={!instagram || !instagramEnabled} onClick={() => openManage(row, "instagram_group_settings_update")}>{t.renameGroup}</button><button type="button" disabled={!instagram || !instagramEnabled} onClick={() => openManage(row, "instagram_group_members_add")}>{t.addMembers}</button></footer></article>; })}</div>}
    {editing && <div className="crm-editor-sheet" role="dialog" aria-modal="true" aria-labelledby="crm-group-editor"><div className="crm-editor-head"><h3 id="crm-group-editor">{t.manageGroup}</h3><button className="crm-icon-button" type="button" aria-label={t.close} onClick={() => setEditing(null)}><Icon name="close" /></button></div><dl className="crm-summary-grid"><div><dt>{t.name}</dt><dd>{textOf(editing.name)}</dd></div><div><dt>{t.conversationUrl}</dt><dd>{groupTarget(editing)}</dd></div></dl><label className="crm-field"><span>{operation === "instagram_group_members_add" ? t.memberUsernames : operation === "instagram_group_settings_update" ? t.renameGroup : t.groupMessage}</span>{operation === "instagram_group_post" ? <textarea rows={5} value={value} onChange={(event) => { setValue(event.target.value); setPreflight(null); setConfirmed(false); }} /> : <input value={value} onChange={(event) => { setValue(event.target.value); setPreflight(null); setConfirmed(false); }} />}</label>{preflight && <div className="crm-preflight-review" role="status"><dl><div><dt>{t.allowed}</dt><dd>{preflight.allowed_count ?? preflight.actions?.length ?? 0}</dd></div><div><dt>{t.skipped}</dt><dd>{(preflight.blocked_count ?? 0) + (preflight.duplicate_count ?? 0)}</dd></div><div><dt>{t.points}</dt><dd>{preflight.quote?.total_points ?? 0}</dd></div></dl><label className="crm-consent"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{t.preflightHint}</span></label></div>}<div className="crm-modal-actions"><button className="crm-secondary-button" type="button" onClick={() => setEditing(null)}>{t.cancel}</button><button className="crm-primary-button" type="button" disabled={Boolean(busy) || (preflight ? !confirmed : !value.trim())} onClick={() => void (preflight ? submit() : prepare())}>{preflight ? t.confirmAction : t.prepareAction}</button></div></div>}
  </section>;
}

type TemplateDraft = { id: string; name: string; template_type: string; locale: string; content: string; media_ids: string[]; is_default: boolean };
const emptyTemplate = (language: Language): TemplateDraft => ({ id: "", name: "", template_type: "message", locale: language, content: "", media_ids: [], is_default: false });

export function TemplatesView({ language }: { language: Language }) {
  const t = labels[language];
  const [templates, setTemplates] = useState<Row[]>([]);
  const [state, setState] = useState<PageState>("loading");
  const [draft, setDraft] = useState<TemplateDraft>(() => emptyTemplate(language));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => { setState("loading"); setError(""); try { setTemplates(payloadItems(await crmApi.list("templates", "", 200))); setState("ready"); } catch (next) { setError(errorText(next, language)); setState("error"); } }, [language]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!editing) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = document.querySelector<HTMLElement>(".crm-editor-sheet");
    node?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditing(false);
      if (event.key !== "Tab" || !node) return;
      const focusable = [...node.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [editing]);
  const edit = (row?: Row) => {
    setDraft(row ? { id: idOf(row), name: textOf(row.name, ""), template_type: textOf(row.template_type, "message"), locale: textOf(row.locale, language), content: textOf(row.content, ""), media_ids: arrayOf(row.media_ids ?? row.media_ids_json).map(String), is_default: Boolean(row.is_default) } : emptyTemplate(language));
    setEditing(true); setError(""); setNotice("");
  };
  const upload = async (file?: File) => {
    if (!file) return; setBusy("upload"); setError("");
    try { const media = await crmApi.uploadMedia(file); const mediaId = idOf(media); if (mediaId) setDraft((current) => ({ ...current, media_ids: [...new Set([...current.media_ids, mediaId])] })); setNotice(t.uploaded); }
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
    const id = idOf(row); if (!id || !window.confirm(t.deleteConfirm)) return;
    setBusy(`delete:${id}`); setError("");
    try { await crmApi.deleteResource("templates", id); setNotice(t.deleted); await load(); }
    catch (next) { setError(errorText(next, language)); }
    finally { setBusy(""); }
  };
  return <section className="crm-panel crm-business-panel">
    <PageHeader title={t.templates} hint={t.templateHint} language={language} onRefresh={load} action={<button className="crm-primary-button" type="button" onClick={() => edit()}>{t.newTemplate}</button>} />
    {error && <ErrorBox error={error} language={language} retry={load} />}{notice && <div className="crm-success-note" role="status"><Icon name="check" />{notice}</div>}
    {state === "loading" && <Loading language={language} />}{state === "ready" && !templates.length && <p className="crm-quiet-empty">{t.noTemplates}</p>}
    {state === "ready" && templates.length > 0 && <div className="crm-template-grid">{templates.map((item) => <article key={idOf(item)} className="crm-template-card"><header><div><strong>{textOf(item.name)}</strong><small>{textOf(item.template_type)} · {textOf(item.locale)}</small></div>{Boolean(item.is_default) && <span className="crm-chip">{t.defaultTemplate}</span>}</header><p>{textOf(item.content)}</p><footer><span>{t.media}: {arrayOf(item.media_ids ?? item.media_ids_json).length}</span><span className="crm-inline-actions"><button className="crm-secondary-button" type="button" onClick={() => edit(item)}>{t.edit}</button><button type="button" disabled={busy === `delete:${idOf(item)}`} onClick={() => void remove(item)}>{t.delete}</button></span></footer></article>)}</div>}
    {editing && <div className="crm-editor-sheet" role="dialog" aria-modal="true" aria-labelledby="crm-template-editor"><div className="crm-editor-head"><h3 id="crm-template-editor">{draft.id ? t.edit : t.newTemplate}</h3><button className="crm-icon-button" type="button" aria-label={t.close} onClick={() => setEditing(false)}><Icon name="close" /></button></div><div className="crm-form-grid"><label className="crm-field"><span>{t.name}</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label className="crm-field"><span>{t.type}</span><select value={draft.template_type} onChange={(event) => setDraft({ ...draft, template_type: event.target.value })}><option value="message">message</option><option value="comment">comment</option><option value="reply">reply</option><option value="group_invite">group_invite</option></select></label><label className="crm-field"><span>{t.locale}</span><select value={draft.locale} onChange={(event) => setDraft({ ...draft, locale: event.target.value })}><option value="zh-Hans">简体中文</option><option value="zh-Hant">繁體中文</option></select></label><label className="crm-field crm-field--wide"><span>{t.content}</span><textarea rows={8} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label><label className="crm-file-field crm-field--wide"><span>{t.media}</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={busy === "upload"} onChange={(event) => { void upload(event.target.files?.[0]); event.currentTarget.value = ""; }} /><small>{busy === "upload" ? t.uploading : t.selectFile}</small></label>{draft.media_ids.length > 0 && <div className="crm-chip-row crm-field--wide">{draft.media_ids.map((id) => <button type="button" key={id} onClick={() => setDraft((current) => ({ ...current, media_ids: current.media_ids.filter((item) => item !== id) }))}>{id} ×</button>)}</div>}<label className="crm-consent crm-field--wide"><input type="checkbox" checked={draft.is_default} onChange={(event) => setDraft({ ...draft, is_default: event.target.checked })} /><span>{t.defaultTemplate}</span></label></div><div className="crm-modal-actions"><button className="crm-secondary-button" type="button" onClick={() => setEditing(false)}>{t.cancel}</button><button className="crm-primary-button" type="button" disabled={Boolean(busy)} onClick={() => void save()}>{busy === "save" ? t.saving : t.save}</button></div></div>}
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
  const remove = async (row: Row) => { const id = idOf(row); if (!id || !window.confirm(t.deleteConfirm)) return; setBusy(`delete:${id}`); try { await crmApi.deleteResource("destinations", id); setNotice(t.deleted); await load(); } catch (next) { setError(errorText(next, language)); } finally { setBusy(""); } };
  return <section className="crm-panel crm-business-panel"><PageHeader title={t.destinations} hint={t.destinationHint} language={language} onRefresh={load} action={<button className="crm-primary-button" type="button" onClick={() => open()}>{t.newDestination}</button>} />
    {error && <ErrorBox error={error} language={language} retry={load} />}{notice && <div className="crm-success-note" role="status"><Icon name="check" />{notice}</div>}
    {state === "loading" && <Loading language={language} />}{state === "ready" && !rows.length && <p className="crm-quiet-empty">{t.noDestinations}</p>}
    {state === "ready" && rows.length > 0 && <div className="crm-template-grid">{rows.map((row) => <article className="crm-template-card" key={idOf(row)}><header><div><strong>{textOf(row.name)}</strong><small>{textOf(row.url)}</small></div><span className="crm-chip">{Boolean(row.enabled) ? t.enabled : t.disabled}</span></header><footer><span>HTTPS</span><span className="crm-inline-actions"><button type="button" onClick={() => open(row)}>{t.edit}</button><button type="button" disabled={busy === `delete:${idOf(row)}`} onClick={() => void remove(row)}>{t.delete}</button></span></footer></article>)}</div>}
    {editing && <div className="crm-editor-sheet" role="dialog" aria-modal="true" aria-labelledby="crm-destination-editor"><div className="crm-editor-head"><h3 id="crm-destination-editor">{draft.id ? t.edit : t.newDestination}</h3><button className="crm-icon-button" type="button" aria-label={t.close} onClick={() => setEditing(false)}><Icon name="close" /></button></div><div className="crm-form-grid"><label className="crm-field"><span>{t.name}</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label className="crm-field crm-field--wide"><span>{t.destinationUrl}</span><input type="url" placeholder="https://" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label><label className="crm-consent crm-field--wide"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>{t.enabled}</span></label></div><div className="crm-modal-actions"><button className="crm-secondary-button" type="button" onClick={() => setEditing(false)}>{t.cancel}</button><button className="crm-primary-button" type="button" disabled={Boolean(busy)} onClick={() => void save()}>{busy ? t.saving : t.save}</button></div></div>}
  </section>;
}

export function SchedulesView({ language, onCreate }: { language: Language; onCreate: (workflow: "public" | "outreach" | "groups") => void }) {
  const t = labels[language];
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<PageState>("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [workflowType, setWorkflowType] = useState<"public" | "outreach" | "groups">("public");
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
      setNotice(`${t.taskCreated}${result.task_id ? ` · ${result.task_id}` : ""}`); setPendingRun(null); setRunConfirmed(false); await load();
    } catch (next) { setError(errorText(next, language)); }
    finally { setBusy(""); }
  };
  const stop = async (row: Row) => { const id = idOf(row); setBusy(`stop:${id}`); setError(""); try { await crmApi.stopSchedule(id); setNotice(`${t.stop} · ${id}`); await load(); } catch (next) { setError(errorText(next, language)); } finally { setBusy(""); } };
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
    <div className="crm-schedule-create"><label className="crm-field"><span>{t.workflowType}</span><select value={workflowType} onChange={(event) => setWorkflowType(event.target.value as typeof workflowType)}><option value="public">public</option><option value="outreach">outreach</option><option value="groups">groups</option></select></label><p>{t.preflightHint}</p><button className="crm-primary-button" type="button" onClick={() => onCreate(workflowType)}>{t.createSchedule}</button></div>
    {pendingRun && <div className="crm-preflight-review crm-schedule-preflight" role="dialog" aria-modal="true" aria-labelledby="crmSchedulePreflightTitle"><header><span><Icon name="check" /><strong id="crmSchedulePreflightTitle">{t.preflight}</strong></span><button className="crm-icon-button" type="button" aria-label={t.close} onClick={() => setPendingRun(null)}><Icon name="close" /></button></header><dl><div><dt>{t.allowed}</dt><dd>{pendingRun.preflight.allowed_count ?? pendingRun.preflight.actions?.length ?? 0}</dd></div><div><dt>{t.skipped}</dt><dd>{(pendingRun.preflight.duplicate_count ?? 0) + (pendingRun.preflight.blocked_count ?? 0)}</dd></div><div><dt>{t.points}</dt><dd>{pendingRun.preflight.quote?.total_points ?? 0}</dd></div></dl><label className="crm-consent"><input type="checkbox" checked={runConfirmed} onChange={(event) => setRunConfirmed(event.target.checked)} /><span>{t.preflightHint}</span></label><div className="crm-inline-actions"><button className="crm-secondary-button" type="button" onClick={() => setPendingRun(null)}>{t.cancel}</button><button className="crm-primary-button" type="button" disabled={!runConfirmed || Boolean(busy)} onClick={() => void confirmRun()}>{t.confirmRun}</button></div></div>}
    {editingSchedule && <div className="crm-editor-sheet" role="dialog" aria-modal="true" aria-labelledby="crmScheduleEditor"><div className="crm-editor-head"><h3 id="crmScheduleEditor">{t.edit} · {textOf(editingSchedule.workflow_type)}</h3><button className="crm-icon-button" type="button" aria-label={t.close} onClick={() => setEditingSchedule(null)}><Icon name="close" /></button></div><label className="crm-field"><span>{t.nextRun}</span><input type="datetime-local" value={scheduleAt} onChange={(event) => setScheduleAt(event.target.value)} /></label><div className="crm-modal-actions"><button className="crm-secondary-button" type="button" onClick={() => setEditingSchedule(null)}>{t.cancel}</button><button className="crm-primary-button" type="button" disabled={Boolean(busy)} onClick={() => void saveSchedule()}>{t.save}</button></div></div>}
    {state === "loading" && <Loading language={language} />}{state === "ready" && !rows.length && <p className="crm-quiet-empty">{t.noSchedules}</p>}{state === "ready" && rows.length > 0 && <div className="crm-schedule-list">{rows.map((row) => { const id = idOf(row); const enabled = Boolean(row.enabled); return <article key={id}><div><strong>{textOf(row.workflow_type)}</strong><small>{textOf(row.cron_expression)} · {textOf(row.timezone)}</small></div><span className={`crm-status crm-status--${enabled ? "complete" : "default"}`}><i />{enabled ? t.enabled : t.disabled}</span><dl><div><dt>{t.nextRun}</dt><dd>{dateText(row.next_run_at, language)}</dd></div><div><dt>{t.lastRun}</dt><dd>{dateText(row.last_run_at, language)}</dd></div></dl><div className="crm-inline-actions"><button type="button" disabled={Boolean(busy)} onClick={() => void toggle(row)}>{enabled ? t.disable : t.enable}</button><button type="button" disabled={Boolean(busy)} onClick={() => editSchedule(row)}>{t.edit}</button><button type="button" disabled={Boolean(busy)} onClick={() => void prepareRun(row)}>{busy === `preflight:${id}` ? t.running : t.runNow}</button><button type="button" disabled={Boolean(busy)} onClick={() => void stop(row)}>{busy === `stop:${id}` ? t.running : t.stop}</button></div></article>; })}</div>}
  </section>;
}

function metricEntries(value: unknown): Array<[string, number]> {
  return Object.entries(objectOf(value)).map(([key, count]): [string, number] => [key, Number(count) || 0]).filter(([, count]) => count >= 0);
}
export function AnalyticsView({ language }: { language: Language }) {
  const t = labels[language]; const [state, setState] = useState<PageState>("loading"); const [data, setData] = useState<Row>({}); const [error, setError] = useState("");
  const load = useCallback(async () => { setState("loading"); setError(""); try { setData(await crmApi.analytics()); setState("ready"); } catch (next) { setError(errorText(next, language)); setState("error"); } }, [language]);
  useEffect(() => { void load(); }, [load]);
  const workflows = useMemo(() => metricEntries(data.workflow_statuses), [data.workflow_statuses]); const events = useMemo(() => metricEntries(data.event_types), [data.event_types]); const actionStates = useMemo(() => metricEntries(data.action_states), [data.action_states]); const confirmedActions = useMemo(() => metricEntries(data.confirmed_action_types), [data.confirmed_action_types]); const funnel = useMemo(() => metricEntries(data.funnel), [data.funnel]); const historicalFunnel = useMemo(() => metricEntries(data.historical_funnel), [data.historical_funnel]); const workflowTotal = workflows.reduce((sum, [, count]) => sum + count, 0); const eventTotal = events.reduce((sum, [, count]) => sum + count, 0); const confirmedTotal = confirmedActions.reduce((sum, [, count]) => sum + count, 0);
  const bars = (items: Array<[string, number]>) => { const max = Math.max(...items.map(([, count]) => count), 1); return <div className="crm-analytics-bars">{items.map(([key, count]) => <div key={key}><span><strong>{key}</strong><b>{count}</b></span><i><span style={{ width: `${(count / max) * 100}%` }} /></i></div>)}</div>; };
  return <section className="crm-panel crm-business-panel"><PageHeader title={t.analytics} hint={t.analyticsHint} onRefresh={load} />{state === "loading" && <Loading language={language} />}{state === "error" && <ErrorBox error={error} language={language} retry={load} />}{state === "ready" && <><div className="crm-analytics-totals"><div><span>{t.totalWorkflows}</span><strong>{workflowTotal}</strong></div><div><span>{t.totalEvents}</span><strong>{eventTotal}</strong></div><div><span>{t.totalConfirmed}</span><strong>{confirmedTotal}</strong></div></div>{!workflowTotal && !eventTotal && !actionStates.length ? <p className="crm-quiet-empty">{t.noAnalytics}</p> : <div className="crm-analytics-grid"><section><h3>{t.workflowStatuses}</h3>{bars(workflows)}</section><section><h3>{t.actionStates}</h3>{bars(actionStates)}</section><section><h3>{t.confirmedActions}</h3>{bars(confirmedActions)}</section><section><h3>{t.funnel}</h3>{bars(funnel)}</section>{historicalFunnel.length > 0 && <section><h3>{language === "zh-Hant" ? "歷史資料漏斗" : "历史数据漏斗"}</h3>{bars(historicalFunnel)}</section>}<section><h3>{t.eventTypes}</h3>{bars(events)}</section></div>}</>}</section>;
}

function evidenceUrl(value: unknown) {
  const raw = String(value || "").trim(); if (!raw) return "";
  try { const url = new URL(raw, window.location.origin); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
}
export function StructuredEvidence({ evidence, language }: { evidence: Row; language: Language }) {
  const t = labels[language]; const platformUrl = evidenceUrl(evidence.platform_url || evidence.url || evidence.post_url || evidence.target_url); const screenshotUrl = evidenceUrl(evidence.screenshot_url || evidence.screenshot || evidence.image_url);
  const fields = [[t.platform, evidence.platform], [t.member, evidence.username || evidence.target_username || evidence.target], [t.status, evidence.status || evidence.result], [t.source, evidence.confirmation_source || evidence.source], ["content_hash", evidence.content_hash], ["confirmed_at", evidence.confirmed_at || evidence.timestamp]] as Array<[string, unknown]>;
  const visible = fields.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!visible.length && !platformUrl && !screenshotUrl) return <pre>{JSON.stringify(evidence, null, 2)}</pre>;
  return <div className="crm-structured-evidence">{screenshotUrl && <a href={screenshotUrl} target="_blank" rel="noreferrer"><img src={screenshotUrl} alt={t.media} loading="lazy" /></a>}<dl>{visible.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{dateText(key === "confirmed_at" ? value : "", language) !== "—" && key === "confirmed_at" ? dateText(value, language) : textOf(value)}</dd></div>)}</dl>{platformUrl && <a className="crm-secondary-button" href={platformUrl} target="_blank" rel="noreferrer"><Icon name="external" />{t.active}</a>}</div>;
}
