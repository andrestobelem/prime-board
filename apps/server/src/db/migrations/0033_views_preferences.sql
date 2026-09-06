-- PRB-390: ámbitos compatibles con CustomView y preferencias/suscripciones persistentes.
-- Conserva todas las filas de SavedView al ampliar el alcance permitido.
CREATE TABLE _prb390_saved_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'team', 'workspace', 'project', 'initiative')),
  team_id TEXT,
  project_id TEXT,
  initiative_id TEXT,
  owner_id TEXT NOT NULL REFERENCES actors(id),
  filter_json TEXT NOT NULL DEFAULT '{}',
  order_by TEXT NOT NULL DEFAULT 'CREATED_DESC',
  group_by TEXT NOT NULL DEFAULT 'state',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  columns_json TEXT NOT NULL DEFAULT '[]',
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  CHECK (
    (scope = 'team' AND team_id IS NOT NULL AND project_id IS NULL AND initiative_id IS NULL)
    OR (scope = 'project' AND project_id IS NOT NULL AND team_id IS NULL AND initiative_id IS NULL)
    OR (scope = 'initiative' AND initiative_id IS NOT NULL AND team_id IS NULL AND project_id IS NULL)
    OR (scope IN ('personal', 'workspace') AND team_id IS NULL AND project_id IS NULL AND initiative_id IS NULL)
  ),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, initiative_id) REFERENCES initiatives(workspace_id, id)
);

INSERT INTO _prb390_saved_views (
  id, name, scope, team_id, project_id, initiative_id, owner_id, filter_json, order_by, group_by,
  created_at, updated_at, archived_at, columns_json, workspace_id
)
SELECT id, name, scope, team_id, NULL, NULL, owner_id, filter_json, order_by, group_by,
       created_at, updated_at, archived_at, columns_json, workspace_id
FROM saved_views;

-- Los Favorites existentes conservan la referencia saved_view_id por nombre. El runner
-- desactiva las comprobaciones FK de SQLite durante el reemplazo y las restaura después.
DROP TABLE saved_views;
ALTER TABLE _prb390_saved_views RENAME TO saved_views;

CREATE INDEX idx_saved_views_scope ON saved_views(scope, team_id);
CREATE INDEX idx_saved_views_owner ON saved_views(owner_id);
CREATE INDEX idx_saved_views_project ON saved_views(workspace_id, project_id);
CREATE INDEX idx_saved_views_initiative ON saved_views(workspace_id, initiative_id);

CREATE TRIGGER saved_views_workspace_scope_insert
AFTER INSERT ON saved_views
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE saved_views SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

CREATE TRIGGER saved_views_workspace_required_insert
BEFORE INSERT ON saved_views
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for saved_views');
END;

CREATE TRIGGER saved_views_workspace_required_update
BEFORE UPDATE OF workspace_id ON saved_views
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1
BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for saved_views');
END;

CREATE TABLE view_preferences (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  view_id TEXT,
  actor_id TEXT,
  view_type TEXT NOT NULL DEFAULT 'issue' CHECK (view_type IN ('issue', 'project', 'initiative', 'feed')),
  scope TEXT NOT NULL CHECK (scope IN ('actor', 'workspace')),
  layout TEXT NOT NULL DEFAULT 'list' CHECK (layout IN ('list', 'board')),
  order_by TEXT NOT NULL DEFAULT 'UPDATED_DESC' CHECK (order_by IN ('CREATED_ASC', 'CREATED_DESC', 'UPDATED_ASC', 'UPDATED_DESC')),
  group_by TEXT NOT NULL DEFAULT 'state' CHECK (group_by IN ('state', 'milestone', 'assignee', 'priority')),
  columns_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  CHECK ((scope = 'actor' AND actor_id IS NOT NULL) OR (scope = 'workspace' AND actor_id IS NULL)),
  FOREIGN KEY (workspace_id, view_id) REFERENCES saved_views(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_view_preferences_key
  ON view_preferences(workspace_id, ifnull(view_id, ''), view_type, ifnull(actor_id, ''));
CREATE INDEX idx_view_preferences_view ON view_preferences(workspace_id, view_id);
CREATE INDEX idx_view_preferences_actor ON view_preferences(workspace_id, actor_id);

CREATE TABLE view_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  issue_changes INTEGER NOT NULL DEFAULT 1 CHECK (issue_changes IN (0, 1)),
  slack INTEGER NOT NULL DEFAULT 0 CHECK (slack IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, view_id, actor_id),
  CHECK (issue_changes = 1 OR slack = 1),
  FOREIGN KEY (workspace_id, view_id) REFERENCES saved_views(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE
);
CREATE INDEX idx_view_subscriptions_view ON view_subscriptions(workspace_id, view_id);
CREATE INDEX idx_view_subscriptions_actor ON view_subscriptions(workspace_id, actor_id);
