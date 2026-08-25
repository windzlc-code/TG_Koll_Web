export function isTechnicalId(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /^\d{8,}$/.test(text)
    || /^(crm_|pool_|task_|phc_|persona-|wf_|act_|lead_|acct_)/i.test(text)
    || /^[0-9a-f]{16,}$/i.test(text)
    || /^[a-z]+_[a-z0-9]{5,}_/i.test(text)
    || /^[a-z]{2,}_[0-9a-z-]{8,}$/i.test(text);
}

export function isTechnicalKey(key: string) {
  return /^(id|task_id|pool_id|lead_id|account_id|content_hash|snapshot|payload|idempotency|preflight|sku|workflow_id|legacy_id|social_task_id|request_id)$/i.test(key)
    || /(^|_)id$/i.test(key)
    || /Id$/.test(key)
    || /_json$/i.test(key)
    || /Hash$/i.test(key);
}

export function humanText(value: unknown, fallback = "—"): string {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number" && Number.isFinite(value)) return new Intl.NumberFormat("zh-Hans").format(value);
  if (Array.isArray(value)) {
    if (!value.length) return fallback;
    if (value.every((item) => item && typeof item === "object")) return String(value.length);
    const parts = value.map((item) => humanText(item, "")).filter(Boolean).slice(0, 4);
    return parts.join(" · ") || String(value.length);
  }
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    return humanText(row.label || row.name || row.title || row.display_name || row.username, fallback);
  }
  const text = String(value).trim();
  if (text === "[object Object]" || isTechnicalId(text)) return fallback;
  return text;
}

export function metricLabel(key: string, language: "zh-Hans" | "zh-Hant") {
  const hant = language === "zh-Hant";
  const map: Record<string, [string, string]> = {
    completed: ["已完成", "已完成"],
    queued: ["排队中", "排隊中"],
    running: ["进行中", "進行中"],
    failed: ["失败", "失敗"],
    cancelled: ["已取消", "已取消"],
    manual_required: ["需要处理", "需要處理"],
    paused_by_policy: ["已暂停", "已暫停"],
    paused_by_user: ["已暂停", "已暫停"],
    awaiting_confirmation: ["待确认", "待確認"],
    unknown: ["待复核", "待複核"],
    confirmed: ["已确认", "已確認"],
    skipped: ["已跳过", "已跳過"],
    planned: ["已规划", "已規劃"],
    reserved: ["已预占", "已預占"],
    submitting: ["提交中", "提交中"],
    submitted: ["已提交", "已提交"],
    draft: ["草稿", "草稿"],
    direct_message: ["私信", "私訊"],
    public_comment: ["公开留言", "公開留言"],
    public_reply: ["公开回复", "公開回覆"],
    followup_reply: ["跟进回复", "跟進回覆"],
    threads_group_invite_post: ["群组邀请", "群組邀請"],
    collect: ["采集", "採集"],
    outreach: ["私信", "私訊"],
    public: ["公开互动", "公開互動"],
    groups: ["拉群", "拉群"],
    followup: ["跟进回复", "跟進回覆"],
    scheduled: ["定时任务", "定時任務"],
    relationship_verify: ["关系核验", "關係核驗"],
    discovered: ["已发现", "已發現"],
    pooled: ["已入池", "已入池"],
    reached: ["已触达", "已觸達"],
    converted: ["已转化", "已轉化"],
    new: ["新客户", "新客戶"],
    contacted: ["已触达", "已觸達"],
    qualified: ["高意向", "高意向"],
    instagram_group_status_inspect: ["复核群状态", "複核群狀態"],
    instagram_group_members_inspect: ["复核群成员", "複核群成員"],
    instagram_group_post: ["群内发帖", "群內發文"],
    instagram_group_settings_update: ["修改群名", "修改群名"],
    instagram_group_members_add: ["补充成员", "補充成員"],
    instagram_group_create: ["创建群聊", "建立群聊"],
    collect_profile: ["主页采集", "主頁採集"],
    collect_feed: ["信息流采集", "動態牆採集"],
    event: ["运营事件", "營運事件"],
    hotspot: ["热点", "熱點"],
    lead: ["客户", "客戶"],
    pool: ["客户池", "客戶池"],
    delivered: ["已送达", "已送達"],
    read: ["已读", "已讀"],
    replied: ["已回复", "已回覆"],
    engaged: ["已互动", "已互動"],
    clicked: ["已点击", "已點擊"],
    created: ["新建", "新建"],
    task_deleted: ["任务已删除", "任務已刪除"],
  };
  const pair = map[key];
  if (pair) return hant ? pair[1] : pair[0];
  if (/^[a-z0-9_]+$/i.test(key) && key.includes("_")) {
    const spaced = key.replace(/_/g, " ");
    return humanText(spaced, key);
  }
  return key;
}

