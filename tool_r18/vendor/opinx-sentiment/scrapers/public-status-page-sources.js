/**
 * scrapers/public-status-page-sources.js - public service status discovery
 *
 * Collects no-key public status page incident and component degradation
 * signals. These often precede news or social discussion during SaaS,
 * ecommerce, payments, logistics, or app-service crises.
 */

import { isAfterSince } from "./filters.js";
import { mapWithConcurrency } from "./concurrency.js";
import { fetchPublicSource, formatSourceError, httpFailure, scraperResult } from "./http.js";
import { analyzeSentiment, assessRiskLevel, insertSentimentItem } from "../sentiment-store.js";

const USER_AGENT = "Mozilla/5.0 (compatible; BeibeiYingCraw/1.0)";
const REQUEST_TIMEOUT_MS = 12000;
const SEARCH_CONCURRENCY = 3;
const DEFAULT_MAX_ITEMS_PER_KEYWORD = 12;
const DEFAULT_MAX_TARGETS_PER_KEYWORD = 6;
const HEALTHY_COMPONENT_STATUSES = new Set(["operational"]);
const HEALTHY_PAGE_INDICATORS = new Set(["none", "operational"]);
const INCIDENT_TERMS = [
  "outage",
  "incident",
  "degraded",
  "partial outage",
  "major outage",
  "disruption",
  "maintenance",
  "investigating",
  "identified",
  "monitoring",
  "resolved",
  "service unavailable",
  "latency",
  "error",
  "failed",
  "failure",
  "服务中断",
  "服務中斷",
  "故障",
  "宕机",
  "宕機",
  "延迟",
  "延遲",
  "维护",
  "維護",
];

function cleanText(value = "", max = 1200) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeBudget(budget = {}) {
  const maxItems = Math.round(Number(budget.maxItemsPerKeyword || budget.max_items_per_keyword || DEFAULT_MAX_ITEMS_PER_KEYWORD));
  const maxTargets = Math.round(Number(budget.maxTargetsPerKeyword || budget.max_targets_per_keyword || DEFAULT_MAX_TARGETS_PER_KEYWORD));
  return {
    maxItemsPerKeyword: Number.isFinite(maxItems) ? Math.max(1, Math.min(30, maxItems)) : DEFAULT_MAX_ITEMS_PER_KEYWORD,
    maxTargetsPerKeyword: Number.isFinite(maxTargets) ? Math.max(1, Math.min(10, maxTargets)) : DEFAULT_MAX_TARGETS_PER_KEYWORD,
  };
}

function normalizeDate(value = "") {
  const time = new Date(value || "").getTime();
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

function keywordNeedles(keyword = "") {
  const raw = cleanText(keyword, 180);
  const compact = normalizeStatusPageKeywordText(raw);
  const words = raw
    .split(/[\s,;|/()[\]{}"'`~!@#$%^&*_+=:：，。！？、-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2);
  return [...new Set([raw, compact, ...words].filter(Boolean).map(item => String(item).toLowerCase()))].slice(0, 12);
}

function normalizeStatusPageKeywordText(value = "") {
  return cleanText(value, 1600)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "");
}

function textMatchesKeyword(text = "", keyword = "") {
  const lower = cleanText(text, 1600).toLowerCase();
  const compact = normalizeStatusPageKeywordText(text);
  return keywordNeedles(keyword).some(needle => {
    const normalized = normalizeStatusPageKeywordText(needle);
    return needle.length >= 2 && (lower.includes(needle) || (normalized.length >= 2 && compact.includes(normalized)));
  });
}

function statusPageKeywordMatchSource(item = {}, keyword = "") {
  const metrics = item.metrics || {};
  const fields = [
    ["title", item.title],
    ["content", item.content],
    ["page_name", metrics.status_page_name],
    ["component", metrics.status_page_component_name],
    ["incident_status", metrics.status_page_incident_status],
    ["impact", metrics.status_page_impact],
    ["url", item.url],
    ["target_label", metrics.status_page_target_label],
  ];
  const match = fields.find(([, value]) => textMatchesKeyword(value || "", keyword));
  return match ? match[0] : metrics.status_page_target_matched_keyword ? "target" : "";
}

function statusPageKeywordDiagnostics(item = {}, keyword = "") {
  return {
    status_page_matched_keyword: cleanText(keyword, 160),
    status_page_keyword_match_source: statusPageKeywordMatchSource(item, keyword),
  };
}

function statusPageRiskLevel({ kind = "", status = "", impact = "", pageIndicator = "" } = {}) {
  const text = `${kind} ${status} ${impact} ${pageIndicator}`.toLowerCase();
  if (/major|critical|major_outage|security|data loss|partial_outage|identified|investigating/i.test(text)) return "high";
  if (/degraded|minor|maintenance|monitoring|scheduled/i.test(text)) return "medium";
  if (!HEALTHY_PAGE_INDICATORS.has(String(pageIndicator || "").toLowerCase())) return "medium";
  return "low";
}

function normalizeStatusPageDedupeUrl(rawUrl = "") {
  const raw = cleanText(rawUrl, 900);
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]) {
      url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.split("#")[0].trim();
  }
}

