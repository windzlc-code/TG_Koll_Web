CREATE TABLE IF NOT EXISTS crm_sentiment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  title TEXT DEFAULT '',
  content TEXT DEFAULT '',
  author TEXT DEFAULT '',
  sentiment TEXT DEFAULT 'neutral',
  keywords TEXT DEFAULT '[]',
  keyword TEXT DEFAULT '',
  published_at DATETIME,
  found_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  seen_count INTEGER DEFAULT 1,
  workspace_id TEXT DEFAULT 'default',
  customer_id TEXT DEFAULT '',
  risk_level TEXT DEFAULT 'low',
  ai_summary TEXT DEFAULT '',
  source_type TEXT DEFAULT 'scraper',
  content_hash TEXT,
  content_fingerprint TEXT,
  is_read INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS crm_sentiment_raw_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sentiment_id INTEGER REFERENCES crm_sentiment(id) ON DELETE CASCADE,
  workspace_id TEXT DEFAULT 'default',
  customer_id TEXT DEFAULT '',
  source_key TEXT DEFAULT '',
  raw_json TEXT NOT NULL,
  content_hash TEXT,
  archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_sentiment_insights (
  sentiment_id INTEGER PRIMARY KEY REFERENCES crm_sentiment(id) ON DELETE CASCADE,
  language TEXT DEFAULT 'zh-Hant',
  tokens TEXT DEFAULT '[]',
  extracted_keywords TEXT DEFAULT '[]',
  emotions TEXT DEFAULT '[]',
  demographics TEXT DEFAULT '[]',
  entities TEXT DEFAULT '[]',
  topic TEXT DEFAULT '',
  topic_cluster TEXT DEFAULT '',
  geo_tags TEXT DEFAULT '[]',
  competitor_tags TEXT DEFAULT '[]',
  kol_score REAL DEFAULT 0,
  spread_score REAL DEFAULT 0,
  influence_score REAL DEFAULT 0,
  action_suggestion TEXT DEFAULT '',
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_sentiment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  title TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  keyword TEXT DEFAULT '',
  sentiment TEXT DEFAULT 'neutral',
  risk_level TEXT DEFAULT 'low',
  status TEXT DEFAULT 'open',
  item_count INTEGER DEFAULT 0,
  platforms TEXT DEFAULT '[]',
  source_urls TEXT DEFAULT '[]',
  first_seen_at DATETIME,
  last_seen_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_sentiment_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_key TEXT NOT NULL UNIQUE,
  event_id INTEGER REFERENCES crm_sentiment_events(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,
  title TEXT DEFAULT '',
  message TEXT DEFAULT '',
  status TEXT DEFAULT 'open',
  triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at DATETIME
);

CREATE TABLE IF NOT EXISTS crm_sentiment_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES crm_sentiment_alerts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  target TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  message TEXT DEFAULT '',
  error TEXT DEFAULT '',
  sent_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_sentiment_report_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT DEFAULT 'default',
  customer_id TEXT DEFAULT '',
  name TEXT NOT NULL,
  frequency TEXT DEFAULT 'weekly',
  format TEXT DEFAULT 'markdown',
  recipients TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 1,
  next_run_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentiment_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  source_type TEXT DEFAULT 'public',
  enabled INTEGER DEFAULT 1,
  scan_interval_minutes INTEGER DEFAULT 30,
  priority INTEGER DEFAULT 50,
  config_json TEXT DEFAULT '{}',
  last_scan_at DATETIME,
  last_success_at DATETIME,
  last_error TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentiment_scan_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_key TEXT NOT NULL UNIQUE,
  reason TEXT DEFAULT 'manual',
  mode TEXT DEFAULT 'fast',
  status TEXT DEFAULT 'running',
  keywords_json TEXT DEFAULT '[]',
  search_keywords_json TEXT DEFAULT '[]',
  event_expansion_keywords_json TEXT DEFAULT '[]',
  requested_sources_json TEXT DEFAULT '[]',
  sources_json TEXT DEFAULT '[]',
  disabled_sources_json TEXT DEFAULT '[]',
  total INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  error TEXT DEFAULT '',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  duration_ms INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sentiment_scan_source_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER REFERENCES sentiment_scan_batches(id) ON DELETE CASCADE,
  source_key TEXT DEFAULT '',
  label TEXT DEFAULT '',
  status TEXT DEFAULT 'success',
  count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  message TEXT DEFAULT '',
  metadata_json TEXT DEFAULT '{}',
  cooling_until DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentiment_collection_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key TEXT NOT NULL UNIQUE,
  batch_id INTEGER REFERENCES sentiment_scan_batches(id) ON DELETE CASCADE,
  source_key TEXT DEFAULT '',
  label TEXT DEFAULT '',
  reason TEXT DEFAULT 'manual',
  mode TEXT DEFAULT 'fast',
  status TEXT DEFAULT 'pending',
  priority INTEGER DEFAULT 50,
  query_json TEXT DEFAULT '[]',
  entity_json TEXT DEFAULT '{}',
  attempt_count INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 2,
  scheduled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  finished_at DATETIME,
  cooling_until DATETIME,
  duration_ms INTEGER DEFAULT 0,
  result_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  message TEXT DEFAULT '',
  metadata_json TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentiment_source_recovery_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT DEFAULT '',
  action_type TEXT DEFAULT 'source-recovery-playbook',
  operator TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  actions_json TEXT DEFAULT '[]',
  source_patches_json TEXT DEFAULT '[]',
  search_patches_json TEXT DEFAULT '[]',
  recovery_summary_json TEXT DEFAULT '{}',
  metadata_json TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentiment_source_quality_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT DEFAULT '',
  platform TEXT DEFAULT '',
  url TEXT DEFAULT '',
  title TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  relevance_score REAL DEFAULT 0,
  quality_score REAL DEFAULT 0,
  accepted INTEGER DEFAULT 0,
  inserted INTEGER DEFAULT 0,
  updated INTEGER DEFAULT 0,
  metadata_json TEXT DEFAULT '{}',
  captured_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentiment_evidence_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sentiment_id INTEGER REFERENCES crm_sentiment(id) ON DELETE CASCADE,
  source_key TEXT DEFAULT '',
  evidence_type TEXT DEFAULT 'raw',
  url TEXT DEFAULT '',
  title TEXT DEFAULT '',
  content_text TEXT DEFAULT '',
  raw_html TEXT DEFAULT '',
  raw_json TEXT DEFAULT '',
  screenshot_path TEXT DEFAULT '',
  metrics_json TEXT DEFAULT '{}',
  content_hash TEXT,
  captured_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentiment_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sentiment_id INTEGER REFERENCES crm_sentiment(id) ON DELETE CASCADE,
  platform TEXT DEFAULT '',
  external_id TEXT DEFAULT '',
  author TEXT DEFAULT '',
  content TEXT NOT NULL,
  sentiment TEXT DEFAULT 'neutral',
  risk_level TEXT DEFAULT 'low',
  metrics_json TEXT DEFAULT '{}',
  published_at DATETIME,
  content_hash TEXT,
  captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sentiment_id, content_hash)
);

