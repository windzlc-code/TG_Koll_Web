import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db = null;
let _dbPath = null;

export function initDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "crm.db");
  if (_db) {
    if (_db.open !== false && _dbPath === dbPath) return _db;
    closeDb();
  }

  _db = new Database(dbPath);
  _dbPath = dbPath;
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  migrateExistingTablesBeforeSchema(_db);
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  _db.exec(schema);
  migrateSentimentSchema(_db);

  return _db;
}

export function getDb() {
  if (!_db || _db.open === false) {
    throw new Error("Sentiment DB not initialized. Call initDb() first.");
  }
  return _db;
}

export function closeDb() {
  if (!_db) return;
  try {
    if (_db.open !== false) _db.close();
  } finally {
    _db = null;
    _dbPath = null;
  }
}

function migrateExistingTablesBeforeSchema(db) {
  if (tableExists(db, "crm_sentiment")) migrateSentimentColumns(db);
}

function migrateSentimentSchema(db) {
  migrateSentimentColumns(db);
  if (tableExists(db, "sentiment_scan_batches")) {
    addColumnIfMissing(db, "sentiment_scan_batches", "event_expansion_keywords_json", "event_expansion_keywords_json TEXT DEFAULT '[]'");
  }
  if (tableExists(db, "sentiment_scan_source_logs")) {
    addColumnIfMissing(db, "sentiment_scan_source_logs", "metadata_json", "metadata_json TEXT DEFAULT '{}'");
  }
  if (tableExists(db, "sentiment_collection_jobs")) {
    addColumnIfMissing(db, "sentiment_collection_jobs", "entity_json", "entity_json TEXT DEFAULT '{}'");
    addColumnIfMissing(db, "sentiment_collection_jobs", "metadata_json", "metadata_json TEXT DEFAULT '{}'");
    addColumnIfMissing(db, "sentiment_collection_jobs", "cooling_until", "cooling_until DATETIME");
  }
  if (tableExists(db, "sentiment_source_quality_samples")) {
    addColumnIfMissing(db, "sentiment_source_quality_samples", "metadata_json", "metadata_json TEXT DEFAULT '{}'");
  }
  if (tableExists(db, "sentiment_crisis_briefs")) {
    addColumnIfMissing(db, "sentiment_crisis_briefs", "fact_findings_json", "fact_findings_json TEXT DEFAULT '{}'");
  }
  if (tableExists(db, "sentiment_fact_claims")) {
    addColumnIfMissing(db, "sentiment_fact_claims", "source_reputation_score", "source_reputation_score REAL DEFAULT 50");
    addColumnIfMissing(db, "sentiment_fact_claims", "weighted_confidence", "weighted_confidence REAL DEFAULT 0");
    addColumnIfMissing(db, "sentiment_fact_claims", "source_reputation_json", "source_reputation_json TEXT DEFAULT '{}'");
  }
  ensureSentimentSearchFts(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sentiment_found ON crm_sentiment(found_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sentiment_published ON crm_sentiment(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sentiment_risk ON crm_sentiment(risk_level, found_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sentiment_last_seen ON crm_sentiment(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sentiment_workspace ON crm_sentiment(workspace_id, customer_id, found_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sentiment_read ON crm_sentiment(is_read);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sentiment_content_hash_unique
      ON crm_sentiment(content_hash)
      WHERE content_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sentiment_content_fingerprint
      ON crm_sentiment(content_fingerprint, keyword, last_seen_at DESC)
      WHERE content_fingerprint IS NOT NULL;
	    CREATE INDEX IF NOT EXISTS idx_sentiment_raw_archive_sentiment ON crm_sentiment_raw_archive(sentiment_id, archived_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_sentiment_raw_archive_workspace ON crm_sentiment_raw_archive(workspace_id, customer_id, archived_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_opensearch_archive_outbox_status ON sentiment_opensearch_archive_outbox(status, updated_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_opensearch_archive_outbox_score ON sentiment_opensearch_archive_outbox(archive_score DESC, updated_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_opensearch_archive_outbox_source ON sentiment_opensearch_archive_outbox(source_key, updated_at DESC);
	    CREATE INDEX IF NOT EXISTS idx_sentiment_insights_topic ON crm_sentiment_insights(topic, topic_cluster);
    CREATE INDEX IF NOT EXISTS idx_sentiment_events_risk ON crm_sentiment_events(risk_level, status, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sentiment_events_status ON crm_sentiment_events(status, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sentiment_alerts_status ON crm_sentiment_alerts(status, severity, triggered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sentiment_alerts_event ON crm_sentiment_alerts(event_id);
    CREATE INDEX IF NOT EXISTS idx_sentiment_notifications_alert ON crm_sentiment_notifications(alert_id, channel);
    CREATE INDEX IF NOT EXISTS idx_sentiment_notifications_status ON crm_sentiment_notifications(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sentiment_report_schedules_workspace ON crm_sentiment_report_schedules(workspace_id, customer_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_sentiment_sources_enabled ON sentiment_sources(enabled, priority DESC, source_key);
    CREATE INDEX IF NOT EXISTS idx_scan_batches_started ON sentiment_scan_batches(started_at DESC, status);
    CREATE INDEX IF NOT EXISTS idx_scan_source_logs_batch ON sentiment_scan_source_logs(batch_id, source_key);
    CREATE INDEX IF NOT EXISTS idx_scan_source_logs_source ON sentiment_scan_source_logs(source_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_collection_jobs_batch ON sentiment_collection_jobs(batch_id, source_key);
    CREATE INDEX IF NOT EXISTS idx_collection_jobs_status ON sentiment_collection_jobs(status, scheduled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_collection_jobs_source ON sentiment_collection_jobs(source_key, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_source_recovery_audit_source ON sentiment_source_recovery_audit(source_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_source_recovery_audit_created ON sentiment_source_recovery_audit(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_source_quality_source ON sentiment_source_quality_samples(source_key, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_source_quality_reason ON sentiment_source_quality_samples(reason, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_evidence_sentiment ON sentiment_evidence_documents(sentiment_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_evidence_source ON sentiment_evidence_documents(source_key, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_sentiment ON sentiment_comments(sentiment_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_risk ON sentiment_comments(risk_level, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fact_claims_event ON sentiment_fact_claims(event_id, weighted_confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_fact_claims_sentiment ON sentiment_fact_claims(sentiment_id, extracted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fact_claims_claim_key ON sentiment_fact_claims(claim_key, stance);
    CREATE INDEX IF NOT EXISTS idx_fact_claims_type ON sentiment_fact_claims(claim_type, stance, weighted_confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON sentiment_alert_rules(enabled, severity, rule_type);
    CREATE INDEX IF NOT EXISTS idx_event_edges_source ON sentiment_event_edges(source_event_id, weight DESC);
    CREATE INDEX IF NOT EXISTS idx_event_edges_target ON sentiment_event_edges(target_event_id, weight DESC);
    CREATE INDEX IF NOT EXISTS idx_event_edges_type ON sentiment_event_edges(edge_type, weight DESC);
    CREATE INDEX IF NOT EXISTS idx_crisis_briefs_event ON sentiment_crisis_briefs(event_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_crisis_briefs_scope ON sentiment_crisis_briefs(scope_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_anomalies_status ON sentiment_anomalies(status, severity, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_anomalies_type ON sentiment_anomalies(anomaly_type, score DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_actions_alert ON sentiment_alert_actions(alert_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_visual_assets_sentiment ON sentiment_visual_assets(sentiment_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_visual_assets_source ON sentiment_visual_assets(source_key, captured_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_visual_assets_unique ON sentiment_visual_assets(sentiment_id, asset_hash);
  `);
}

function ensureSentimentSearchFts(db) {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS sentiment_search_fts USING fts5(
      doc_type UNINDEXED,
      ref_id UNINDEXED,
      sentiment_id UNINDEXED,
      platform,
      source_key,
      title,
      content,
      author,
      keyword,
      url UNINDEXED,
      risk_level UNINDEXED,
      published_at UNINDEXED,
      tokenize = 'unicode61'
    );
  `);
}

function tableExists(db, tableName) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
}

function tableColumns(db, tableName) {
  if (!tableExists(db, tableName)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((col) => col.name));
}

function addColumnIfMissing(db, tableName, columnName, definition) {
  const columns = tableColumns(db, tableName);
  if (columns.size === 0 || columns.has(columnName)) return;
  try {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to add column ${tableName}.${columnName} (${definition}): ${message}`);
  }
}

function migrateSentimentColumns(db) {
  addColumnIfMissing(db, "crm_sentiment", "published_at", "published_at DATETIME");
  addColumnIfMissing(db, "crm_sentiment", "keyword", "keyword TEXT DEFAULT ''");
  addColumnIfMissing(db, "crm_sentiment", "first_seen_at", "first_seen_at DATETIME");
  addColumnIfMissing(db, "crm_sentiment", "last_seen_at", "last_seen_at DATETIME");
  addColumnIfMissing(db, "crm_sentiment", "seen_count", "seen_count INTEGER DEFAULT 1");
  addColumnIfMissing(db, "crm_sentiment", "workspace_id", "workspace_id TEXT DEFAULT 'default'");
  addColumnIfMissing(db, "crm_sentiment", "customer_id", "customer_id TEXT DEFAULT ''");
  addColumnIfMissing(db, "crm_sentiment", "risk_level", "risk_level TEXT DEFAULT 'low'");
  addColumnIfMissing(db, "crm_sentiment", "ai_summary", "ai_summary TEXT DEFAULT ''");
  addColumnIfMissing(db, "crm_sentiment", "source_type", "source_type TEXT DEFAULT 'scraper'");
  addColumnIfMissing(db, "crm_sentiment", "content_hash", "content_hash TEXT");
  addColumnIfMissing(db, "crm_sentiment", "content_fingerprint", "content_fingerprint TEXT");
  addColumnIfMissing(db, "sentiment_visual_assets", "asset_hash", "asset_hash TEXT DEFAULT ''");
  db.exec(`
    UPDATE crm_sentiment
    SET first_seen_at = COALESCE(NULLIF(trim(first_seen_at), ''), NULLIF(trim(found_at), ''), NULLIF(trim(published_at), ''), CURRENT_TIMESTAMP)
    WHERE first_seen_at IS NULL OR trim(first_seen_at) = '';
  `);
  db.exec(`
    UPDATE crm_sentiment
    SET last_seen_at = COALESCE(NULLIF(trim(last_seen_at), ''), NULLIF(trim(found_at), ''), NULLIF(trim(first_seen_at), ''), NULLIF(trim(published_at), ''), CURRENT_TIMESTAMP)
    WHERE last_seen_at IS NULL OR trim(last_seen_at) = '';
  `);
  db.exec(`
    UPDATE crm_sentiment
    SET seen_count = 1
    WHERE seen_count IS NULL OR seen_count < 1;
  `);
  db.exec(`
    UPDATE crm_sentiment
    SET workspace_id = 'default'
    WHERE workspace_id IS NULL OR trim(workspace_id) = '';
  `);
}