function statusPageDedupeKey(item = {}) {
  const metrics = item.metrics || {};
  if (metrics.status_page_incident_id) return `statuspage-incident:${metrics.status_page_id || metrics.status_page_name || ""}:${metrics.status_page_incident_id}`;
  if (metrics.status_page_component_id) return `statuspage-component:${metrics.status_page_id || metrics.status_page_name || ""}:${metrics.status_page_component_id}:${metrics.status_page_component_status || ""}`;
  return normalizeStatusPageDedupeUrl(item.url || "");
}

function itemBodyFromIncident(incident = {}) {
  const updates = Array.isArray(incident.incident_updates) ? incident.incident_updates : [];
  const latestUpdate = updates[0] || {};
  const affected = updates
    .flatMap(update => Array.isArray(update.affected_components) ? update.affected_components : [])
    .map(component => cleanText(component.name || component.code || "", 120))
    .filter(Boolean)
    .slice(0, 8);
  return cleanText([
    incident.name,
    incident.status,
    incident.impact,
    incident.impact_override,
    latestUpdate.body,
    affected.length ? `Affected components: ${affected.join(", ")}` : "",
  ].filter(Boolean).join(" "), 2000);
}

function pageUrlFromPayload(payload = {}, fallbackUrl = "") {
  const page = payload?.page || {};
  return cleanText(page.url || fallbackUrl.replace(/\/api\/v2\/summary\.json(?:\?.*)?$/i, ""), 900);
}

function incidentUrl(incident = {}, pageUrl = "") {
  const direct = cleanText(incident.shortlink || incident.url || "", 900);
  if (direct) return direct;
  const id = cleanText(incident.id || "", 120);
  return pageUrl && id ? `${pageUrl.replace(/\/+$/, "")}/incidents/${encodeURIComponent(id)}` : pageUrl;
}

function statusPageAffectedComponents(incident = {}) {
  const updates = Array.isArray(incident.incident_updates) ? incident.incident_updates : [];
  const direct = Array.isArray(incident.components) ? incident.components : [];
  return [...new Set([
    ...direct.map(component => cleanText(component.name || component.code || component.id || "", 140)),
    ...updates.flatMap(update => Array.isArray(update.affected_components) ? update.affected_components : [])
      .map(component => cleanText(component.name || component.code || component.id || "", 140)),
  ].filter(Boolean))].slice(0, 16);
}

function minutesBetween(start = "", end = "") {
  const startMs = new Date(start || "").getTime();
  const endMs = new Date(end || "").getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return 0;
  return Math.round((endMs - startMs) / 60000);
}

