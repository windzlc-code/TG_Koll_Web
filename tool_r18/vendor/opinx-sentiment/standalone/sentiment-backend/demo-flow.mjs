import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSentimentBackendApp } from "./src/server.js";

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find(item => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function jsonRequest(app, url, { method = "GET", body = null } = {}) {
  const response = await app.request(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = response.headers.get("content-type") || "";
  if (/^application\/json\b/i.test(contentType)) {
    return { status: response.status, body: await response.json() };
  }
  return { status: response.status, body: await response.text() };
}

const dataDir = path.resolve(argValue("data-dir") || fs.mkdtempSync(path.join(os.tmpdir(), "bby-sentiment-demo-")));
let lineConnected = false;
const emitted = [];
const bridgeRequests = [];
const bus = {
  emit(event) {
    emitted.push({ ...event, emitted_at: new Date().toISOString() });
  },
  hasHandler(name) {
    return name === "bridge:send-proactive";
  },
  async request(name, payload) {
    bridgeRequests.push({ name, payload });
    return lineConnected ? { platform: payload.platform, chatId: "demo-line-owner" } : null;
  },
};

const backend = createSentimentBackendApp({
  dataDir,
  enableScheduler: false,
  bus,
  log: {
    info: () => {},
    warn: () => {},
    error: (...args) => console.error(...args),
  },
});

try {
  await jsonRequest(backend.app, "/api/sentiment/search-settings", {
    method: "PUT",
    body: {
      sources: ["yahooTaiwan", "googleNews", "duckDuckGo", "gdelt", "ptt", "dcard", "threads", "instagram"],
      proxyEnabled: false,
    },
  });
  await jsonRequest(backend.app, "/api/sentiment/keywords", {
    method: "POST",
    body: { keyword: "捐款 公益 客服" },
  });
  await jsonRequest(backend.app, "/api/sentiment/notifications", {
    method: "PUT",
    body: { app: false, minSeverity: "medium", bridgeChannels: ["line"] },
  });

  const ingest = await jsonRequest(backend.app, "/api/sentiment/ingest", {
    method: "POST",
    body: {
      source_type: "manual",
      defaults: { workspace_id: "demo-workspace", customer_id: "demo-customer" },
      items: [
        {
          platform: "google_news",
          url: "https://example.test/demo/donation-risk",
          title: "公益捐款客服延遲引發公開投訴",
          content: "多名捐款人公開投訴客服回覆延遲，要求釐清款項去向與後續補償安排。",
          keyword: "捐款",
          sentiment: "negative",
          risk_level: "critical",
          published_at: "2026-06-08T09:20:00.000Z",
        },
        {
          platform: "threads",
          url: "https://www.threads.net/@demo/post/positive",
          title: "公益活動志工分享現場回饋",
          content: "志工表示活動流程順暢，捐款人對資訊透明度給予肯定。",
          keyword: "公益",
          sentiment: "positive",
          risk_level: "low",
          published_at: "2026-06-08T10:40:00.000Z",
        },
        {
          platform: "instagram",
          url: "https://www.instagram.com/p/demo-risk/",
          title: "社群貼文質疑捐款說明不完整",
          content: "貼文留言提到款項說明需要更清楚，並要求客服公開回覆。",
          keyword: "客服",
          sentiment: "negative",
          risk_level: "high",
          published_at: "2026-06-08T11:10:00.000Z",
        },
        {
          platform: "dcard",
          url: "https://example.test/demo/service-followup",
          title: "客服補充公告後討論降溫",
          content: "客服發布補充公告後，部分使用者表示已收到清楚說明。",
          keyword: "客服",
          sentiment: "neutral",
          risk_level: "medium",
          published_at: "2026-06-08T12:30:00.000Z",
        },
      ],
    },
  });

  const alerts = await jsonRequest(backend.app, "/api/sentiment/alerts?limit=5");
  const alert = alerts.body.alerts?.[0] || null;
  let notify = null;
  let failedNotification = null;
  let retry = null;
  if (alert) {
    notify = await jsonRequest(backend.app, `/api/sentiment/alerts/${alert.id}/notify`, { method: "POST" });
    await wait(50);
    const notifications = await jsonRequest(backend.app, `/api/sentiment/notifications?limit=10`);
    failedNotification = notifications.body.notifications?.find(item => item.alert_id === alert.id && item.channel === "line") || null;
    if (failedNotification) {
      lineConnected = true;
      retry = await jsonRequest(backend.app, `/api/sentiment/notifications/${failedNotification.id}/retry`, { method: "POST" });
    }
  }

  const [dashboard, analysis, ask, report, architecture, migration] = await Promise.all([
    jsonRequest(backend.app, "/api/sentiment/dashboard?limit=5"),
    jsonRequest(backend.app, "/api/sentiment/analysis"),
    jsonRequest(backend.app, "/api/sentiment/ask", {
      method: "POST",
      body: { question: "最近捐款與客服相關輿情有哪些風險？" },
    }),
    jsonRequest(backend.app, "/api/sentiment/report"),
    jsonRequest(backend.app, "/api/sentiment/architecture"),
    jsonRequest(backend.app, "/api/sentiment/migration-export.jsonl?limit=20"),
  ]);

  const migrationRows = String(migration.body || "").trim().split(/\r?\n/).filter(Boolean).length;
  console.log(JSON.stringify({
    ok: true,
    dataDir,
    ingest: {
      status: ingest.status,
      inserted: ingest.body.inserted,
      alerts: ingest.body.intelligence?.createdAlerts,
    },
    dashboard: {
      total: dashboard.body.stats?.total,
      negative: dashboard.body.stats?.sentiment?.negative,
      publicCount: dashboard.body.stats?.publicCount,
    },
    topTopics: (analysis.body.topics || []).slice(0, 3),
    alert: alert ? { id: alert.id, severity: alert.severity, title: alert.title } : null,
    notify: {
      status: notify?.status || null,
      firstLineStatus: failedNotification?.status || null,
      retryStatus: retry?.body?.notification?.status || null,
      bridgeRequestCount: bridgeRequests.length,
    },
    ask: ask.body.answer,
    reportReady: typeof report.body.markdown === "string" && report.body.markdown.includes("# 輿情監控正式報告"),
    architecture: {
      mode: architecture.body.architecture,
      recommended: architecture.body.operations?.recommended_mode,
    },
    migrationRows,
    emittedNotifications: emitted.length,
  }, null, 2));
} finally {
  backend.close();
}
