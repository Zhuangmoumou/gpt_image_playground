CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  task_id TEXT,
  conversation_id TEXT,
  round_id TEXT,
  request_json TEXT NOT NULL,
  result_json TEXT,
  error_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_user_status_updated ON generation_jobs(user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_user_task ON generation_jobs(user_id, task_id);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_user_round ON generation_jobs(user_id, conversation_id, round_id);
