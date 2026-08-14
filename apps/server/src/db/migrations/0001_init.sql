-- Esquema inicial de prime-board (docs/specs/mvp.md §3).
-- Convenciones: ids UUID v7 en texto, timestamps ISO-8601 UTC, soft-delete por archived_at.

CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  type TEXT NOT NULL CHECK (type IN ('human', 'agent')),
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  description TEXT,
  next_issue_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_states (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')),
  color TEXT NOT NULL,
  position REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (team_id, name)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'backlog' CHECK (state IN ('backlog', 'planned', 'started', 'paused', 'completed', 'canceled')),
  lead_id TEXT REFERENCES actors(id),
  target_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state_id TEXT NOT NULL REFERENCES workflow_states(id),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  assignee_id TEXT REFERENCES actors(id),
  parent_id TEXT REFERENCES issues(id),
  project_id TEXT REFERENCES projects(id),
  creator_id TEXT NOT NULL REFERENCES actors(id),
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (team_id, number)
);
CREATE INDEX idx_issues_team_state ON issues(team_id, state_id);
CREATE INDEX idx_issues_assignee ON issues(assignee_id);
CREATE INDEX idx_issues_project ON issues(project_id);
CREATE INDEX idx_issues_parent ON issues(parent_id);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  team_id TEXT REFERENCES teams(id),
  created_at TEXT NOT NULL,
  UNIQUE (team_id, name)
);

CREATE TABLE issue_labels (
  issue_id TEXT NOT NULL REFERENCES issues(id),
  label_id TEXT NOT NULL REFERENCES labels(id),
  PRIMARY KEY (issue_id, label_id)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT
);
CREATE INDEX idx_comments_issue ON comments(issue_id);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_issue ON activity(issue_id);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["*"]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Búsqueda full-text sobre título y descripción, sincronizada por triggers.
CREATE VIRTUAL TABLE issues_fts USING fts5(
  title,
  description,
  content='issues',
  content_rowid='rowid'
);

CREATE TRIGGER issues_fts_insert AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(rowid, title, description)
  VALUES (new.rowid, new.title, coalesce(new.description, ''));
END;

CREATE TRIGGER issues_fts_delete AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, description)
  VALUES ('delete', old.rowid, old.title, coalesce(old.description, ''));
END;

CREATE TRIGGER issues_fts_update AFTER UPDATE OF title, description ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, description)
  VALUES ('delete', old.rowid, old.title, coalesce(old.description, ''));
  INSERT INTO issues_fts(rowid, title, description)
  VALUES (new.rowid, new.title, coalesce(new.description, ''));
END;