function statusPageIncidentTimeline(incident = {}, page = {}) {
  const updates = Array.isArray(incident.incident_updates) ? incident.incident_updates : [];
  const latestUpdate = updates
    .slice()
    .sort((a, b) => new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime())[0] || {};
  const startedAt = normalizeDate(incident.started_at || incident.created_at || incident.scheduled_for || page.updated_at);
  const resolvedAt = normalizeDate(incident.resolved_at || incident.scheduled_until || (String(incident.status || "").toLowerCase() === "resolved" ? incident.updated_at : ""));
  const latestUpdateAt = normalizeDate(latestUpdate.updated_at || latestUpdate.created_at || incident.updated_at || page.updated_at);
  const durationEnd = resolvedAt || latestUpdateAt || normalizeDate(incident.updated_at || page.updated_at);
  return {
    startedAt,
    resolvedAt,
    latestUpdateAt,
    latestUpdateStatus: cleanText(latestUpdate.status || incident.status || "", 80).toLowerCase(),
    latestUpdateBody: cleanText(latestUpdate.body || "", 800),
    updateCount: updates.length,
    durationMinutes: minutesBetween(startedAt, durationEnd),
  };
}

function statusPageImpactScore({ kind = "", status = "", impact = "", pageIndicator = "", affectedCount = 0, updateCount = 0, durationMinutes = 0, componentStatus = "" } = {}) {
  let score = 0;
  const text = `${kind} ${status} ${impact} ${pageIndicator} ${componentStatus}`.toLowerCase();
  if (/critical|major|major_outage/.test(text)) score += 45;
  else if (/partial_outage|degraded|degradation|identified|investigating/.test(text)) score += 32;
  else if (/minor|maintenance|scheduled|monitoring/.test(text)) score += 18;
  if (/investigating|identified/.test(text)) score += 12;
  if (/resolved/.test(text)) score -= 12;
  score += Math.min(18, Number(affectedCount || 0) * 6);
  score += Math.min(12, Number(updateCount || 0) * 3);
  if (Number(durationMinutes || 0) >= 240) score += 15;
  else if (Number(durationMinutes || 0) >= 60) score += 9;
  else if (Number(durationMinutes || 0) >= 15) score += 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function statusPageRiskBucket(score = 0) {
  const numeric = Number(score || 0);
  if (numeric >= 70) return "high";
  if (numeric >= 35) return "medium";
  return "low";
}

function matchedStatusPageTerms(text = "", terms = [], limit = 10) {
  const lower = String(text || "").toLowerCase();
  const out = [];
  for (const term of terms) {
    const raw = String(term || "").trim();
    if (!raw) continue;
    if (lower.includes(raw.toLowerCase()) && !out.includes(raw)) out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function statusPageUpdateContext(incident = {}) {
  const updates = Array.isArray(incident.incident_updates) ? incident.incident_updates : [];
  const bodies = updates.map(update => cleanText(update.body || "", 800)).filter(Boolean);
  const statuses = updates.map(update => cleanText(update.status || "", 80).toLowerCase()).filter(Boolean);
  const transitions = updates
    .flatMap(update => Array.isArray(update.affected_components) ? update.affected_components : [])
    .map(component => ({
      name: cleanText(component.name || component.code || component.id || "", 140),
      oldStatus: cleanText(component.old_status || component.oldStatus || "", 80).toLowerCase(),
      newStatus: cleanText(component.new_status || component.newStatus || component.status || "", 80).toLowerCase(),
    }))
    .filter(component => component.name || component.oldStatus || component.newStatus)
    .slice(0, 24);
  return {
    updateBodies: bodies,
    updateStatuses: statuses,
    componentTransitions: transitions,
  };
}

function statusPageIncidentSignals({ kind = "", status = "", impact = "", pageIndicator = "", affectedComponents = [], updateCount = 0, durationMinutes = 0, latestBody = "", updateBodies = [], updateStatuses = [], componentTransitions = [] } = {}) {
  const text = cleanText(`${kind} ${status} ${impact} ${pageIndicator} ${latestBody} ${(Array.isArray(updateBodies) ? updateBodies : []).join(" ")} ${(Array.isArray(updateStatuses) ? updateStatuses : []).join(" ")}`, 3600).toLowerCase();
  const investigating = /investigating|identified|monitoring|調查|调查|定位|監控|监控/.test(text);
  const major = /critical|major|major_outage|partial_outage|outage|unavailable|宕机|宕機|中断|中斷|不可用/.test(text);
  const customerImpact = /customer|user|checkout|payment|login|api|refund|delivery|order|客戶|客户|用戶|用户|支付|付款|登入|登录|退款|訂單|订单/.test(text);
  const longRunning = Number(durationMinutes || 0) >= 60;
  const multiComponent = Array.isArray(affectedComponents) && affectedComponents.length >= 2;
  const updatedFrequently = Number(updateCount || 0) >= 2;
  const mitigationTerms = matchedStatusPageTerms(text, ["mitigation", "mitigated", "workaround", "reroute", "failover", "recovery", "restore", "restored", "修复", "修復", "缓解", "緩解", "恢复", "恢復", "切换", "切換"]);
  const rootCauseTerms = matchedStatusPageTerms(text, ["root cause", "postmortem", "post-mortem", "rca", "caused by", "原因", "根因", "复盘", "復盤"]);
  const customerCommsTerms = matchedStatusPageTerms(text, ["status update", "next update", "support", "help center", "contact us", "通知", "公告", "客服", "帮助中心", "幫助中心", "后续更新", "後續更新"]);
  const scopeTerms = matchedStatusPageTerms(text, ["region", "regional", "global", "us-east", "us-west", "eu", "asia", "apac", "all customers", "subset", "区域", "區域", "全球", "部分用户", "部分用戶", "全部用户", "全部用戶"]);
  const securityTerms = matchedStatusPageTerms(text, ["security", "privacy", "breach", "data", "credential", "安全", "隐私", "隱私", "数据", "資料", "外洩", "泄露"]);
  const resolvedOrMonitoring = /resolved|monitoring|operational|restored|恢復|恢复|已解决|已解決|監控|监控/.test(text);
  const componentTransition = Array.isArray(componentTransitions) && componentTransitions.some(component => component.oldStatus || component.newStatus);
  const reasons = [];
  if (investigating) reasons.push("active-incident-stage");
  if (major) reasons.push("major-service-impact");
  if (customerImpact) reasons.push("customer-facing-service-language");
  if (longRunning) reasons.push("long-running-incident");
  if (multiComponent) reasons.push("multi-component-impact");
  if (updatedFrequently) reasons.push("multiple-status-updates");
  if (mitigationTerms.length) reasons.push("mitigation-or-recovery-language");
  if (rootCauseTerms.length) reasons.push("root-cause-postmortem-language");
  if (customerCommsTerms.length) reasons.push("customer-communication-language");
  if (scopeTerms.length) reasons.push("geographic-or-customer-scope-language");
  if (securityTerms.length) reasons.push("security-or-data-risk-language");
  if (resolvedOrMonitoring) reasons.push("recovery-monitoring-stage");
  if (componentTransition) reasons.push("component-status-transition");
  const semanticSignalCount = [
    investigating || major,
    customerImpact,
    multiComponent || scopeTerms.length || (Array.isArray(affectedComponents) && affectedComponents.length > 0),
    mitigationTerms.length || resolvedOrMonitoring || customerCommsTerms.length,
    updatedFrequently || longRunning || rootCauseTerms.length || componentTransition,
  ].filter(Boolean).length;
  const completeNarrative = semanticSignalCount >= 5;
  if (completeNarrative) reasons.push("status-page-complete-service-crisis-narrative");
  return {
    status_page_active_incident_signal: investigating ? 1 : 0,
    status_page_major_impact_signal: major ? 1 : 0,
    status_page_customer_impact_signal: customerImpact ? 1 : 0,
    status_page_long_running_signal: longRunning ? 1 : 0,
    status_page_multi_component_signal: multiComponent ? 1 : 0,
    status_page_update_velocity_signal: updatedFrequently ? 1 : 0,
    status_page_mitigation_signal: mitigationTerms.length ? 1 : 0,
    status_page_root_cause_signal: rootCauseTerms.length ? 1 : 0,
    status_page_customer_comms_signal: customerCommsTerms.length ? 1 : 0,
    status_page_scope_signal: scopeTerms.length ? 1 : 0,
    status_page_security_data_signal: securityTerms.length ? 1 : 0,
    status_page_recovery_monitoring_signal: resolvedOrMonitoring ? 1 : 0,
    status_page_component_transition_signal: componentTransition ? 1 : 0,
    status_page_mitigation_terms: mitigationTerms,
    status_page_root_cause_terms: rootCauseTerms,
    status_page_customer_comms_terms: customerCommsTerms,
    status_page_scope_terms: scopeTerms,
    status_page_security_data_terms: securityTerms,
    status_page_component_transitions: Array.isArray(componentTransitions) ? componentTransitions.slice(0, 12) : [],
    status_page_semantic_signal_count: semanticSignalCount,
    status_page_complete_service_crisis_narrative_signal: completeNarrative ? 1 : 0,
    status_page_signal_count: reasons.length,
    status_page_signal_reasons: reasons,
  };
}

function parseStatusPageSummary(payload = {}, keyword = "", { target = {}, limit = DEFAULT_MAX_ITEMS_PER_KEYWORD, since = "" } = {}) {
  const page = payload?.page || {};
  const pageName = cleanText(page.name || target.name || target.label || "", 260);
  const pageId = cleanText(page.id || target.key || pageName, 160);
  const pageUrl = pageUrlFromPayload(payload, target.homeUrl || target.url || "");
  const pageIndicator = cleanText(payload?.status?.indicator || "", 80).toLowerCase();
  const pageDescription = cleanText(payload?.status?.description || "", 240);
  const targetMatched = Boolean(target.matchedKeyword || textMatchesKeyword(`${pageName} ${pageUrl} ${target.label || ""}`, keyword));
  const rows = [];

  for (const incident of [
    ...(Array.isArray(payload?.incidents) ? payload.incidents : []),
    ...(Array.isArray(payload?.scheduled_maintenances) ? payload.scheduled_maintenances : []),
  ]) {
    const publishedAt = normalizeDate(incident.started_at || incident.created_at || incident.scheduled_for || incident.updated_at || page.updated_at) || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const body = itemBodyFromIncident(incident);
    if (!targetMatched && !textMatchesKeyword(`${body} ${pageName} ${pageUrl}`, keyword)) continue;
    const kind = Array.isArray(payload?.scheduled_maintenances) && payload.scheduled_maintenances.includes(incident) ? "scheduled_maintenance" : "incident";
    const impact = cleanText(incident.impact || incident.impact_override || "", 80).toLowerCase();
	    const affectedComponents = statusPageAffectedComponents(incident);
	    const timeline = statusPageIncidentTimeline(incident, page);
	    const updateContext = statusPageUpdateContext(incident);
	    const impactScore = statusPageImpactScore({
	      kind,
	      status: incident.status,
      impact,
      pageIndicator,
      affectedCount: affectedComponents.length,
      updateCount: timeline.updateCount,
      durationMinutes: timeline.durationMinutes,
    });
    const signals = statusPageIncidentSignals({
      kind,
      status: incident.status,
      impact,
      pageIndicator,
	      affectedComponents,
	      updateCount: timeline.updateCount,
	      durationMinutes: timeline.durationMinutes,
	      latestBody: timeline.latestUpdateBody || body,
	      updateBodies: updateContext.updateBodies,
	      updateStatuses: updateContext.updateStatuses,
	      componentTransitions: updateContext.componentTransitions,
	    });
    rows.push({
      url: incidentUrl(incident, pageUrl),
      title: cleanText(`${pageName}: ${incident.name || pageDescription || "service status"}`, 420),
      content: body,
      author: pageName || "Public status page",
      publishedAt,
      metrics: {
        source: "public_status_page",
        source_family: "operations",
        source_kind: kind,
        status_page_id: pageId,
        status_page_name: pageName,
        status_page_url: pageUrl,
        status_page_target_label: cleanText(target.label || target.name || "", 160),
        status_page_target_matched_keyword: targetMatched,
        status_page_indicator: pageIndicator,
        status_page_description: pageDescription,
        status_page_incident_id: cleanText(incident.id || "", 120),
        status_page_incident_status: cleanText(incident.status || "", 80).toLowerCase(),
        status_page_impact: impact,
        status_page_risk_level: statusPageRiskLevel({ kind, status: incident.status, impact, pageIndicator }),
        status_page_impact_score: impactScore,
        status_page_risk_bucket: statusPageRiskBucket(impactScore),
        status_page_affected_component_count: affectedComponents.length,
        status_page_affected_components: affectedComponents.join(","),
        status_page_update_count: timeline.updateCount,
        status_page_latest_update_at: timeline.latestUpdateAt,
	        status_page_latest_update_status: timeline.latestUpdateStatus,
	        status_page_update_statuses: updateContext.updateStatuses,
	        status_page_started_at: timeline.startedAt,
	        status_page_resolved_at: timeline.resolvedAt,
	        status_page_duration_minutes: timeline.durationMinutes,
	        status_page_component_transition_count: updateContext.componentTransitions.length,
	        status_page_raw_incident_count: Array.isArray(payload?.incidents) ? payload.incidents.length : 0,
        status_page_raw_maintenance_count: Array.isArray(payload?.scheduled_maintenances) ? payload.scheduled_maintenances.length : 0,
        ...signals,
      },
    });
    if (rows.length >= limit) return rows;
  }

  for (const component of Array.isArray(payload?.components) ? payload.components : []) {
    const status = cleanText(component.status || "", 80).toLowerCase();
    if (!status || HEALTHY_COMPONENT_STATUSES.has(status)) continue;
    const publishedAt = normalizeDate(component.updated_at || component.created_at || page.updated_at) || new Date().toISOString();
    if (!isAfterSince(publishedAt, since)) continue;
    const body = cleanText(`${component.name || ""} ${status} ${component.description || ""} ${pageDescription}`, 1600);
    if (!targetMatched && !textMatchesKeyword(`${body} ${pageName} ${pageUrl}`, keyword)) continue;
    const impactScore = statusPageImpactScore({
      kind: "component_status",
      status,
      pageIndicator,
      componentStatus: status,
      affectedCount: 1,
    });
    const signals = statusPageIncidentSignals({
      kind: "component_status",
      status,
      pageIndicator,
      affectedComponents: [component.name].filter(Boolean),
      latestBody: body,
    });
    rows.push({
      url: pageUrl,
      title: cleanText(`${pageName}: ${component.name || "component"} ${status}`, 420),
      content: body,
      author: pageName || "Public status page",
      publishedAt,
      metrics: {
        source: "public_status_page",
        source_family: "operations",
        source_kind: "component_status",
        status_page_id: pageId,
        status_page_name: pageName,
        status_page_url: pageUrl,
        status_page_target_label: cleanText(target.label || target.name || "", 160),
        status_page_target_matched_keyword: targetMatched,
        status_page_indicator: pageIndicator,
        status_page_description: pageDescription,
        status_page_component_id: cleanText(component.id || "", 120),
        status_page_component_name: cleanText(component.name || "", 220),
        status_page_component_status: status,
        status_page_risk_level: statusPageRiskLevel({ kind: "component_status", status, pageIndicator }),
        status_page_impact_score: impactScore,
        status_page_risk_bucket: statusPageRiskBucket(impactScore),
        status_page_affected_component_count: 1,
        status_page_affected_components: cleanText(component.name || "", 220),
        status_page_raw_component_count: Array.isArray(payload?.components) ? payload.components.length : 0,
        ...signals,
      },
    });
    if (rows.length >= limit) return rows;
  }

  return rows;
}

function asciiBrandToken(keyword = "") {
  const raw = cleanText(keyword, 160).toLowerCase();
  const host = hostnameFromKeyword(raw);
  if (host) return host.split(".")[0].replace(/[^a-z0-9-]/g, "");
  const token = raw
    .split(/[\s,;|/()[\]{}"'`]+/)
    .map(item => item.replace(/[^a-z0-9-]/g, ""))
    .find(item => item.length >= 4 && item.length <= 40 && /[a-z]/.test(item));
  return token || "";
}

function hostnameFromKeyword(keyword = "") {
  const value = cleanText(keyword, 220).toLowerCase();
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) ? url.hostname.replace(/^www\./, "") : "";
  } catch {
    const match = value.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})\b/i);
    return match ? match[1].replace(/^www\./, "") : "";
  }
}