export function workflowLabel(type: string, language: "zh-Hans" | "zh-Hant") {
  return metricLabel(String(type || "").trim(), language);
}

export function eventPreviewLabel(key: string, language: "zh-Hans" | "zh-Hant") {
  const hant = language === "zh-Hant";
  const normalized = String(key || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const map: Record<string, [string, string]> = {
    draft: ["草稿", "草稿"],
    public_comment_published: ["公开留言", "公開留言"],
    public_comment_submitted_unverified: ["公开留言", "公開留言"],
    public_comment_evidence_verified: ["公开留言已确认", "公開留言已確認"],
    public_comment_reply_monitor_started: ["公开回复监听", "公開回覆監聽"],
    public_reply_published: ["公开回复", "公開回覆"],
    engagement_touch_submitted: ["互动已提交", "互動已提交"],
    engagement_touch_published: ["互动已完成", "互動已完成"],
    engagement_touch_failed: ["互动失败", "互動失敗"],
    outreach_evidence_verified: ["私信已确认", "私訊已確認"],
    outreach_reply_monitor_started: ["私信回复监听", "私訊回覆監聽"],
    message_sent_verified: ["私信已确认", "私訊已確認"],
    group_post_verified: ["群组发帖已确认", "群組發文已確認"],
    legacy_tracking_click: ["链接点击", "連結點擊"],
    tracking_click: ["链接点击", "連結點擊"],
  };
  const pair = map[normalized];
  if (pair) return hant ? pair[1] : pair[0];
  const mapped = metricLabel(normalized, language);
  if (mapped && mapped !== normalized && !/[a-z]{4,}/i.test(mapped)) return mapped;
  if (normalized === "task_deleted" || normalized.includes("task_deleted")) return hant ? "任务已删除" : "任务已删除";
  if (normalized.includes("draft")) return hant ? "草稿" : "草稿";
  if (normalized.includes("failed") || normalized.endsWith("_fail")) return hant ? "失败" : "失败";
  if (normalized.includes("monitor")) return hant ? "回复监听" : "回复监听";
  if (normalized.includes("evidence") || normalized.includes("verified") || normalized.includes("confirmed") || normalized.includes("published")) {
    return hant ? "已确认" : "已确认";
  }
  if (normalized.includes("outreach") || normalized.includes("direct_message") || normalized.includes("dm_")) return hant ? "私信" : "私信";
  if (normalized.includes("group")) return hant ? "拉群" : "拉群";
  if (normalized.includes("collect") || normalized.includes("hotspot")) return hant ? "采集" : "采集";
  if (normalized.includes("public") || normalized.includes("engagement") || normalized.includes("comment") || normalized.includes("reply")) {
    return hant ? "公开互动" : "公开互动";
  }
  return "";
}

export function groupEventMix(entries: Array<[string, number]>, language: "zh-Hans" | "zh-Hant") {
  const counts = new Map<string, number>();
  for (const [key, count] of entries) {
    const label = eventPreviewLabel(key, language);
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + Number(count || 0));
  }
  return mixParts([...counts.entries()], language);
}

export function taskTitle(task: Record<string, unknown>, fallback: string, language: "zh-Hans" | "zh-Hant") {
  for (const candidate of [task.title, task.name, task.label, task.subject]) {
    const text = humanText(candidate, "");
    if (text && text !== "—") return text;
  }
  const kind = String(task.kind || task.workflow_type || task.type || "");
  if (kind) return workflowLabel(kind, language);
  return fallback;
}

export function mixTone(status = "") {
  const normalized = status.toLowerCase();
  if (["completed", "confirmed", "verified", "active", "ready", "healthy", "converted", "reached"].includes(normalized)) return "complete";
  if (["failed", "error", "cancelled", "blocked"].includes(normalized)) return "danger";
  if (["manual_required", "unknown", "needs_login", "warning"].includes(normalized)) return "warning";
  if (["running", "queued", "submitted", "pooled", "discovered", "contacted"].includes(normalized)) return "active";
  return "neutral";
}

export type MixPart = { key: string; label: string; count: number; percent: number };

export function mixParts(entries: Array<[string, number]>, language: "zh-Hans" | "zh-Hant"): MixPart[] {
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  return entries
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({
      key,
      label: metricLabel(key, language),
      count,
      percent: total ? Math.round((count / Math.max(total, 1)) * 100) : 0,
    }));
}

