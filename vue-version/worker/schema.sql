
CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  lottery_type TEXT NOT NULL,
  red_predicted_nums TEXT NOT NULL, -- JSON string
  blue_predicted_nums TEXT NOT NULL, -- JSON string
  create_time INTEGER NOT NULL,
  issue TEXT,
  red_lottery_nums TEXT, -- JSON string
  blue_lottery_nums TEXT, -- JSON string
  hit_count INTEGER DEFAULT 0,
  prize_level TEXT,
  lottery_date INTEGER,
  update_time INTEGER
);

CREATE INDEX IF NOT EXISTS idx_predictions_issue ON predictions(issue);
CREATE INDEX IF NOT EXISTS idx_predictions_user_id ON predictions(user_id);
