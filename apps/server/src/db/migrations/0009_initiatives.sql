-- Iniciativas de workspace (PRB-206).
CREATE TABLE initiatives (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned', 'active', 'completed', 'canceled')),
  target_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE initiative_projects (
  initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (initiative_id, project_id)
);
CREATE INDEX idx_initiative_projects_project ON initiative_projects(project_id);
