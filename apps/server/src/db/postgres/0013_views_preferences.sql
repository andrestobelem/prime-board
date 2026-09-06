-- PRB-390: CustomView-compatible scopes and persistent ViewPreferences/subscriptions.
-- PostgreSQL keeps the existing SavedView identity and extends it in place.
ALTER TABLE saved_views ADD COLUMN workspace_id TEXT;
UPDATE saved_views SET workspace_id = (SELECT id FROM workspace ORDER BY created_at, id LIMIT 1)
WHERE workspace_id IS NULL;
ALTER TABLE saved_views ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE saved_views ADD CONSTRAINT saved_views_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX idx_saved_views_workspace_id ON saved_views(workspace_id, id);

ALTER TABLE saved_views ADD COLUMN project_id TEXT;
ALTER TABLE saved_views ADD COLUMN initiative_id TEXT;

DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'saved_views'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%scope%'
  LOOP
    EXECUTE format('ALTER TABLE saved_views DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE saved_views ADD CONSTRAINT saved_views_scope_target_check CHECK (
  (scope = 'personal' AND team_id IS NULL AND project_id IS NULL AND initiative_id IS NULL)
  OR (scope = 'workspace' AND team_id IS NULL AND project_id IS NULL AND initiative_id IS NULL)
  OR (scope = 'team' AND team_id IS NOT NULL AND project_id IS NULL AND initiative_id IS NULL)
  OR (scope = 'project' AND project_id IS NOT NULL AND team_id IS NULL AND initiative_id IS NULL)
  OR (scope = 'initiative' AND initiative_id IS NOT NULL AND team_id IS NULL AND project_id IS NULL)
);
ALTER TABLE saved_views ADD CONSTRAINT saved_views_project_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE saved_views ADD CONSTRAINT saved_views_initiative_fkey
  FOREIGN KEY (initiative_id) REFERENCES initiatives(id) ON DELETE CASCADE;
CREATE INDEX idx_saved_views_project ON saved_views(project_id);
CREATE INDEX idx_saved_views_initiative ON saved_views(initiative_id);

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
  ON view_preferences(workspace_id, coalesce(view_id, ''), view_type, coalesce(actor_id, ''));
CREATE INDEX idx_view_preferences_view ON view_preferences(workspace_id, view_id);
CREATE INDEX idx_view_preferences_actor ON view_preferences(workspace_id, actor_id);

CREATE TABLE view_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  view_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  issue_changes BOOLEAN NOT NULL DEFAULT TRUE,
  slack BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, view_id, actor_id),
  CHECK (issue_changes OR slack),
  FOREIGN KEY (workspace_id, view_id) REFERENCES saved_views(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, actor_id) REFERENCES workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE
);
CREATE INDEX idx_view_subscriptions_view ON view_subscriptions(workspace_id, view_id);
CREATE INDEX idx_view_subscriptions_actor ON view_subscriptions(workspace_id, actor_id);
