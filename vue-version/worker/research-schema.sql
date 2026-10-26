-- Independent research tables. Existing prediction rows are never rewritten.
CREATE TABLE IF NOT EXISTS research_predictions (
  run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  model_run_id TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS official_draw_snapshots (
  lottery_type TEXT NOT NULL,
  issue TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (lottery_type, issue)
);
CREATE TABLE IF NOT EXISTS research_model_versions (
  model_run_id TEXT PRIMARY KEY, published_at TEXT NOT NULL,
  dataset_sha256 TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_active_model (
  slot INTEGER PRIMARY KEY CHECK(slot=1), model_run_id TEXT NOT NULL,
  activated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_automation_runs (
  run_id TEXT PRIMARY KEY, status TEXT NOT NULL, stage TEXT NOT NULL,
  updated_at TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_draws (
  lottery_type TEXT NOT NULL, issue TEXT NOT NULL, draw_date TEXT NOT NULL,
  retrieved_at TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(lottery_type, issue), UNIQUE(lottery_type, draw_date)
);
CREATE TABLE IF NOT EXISTS research_forecasts (
  lottery_type TEXT NOT NULL, target_date TEXT NOT NULL,
  model_run_id TEXT NOT NULL, published_at TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(lottery_type, target_date)
);
CREATE TABLE IF NOT EXISTS research_forecast_results (
  lottery_type TEXT NOT NULL, target_date TEXT NOT NULL, issue TEXT NOT NULL,
  evaluated_at TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(lottery_type, target_date), UNIQUE(lottery_type, issue)
);
CREATE TABLE IF NOT EXISTS research_pending_candidates (
  run_id TEXT PRIMARY KEY, lottery_type TEXT NOT NULL, target_date TEXT NOT NULL,
  cutoff_issue TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_pending_date ON research_pending_candidates(lottery_type,target_date);
CREATE TABLE IF NOT EXISTS research_prediction_results (
  run_id TEXT PRIMARY KEY, issue TEXT NOT NULL, evaluated_at TEXT NOT NULL, payload TEXT NOT NULL
);
