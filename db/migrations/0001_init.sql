-- 0001_init — 由原项目 backend/app/models.py (v1.6.1) 完整翻译为 D1 (SQLite 方言)。
--
-- 约定:
--   * 所有时间戳一律 TEXT, UTC ISO-8601(带毫秒), 展示层换算北京时间(Asia/Shanghai)。
--   * 布尔 INTEGER 0/1; JSON 列为 TEXT(JSON 字符串)。
--   * 主键为应用层生成的 UUID(crypto.randomUUID()), 与原项目 new_id() 一致。
--   * 外键语义与原模型一致(软删除为主, 极少物理删除); D1 默认开启 foreign_keys。
--   * 原 Python 常驻状态(_stop_flags)替换为 chat_messages.stop_requested 列:
--     stop 请求跨 Worker 实例可见, 流式循环周期性读取。

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'teacher',
  status            TEXT NOT NULL DEFAULT 'pending',
  email_verified_at TEXT,
  created_at        TEXT NOT NULL,
  last_login_at     TEXT,
  approved_at       TEXT,
  approved_by       TEXT
);
CREATE INDEX ix_users_status ON users(status);

CREATE TABLE teacher_invites (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  real_name  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  user_id    TEXT,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_invites_status ON teacher_invites(status);
CREATE INDEX ix_invites_user ON teacher_invites(user_id);

CREATE TABLE email_login_codes (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  consumed_at  TEXT,
  request_ip   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX ix_codes_email_created ON email_login_codes(email, created_at);
CREATE INDEX ix_codes_request_ip ON email_login_codes(request_ip);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  version_seq INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX ix_projects_owner_status ON projects(owner_id, status);
CREATE INDEX ix_projects_owner_updated ON projects(owner_id, updated_at);

CREATE TABLE project_shares (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  email      TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'view',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_share_project_email ON project_shares(project_id, email);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  author_id   TEXT,
  role        TEXT NOT NULL DEFAULT 'user',
  content     TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'text',
  attachments TEXT NOT NULL DEFAULT '[]',
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_messages_project_created ON messages(project_id, created_at);

CREATE TABLE uploads (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  owner_id     TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  rel_path     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX ix_uploads_project ON uploads(project_id);
CREATE INDEX ix_uploads_owner ON uploads(owner_id);

CREATE TABLE versions (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  message_id       TEXT REFERENCES messages(id),
  parent_id        TEXT REFERENCES versions(id),
  source_version_id TEXT,
  version_no       INTEGER NOT NULL,
  branch_name      TEXT NOT NULL DEFAULT 'MAIN',
  mode             TEXT NOT NULL DEFAULT 'generate',
  model            TEXT NOT NULL,
  prompt           TEXT NOT NULL DEFAULT '',
  revised_prompt   TEXT,
  params           TEXT NOT NULL DEFAULT '{}',
  rel_path         TEXT NOT NULL,
  thumb_path       TEXT,
  width            INTEGER,
  height           INTEGER,
  mime             TEXT NOT NULL DEFAULT 'image/png',
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  is_starred       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_version_project_no ON versions(project_id, version_no);
CREATE INDEX ix_versions_parent ON versions(parent_id);
CREATE INDEX ix_versions_source ON versions(source_version_id);
CREATE INDEX ix_versions_message ON versions(message_id);
CREATE INDEX ix_versions_project_created ON versions(project_id, created_at);

CREATE TABLE generation_jobs (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  user_id           TEXT NOT NULL,
  message_id        TEXT,
  status            TEXT NOT NULL DEFAULT 'queued',
  model             TEXT NOT NULL,
  prompt            TEXT NOT NULL DEFAULT '',
  mode              TEXT NOT NULL DEFAULT 'generate',
  source_version_id TEXT,
  reference_ids     TEXT NOT NULL DEFAULT '[]',
  params            TEXT NOT NULL DEFAULT '{}',
  version_id        TEXT,
  error             TEXT,
  client_request_id TEXT,
  request_hash      TEXT,
  created_at        TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT
);
CREATE UNIQUE INDEX uq_job_user_client_request ON generation_jobs(user_id, client_request_id);
CREATE INDEX ix_job_status_created ON generation_jobs(status, created_at);
CREATE INDEX ix_jobs_project ON generation_jobs(project_id, created_at);

CREATE TABLE chat_conversations (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL DEFAULT '新对话',
  model           TEXT NOT NULL DEFAULT '',
  thinking        TEXT NOT NULL DEFAULT 'standard',
  status          TEXT NOT NULL DEFAULT 'active',
  active_leaf_id  TEXT,
  summary         TEXT,
  summary_upto_id TEXT,
  summary_leaf_id TEXT,
  last_message_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX ix_conv_owner_status ON chat_conversations(owner_id, status);
CREATE INDEX ix_conv_owner_updated ON chat_conversations(owner_id, updated_at);

CREATE TABLE summary_calls (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  owner_id        TEXT NOT NULL REFERENCES users(id),
  model           TEXT NOT NULL DEFAULT '',
  upto_message_id TEXT,
  request_id      TEXT,
  usage           TEXT NOT NULL DEFAULT '{}',
  cost_status     TEXT NOT NULL DEFAULT 'pending',
  cost_usd        REAL,
  cost_checked_at TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX ix_summary_owner ON summary_calls(owner_id);
CREATE INDEX ix_summary_cost ON summary_calls(cost_status, created_at);
CREATE INDEX ix_summary_request ON summary_calls(request_id);

CREATE TABLE chat_messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES chat_conversations(id),
  owner_id          TEXT NOT NULL,
  parent_id         TEXT,
  role              TEXT NOT NULL,
  content           TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'complete',
  model             TEXT,
  thinking          TEXT,
  attachments       TEXT NOT NULL DEFAULT '[]',
  usage             TEXT NOT NULL DEFAULT '{}',
  request_id        TEXT,
  cost_usd          REAL,
  cost_status       TEXT NOT NULL DEFAULT 'pending',
  cost_checked_at   TEXT,
  duration_ms       INTEGER,
  error             TEXT,
  reasoning_summary TEXT,
  client_request_id TEXT,
  stop_requested    INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  finished_at       TEXT
);
CREATE INDEX ix_chat_msg_conv_created ON chat_messages(conversation_id, created_at);
CREATE UNIQUE INDEX uq_chat_msg_owner_client_request ON chat_messages(owner_id, client_request_id);
CREATE INDEX ix_chat_msg_cost ON chat_messages(cost_status, created_at);
CREATE INDEX ix_chat_msg_parent ON chat_messages(parent_id);

CREATE TABLE chat_attachments (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  kind            TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  rel_path        TEXT NOT NULL,
  width           INTEGER,
  height          INTEGER,
  extracted_text  TEXT,
  page_count      INTEGER,
  text_truncated  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX ix_chat_att_conv ON chat_attachments(conversation_id);
CREATE INDEX ix_chat_att_owner ON chat_attachments(owner_id);

CREATE TABLE audit_logs (
  id          TEXT PRIMARY KEY,
  actor_email TEXT,
  action      TEXT NOT NULL,
  entity_id   TEXT,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_audit_action_created ON audit_logs(action, created_at);
CREATE INDEX ix_audit_actor ON audit_logs(actor_email, created_at);

CREATE TABLE rate_limit_counters (
  key          TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL
);
