-- PRB-529: relación de suscriptores de Issue con alcance de Workspace.
CREATE TABLE issue_subscribers (
  issue_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  workspace_id TEXT,
  PRIMARY KEY (issue_id, actor_id),
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE
);
CREATE INDEX idx_issue_subscribers_actor ON issue_subscribers(actor_id, workspace_id);
CREATE INDEX idx_issue_subscribers_issue ON issue_subscribers(issue_id, workspace_id);

CREATE TRIGGER issue_subscribers_workspace_scope_insert
AFTER INSERT ON issue_subscribers
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE issue_subscribers
     SET workspace_id = (SELECT workspace_id FROM issues WHERE id = NEW.issue_id)
   WHERE issue_id = NEW.issue_id AND actor_id = NEW.actor_id;
END;

CREATE TRIGGER issue_subscribers_workspace_required_insert
BEFORE INSERT ON issue_subscribers
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for issue_subscribers');
END;
CREATE TRIGGER issue_subscribers_workspace_required_update
BEFORE UPDATE OF workspace_id ON issue_subscribers
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for issue_subscribers');
END;
