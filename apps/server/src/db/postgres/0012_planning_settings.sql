-- PRB-391: planning settings for Projects and Initiatives.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_date TEXT;
ALTER TABLE initiatives ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4);
ALTER TABLE initiatives ADD COLUMN IF NOT EXISTS lead_team_id TEXT;
ALTER TABLE initiatives ADD COLUMN IF NOT EXISTS resources_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_actor ON project_members(actor_id);

CREATE TABLE IF NOT EXISTS project_dependencies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  depends_on_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'blocks' CHECK (type IN ('blocks', 'related')),
  created_at TEXT NOT NULL,
  UNIQUE (project_id, depends_on_project_id, type),
  CHECK (project_id <> depends_on_project_id)
);
CREATE INDEX IF NOT EXISTS idx_project_dependencies_target ON project_dependencies(depends_on_project_id);

CREATE TABLE IF NOT EXISTS initiative_labels (
  initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (initiative_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_initiative_labels_label ON initiative_labels(label_id);

CREATE TABLE IF NOT EXISTS initiative_updates (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES actors(id),
  health TEXT NOT NULL DEFAULT 'on_track' CHECK (health IN ('on_track', 'at_risk', 'off_track')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_initiative_updates_initiative ON initiative_updates(initiative_id, created_at);
