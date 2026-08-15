-- Milestones dentro de proyectos (AT-29): sub-estructura ordenada, como en Linear.
CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  description TEXT,
  target_date TEXT,
  position REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);
CREATE INDEX idx_milestones_project ON milestones(project_id);

ALTER TABLE issues ADD COLUMN milestone_id TEXT REFERENCES milestones(id);
CREATE INDEX idx_issues_milestone ON issues(milestone_id);
