-- PRB-529: relación de suscriptores de issues.
-- PostgreSQL mantiene una única fila de Workspace por instalación; la columna
-- conserva el alcance explícito para exportaciones y la futura multi-tenancy.
CREATE TABLE issue_subscribers (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, actor_id)
);
CREATE INDEX idx_issue_subscribers_actor ON issue_subscribers(actor_id, workspace_id);
CREATE INDEX idx_issue_subscribers_issue ON issue_subscribers(issue_id, workspace_id);