export function mixFromValues(values: unknown[], language: "zh-Hans" | "zh-Hant") {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = String(value || "").trim();
    if (!key || isTechnicalId(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return mixParts([...counts.entries()], language);
}

export function cronFriendly(cron: unknown, language: "zh-Hans" | "zh-Hant") {
  const hant = language === "zh-Hant";
  const fallback = hant ? "按計畫執行" : "按计划运行";
  const parts = String(cron || "").trim().split(/\s+/);
  if (parts.length < 5) return fallback;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const pad = (value: string) => value.padStart(2, "0");
  const clock = /^\d+$/.test(hour) && /^\d+$/.test(minute) ? `${pad(hour)}:${pad(minute)}` : "";
  const weekdays = hant
    ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
    : ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    if (minute.startsWith("*/") && hour === "*") {
      const every = minute.slice(2);
      return hant ? `每 ${every} 分鐘` : `每 ${every} 分钟`;
    }
    if (clock) return hant ? `每天 ${clock}` : `每天 ${clock}`;
  }
  if (dayOfMonth === "*" && month === "*" && /^\d+$/.test(dayOfWeek)) {
    const day = weekdays[Number(dayOfWeek) % 7];
    return clock ? `${day} ${clock}` : day;
  }
  return fallback;
}

export type InsightCard = { label: string; value: string };

export function poolInsightCards(
  detail: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  members: unknown[],
  tags: unknown[],
  language: "zh-Hans" | "zh-Hant",
): InsightCard[] {
  const hant = language === "zh-Hant";
  const leads = Array.isArray(snapshot.leads) ? snapshot.leads : [];
  const count = members.length || Number(detail.lead_count || snapshot.leadCount || snapshot.lead_count || leads.length) || 0;
  const category = humanText(
    snapshot.categoryLabel || snapshot.category_label || snapshot.business_name || snapshot.businessCategory || snapshot.business_category,
    "",
  );
  const cards: InsightCard[] = [];
  if (category) cards.push({ label: hant ? "業務類型" : "业务类型", value: category });
  cards.push({ label: hant ? "客戶數量" : "客户数量", value: String(count) });
  const tagText = (prefix: string) => {
    const hit = tags.map(String).find((tag) => tag.startsWith(prefix) || tag.startsWith(prefix.replace(":", "：")));
    return hit ? hit.split(/[:：]/).slice(1).join("：").replace(/\+/g, " / ").trim() : "";
  };
  const channel = tagText("渠道:") || tagText("渠道：") || humanText(snapshot.platforms || snapshot.channel, "");
  if (channel) cards.push({ label: "渠道", value: channel });
  const intent = tagText("意向:") || tagText("意向：");
  if (intent) cards.push({ label: hant ? "意向" : "意向", value: intent });
  const created = snapshot.createdAt || snapshot.created_at || detail.created_at;
  if (created) {
    const numeric = Number(created);
    const date = Number.isFinite(numeric) && numeric > 0
      ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
      : new Date(String(created));
    if (!Number.isNaN(date.getTime())) {
      cards.push({
        label: hant ? "建立時間" : "建立时间",
        value: new Intl.DateTimeFormat(hant ? "zh-Hant" : "zh-Hans", { dateStyle: "medium" }).format(date),
      });
    }
  }
  if (snapshot.deduplication && typeof snapshot.deduplication === "object") {
    cards.push({ label: hant ? "名單質量" : "名单质量", value: hant ? "已去重" : "已去重" });
  }
  return cards.slice(0, 6);
}

export function readableTags(tags: unknown[]) {
  return tags.map(String).filter((tag) => tag && !isTechnicalId(tag) && !/^id:/i.test(tag) && !isTechnicalKey(tag));
}

export function friendlyNotice(text: string) {
  return text
    .replace(/\s*[·•]\s*(crm_|pool_|task_|phc_|[0-9a-f]{12,}|\d{8,})[^\s]*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export const CHART_COLORS = ["#356b91", "#4b6478", "#253746", "#8a674d", "#9c5960", "#5c6f82", "#7b8a99"];

export function chartColor(index: number, tone = "") {
  if (tone === "complete") return "#356b91";
  if (tone === "active") return "#4b6478";
  if (tone === "warning") return "#8a674d";
  if (tone === "danger") return "#9c5960";
  if (tone === "neutral") return "#8b97a3";
  return CHART_COLORS[index % CHART_COLORS.length];
}

function dayKey(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  const numeric = typeof value === "number" || /^\d+$/.test(String(value)) ? Number(value) : NaN;
  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function dailyTrend(tasks: Array<Record<string, unknown>>, days = 14) {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const cursor = new Date(end);
    cursor.setDate(end.getDate() - offset);
    keys.push(cursor.toISOString().slice(0, 10));
  }
  const created: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
  const completed = { ...created };
  const failed = { ...created };
  for (const task of tasks) {
    const opened = dayKey(task.created_at || task.updated_at);
    if (opened && opened in created) created[opened] += 1;
    const status = String(task.status || "");
    const finished = dayKey(task.updated_at || task.created_at);
    if (finished && finished in completed) {
      if (status === "completed") completed[finished] += 1;
      if (status === "failed") failed[finished] += 1;
    }
  }
  return keys.map((date) => ({ date, created: created[date], completed: completed[date], failed: failed[date] }));
}