function statusSummaryUrl(url = "") {
  const raw = cleanText(url, 900);
  if (!raw) return "";
  if (/\/api\/v2\/summary\.json(?:\?.*)?$/i.test(raw)) return raw;
  return `${raw.replace(/\/+$/, "")}/api/v2/summary.json`;
}

function normalizeTargets(targets = [], keyword = "", budget = normalizeBudget()) {
  const configured = Array.isArray(targets) ? targets : [];
  const out = [];
  for (const target of configured) {
    if (typeof target === "string") {
      out.push({ key: target, label: target, url: statusSummaryUrl(target), matchedKeyword: textMatchesKeyword(target, keyword) });
    } else if (target?.url) {
      out.push({
        ...target,
        key: target.key || target.url,
        label: target.label || target.name || target.key || target.url,
        url: statusSummaryUrl(target.url),
        matchedKeyword: target.matchedKeyword ?? textMatchesKeyword(`${target.name || ""} ${target.label || ""} ${target.url || ""}`, keyword),
      });
    }
  }

  const host = hostnameFromKeyword(keyword);
  if (host) {
    out.push({
      key: `status.${host}`,
      label: `status.${host}`,
      url: `https://status.${host}/api/v2/summary.json`,
      matchedKeyword: true,
    });
  }
  const token = asciiBrandToken(keyword);
  if (token) {
    for (const candidate of [
      `${token}.statuspage.io`,
      `${token}-status.statuspage.io`,
      `${token}status.statuspage.io`,
      `status.${token}.com`,
    ]) {
      out.push({
        key: candidate,
        label: candidate,
        url: `https://${candidate}/api/v2/summary.json`,
        matchedKeyword: true,
      });
    }
  }

  const seen = new Set();
  return out
    .filter(target => /^https:\/\//i.test(target.url || ""))
    .filter(target => {
      const key = normalizeStatusPageDedupeUrl(target.url || "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, budget.maxTargetsPerKeyword);
}

async function insertStatusPageItems(items = [], { keyword, domainControls = {}, contentControls = {}, seenItemUrls = null, failoverAttribution = [] } = {}) {
  let inserted = 0;
  const attribution = Array.isArray(failoverAttribution) ? failoverAttribution : [];
  const failoverFromSources = [...new Set(attribution.map(entry => entry?.fromSource).filter(Boolean))];
  for (const item of items) {
    const dedupeKey = statusPageDedupeKey(item);
    if (!dedupeKey) continue;
    if (seenItemUrls instanceof Set) {
      if (seenItemUrls.has(dedupeKey)) continue;
      seenItemUrls.add(dedupeKey);
    }
    const sentiment = analyzeSentiment(`${item.title} ${item.content}`);
    const risk = assessRiskLevel({
      title: item.title,
      content: item.content,
      sentiment,
      riskLevel: item.metrics?.status_page_risk_level || "",
    });
    const result = insertSentimentItem({
      platform: "public_status_page_sources",
      url: item.url,
      title: item.title,
      content: item.content,
      author: item.author,
      sentiment,
      risk_level: risk,
      keyword,
      keywords: [keyword],
      published_at: item.publishedAt,
      ai_summary: item.content,
      raw_html: "",
      source_key: "publicStatusPageSources",
      evidence: {
        evidence_type: "public_status_page_signal",
        metrics: {
          ...(item.metrics || {}),
          ...statusPageKeywordDiagnostics(item, keyword),
          status_page_canonical_dedupe_url: dedupeKey,
          status_page_search_scan_dedupe_key: dedupeKey,
          ...(attribution.length ? {
            failover_attribution: attribution,
            failover_from_sources: failoverFromSources,
          } : {}),
        },
      },
      source_type: "scraper",
      allow_external_risk_level: true,
      domainControls,
      contentControls,
    });
    if (result.inserted) inserted += 1;
  }
  return inserted;
}

export async function scrapePublicStatusPageSources(keywords, { proxyUrl = "", budget = {}, since = "", targets = [], domainControls = {}, contentControls = {}, failoverAttribution = [] } = {}) {
  const normalizedKeywords = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
  if (!normalizedKeywords.length) return scraperResult(0);
  const normalizedBudget = normalizeBudget(budget);
  const seenItemUrls = new Set();
  const results = await mapWithConcurrency(normalizedKeywords, SEARCH_CONCURRENCY, async (keyword) => {
    let inserted = 0;
    const failures = [];
    const targetList = normalizeTargets(targets, keyword, normalizedBudget);
    for (const target of targetList) {
      if (inserted >= normalizedBudget.maxItemsPerKeyword) break;
      try {
        const res = await fetchPublicSource(target.url, {
          headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }, proxyUrl);
        if (!res.ok) {
          failures.push({ keyword, target: target.key || target.url, message: httpFailure(res) });
          continue;
        }
        const remaining = normalizedBudget.maxItemsPerKeyword - inserted;
        const items = parseStatusPageSummary(await res.json(), keyword, { target, limit: remaining, since });
        inserted += await insertStatusPageItems(items, { keyword, domainControls, contentControls, seenItemUrls, failoverAttribution });
      } catch (err) {
        const message = formatSourceError(err, proxyUrl);
        failures.push({ keyword, target: target.key || target.url, message });
        console.warn(`[CRM/PublicStatusPage] 抓取失敗 keyword=${keyword} target=${target.key || target.url}: ${message}`);
      }
    }
    return { inserted, failures };
  });

  return scraperResult(
    results.reduce((sum, result) => sum + Number(result?.inserted || 0), 0),
    results.flatMap(result => result?.failures || []),
  );
}

export const __test__ = {
  INCIDENT_TERMS,
  normalizeBudget,
  normalizeStatusPageKeywordText,
  keywordNeedles,
  textMatchesKeyword,
  statusPageKeywordMatchSource,
  statusPageKeywordDiagnostics,
  statusPageRiskLevel,
  statusPageAffectedComponents,
  statusPageIncidentTimeline,
  statusPageUpdateContext,
  statusPageImpactScore,
  statusPageRiskBucket,
  statusPageIncidentSignals,
  normalizeStatusPageDedupeUrl,
  statusPageDedupeKey,
  hostnameFromKeyword,
  asciiBrandToken,
  statusSummaryUrl,
  normalizeTargets,
  parseStatusPageSummary,
};
