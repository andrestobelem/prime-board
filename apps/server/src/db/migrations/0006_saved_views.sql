-- Vistas guardadas (PRB-201): filtros/orden/agrupación reutilizables.
CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'team', 'workspace')),
  team_id TEXT REFERENCES teams(id),
  owner_id TEXT NOT NULL REFERENCES actors(id),
  filter_json TEXT NOT NULL DEFAULT '{}',
  order_by TEXT NOT NULL DEFAULT 'CREATED_DESC',
  group_by TEXT NOT NULL DEFAULT 'state',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope = 'team' AND team_id IS NOT NULL)
    OR (scope != 'team' AND team_id IS NULL)
  )
);

CREATE INDEX idx_saved_views_scope ON saved_views(scope, team_id);
CREATE INDEX idx_saved_views_owner ON saved_views(owner_id);