CREATE TABLE IF NOT EXISTS sentiment_fact_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_key TEXT NOT NULL,
  sentiment_id INTEGER REFERENCES crm_sentiment(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES crm_sentiment_events(id) ON DELETE SET NULL,
  source_key TEXT DEFAULT '',
  platform TEXT DEFAULT '',
  url TEXT DEFAULT '',
  title TEXT DEFAULT '',
  claim_text TEXT NOT NULL,
  claim_type TEXT DEFAULT 'general',
  stance TEXT DEFAULT 'asserted',
  confidence REAL DEFAULT 0,
  source_reputation_score REAL DEFAULT 50,
  weighted_confidence REAL DEFAULT 0,
  evidence_count INTEGER DEFAULT 1,
  contradiction_key TEXT DEFAULT '',
  source_reputation_json TEXT DEFAULT '{}',
  extracted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentiment_alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  severity TEXT DEFAULT 'high',
  rule_type TEXT NOT NULL,
  threshold INTEGER DEFAULT 1,
  window_minutes INTEGER DEFAULT 60,
  keywords TEXT DEFAULT '[]',
  sources TEXT DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentiment_event_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_event_id INTEGER REFERENCES crm_sentiment_events(id) ON DELETE CASCADE,
  target_event_id INTEGER REFERENCES crm_sentiment_events(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL,
  weight REAL DEFAULT 0,
  evidence_json TEXT DEFAULT '{}',
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_event_id, target_event_id, edge_type)
);

CREATE TABLE IF NOT EXISTS sentiment_crisis_briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES crm_sentiment_events(id) ON DELETE SET NULL,
  scope_key TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  confidence REAL DEFAULT 0,
  executive_summary TEXT DEFAULT '',
  root_cause_hypotheses TEXT DEFAULT '[]',
  evidence_json TEXT DEFAULT '[]',
  fact_findings_json TEXT DEFAULT '{}',
  response_strategy TEXT DEFAULT '',
  recommended_actions TEXT DEFAULT '[]',
  holding_statement TEXT DEFAULT '',
  model_provider TEXT DEFAULT 'local-rules',
  model_name TEXT DEFAULT 'heuristic-crisis-brief-v1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentiment_anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anomaly_key TEXT NOT NULL UNIQUE,
  anomaly_type TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  score REAL DEFAULT 0,
  title TEXT DEFAULT '',
  message TEXT DEFAULT '',
  window_start DATETIME,
  window_end DATETIME,
  baseline_value REAL DEFAULT 0,
  current_value REAL DEFAULT 0,
  source_weight REAL DEFAULT 0,
  spread_velocity REAL DEFAULT 0,
  evidence_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'open',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentiment_alert_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER REFERENCES crm_sentiment_alerts(id) ON DELETE CASCADE,
  action_type TEXT DEFAULT 'note',
  status TEXT DEFAULT 'open',
  assignee TEXT DEFAULT '',
  note TEXT DEFAULT '',
  due_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sentiment_visual_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sentiment_id INTEGER REFERENCES crm_sentiment(id) ON DELETE CASCADE,
  source_key TEXT DEFAULT '',
  asset_type TEXT DEFAULT 'image',
  image_url TEXT DEFAULT '',
  thumbnail_url TEXT DEFAULT '',
  ocr_text TEXT DEFAULT '',
  logo_tags TEXT DEFAULT '[]',
  object_tags TEXT DEFAULT '[]',
  scene_tags TEXT DEFAULT '[]',
  metrics_json TEXT DEFAULT '{}',
  asset_hash TEXT DEFAULT '',
  captured_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
