-- Actualizaciones narrativas de proyectos (PRB-207).
CREATE TABLE project_updates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES actors(id),
  health TEXT NOT NULL CHECK (health IN ('on_track', 'at_risk', 'off_track')),
  body TEXT NOT NULL,
  risks TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_project_updates_project ON project_updates(project_id, created_at);
