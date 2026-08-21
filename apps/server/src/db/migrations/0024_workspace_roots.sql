-- PRB-471: prepara el esquema SQLite para varios Workspaces.
--
-- Las columnas workspace_id son nullable durante esta transición para que una
-- base vacía pueda migrar antes del bootstrap. La migración las backfillea
-- cuando existe el único Workspace legacy. Los triggers mantienen ese backfill
-- para las escrituras single-workspace hasta que PRB-413 introduzca el
-- WorkspaceContext seleccionable; PRB-472 endurecerá las invariantes compuestas.

CREATE TABLE workspace_memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'left')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  suspended_at TEXT,
  suspended_by TEXT REFERENCES actors(id),
  left_at TEXT,
  UNIQUE (workspace_id, actor_id)
);
CREATE INDEX idx_workspace_memberships_actor_workspace
  ON workspace_memberships(actor_id, workspace_id);
CREATE INDEX idx_workspace_memberships_workspace_status_role
  ON workspace_memberships(workspace_id, status, role);

ALTER TABLE teams ADD COLUMN workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE projects ADD COLUMN workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE issues ADD COLUMN workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE labels ADD COLUMN workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE webhooks ADD COLUMN workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE saved_views ADD COLUMN workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE cycles ADD COLUMN workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE reviews ADD COLUMN workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE initiatives ADD COLUMN workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE project_updates ADD COLUMN workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE actor_invitations ADD COLUMN workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE;

-- Un solo Workspace legacy es la única asignación inequívoca. Con cero filas
-- no hay recursos que backfillear; con varias filas database.ts aborta antes.
UPDATE teams SET workspace_id = (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1);
UPDATE projects SET workspace_id = (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1);
UPDATE issues SET workspace_id = (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1);
UPDATE labels SET workspace_id = (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1);
UPDATE webhooks SET workspace_id = (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1);
UPDATE saved_views SET workspace_id = (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1);
UPDATE cycles SET workspace_id = (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1);
UPDATE reviews SET workspace_id = (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1);
UPDATE initiatives SET workspace_id = (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1);
UPDATE project_updates SET workspace_id = (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1);
UPDATE actor_invitations SET workspace_id = (SELECT id FROM workspace WHERE (SELECT count(*) FROM workspace) = 1);

CREATE UNIQUE INDEX idx_workspace_url_key ON workspace(url_key);
CREATE INDEX idx_teams_workspace ON teams(workspace_id);
CREATE INDEX idx_projects_workspace ON projects(workspace_id);
CREATE INDEX idx_issues_workspace ON issues(workspace_id);
CREATE INDEX idx_labels_workspace ON labels(workspace_id);
CREATE INDEX idx_webhooks_workspace ON webhooks(workspace_id);
CREATE INDEX idx_saved_views_workspace ON saved_views(workspace_id);
CREATE INDEX idx_cycles_workspace ON cycles(workspace_id);
CREATE INDEX idx_reviews_workspace ON reviews(workspace_id);
CREATE INDEX idx_initiatives_workspace ON initiatives(workspace_id);
CREATE INDEX idx_project_updates_workspace ON project_updates(workspace_id);
CREATE INDEX idx_actor_invitations_workspace ON actor_invitations(workspace_id);

-- El ID determinista permite repetir el backfill sin generar identidades nuevas.
INSERT INTO workspace_memberships (
  id, workspace_id, actor_id, role, status, created_at, updated_at,
  suspended_at, suspended_by, left_at
)
SELECT workspace.id || ':' || actors.id,
       workspace.id,
       actors.id,
       actors.workspace_role,
       actors.status,
       actors.created_at,
       actors.updated_at,
       actors.suspended_at,
       actors.suspended_by,
       actors.left_at
FROM workspace CROSS JOIN actors
WHERE (SELECT count(*) FROM workspace) = 1;

-- Compatibilidad single-workspace para código que todavía no recibe un
-- WorkspaceContext explícito. Un futuro WorkspaceCreate debe enviar el ID de
-- forma explícita y podrá retirar estos triggers.
CREATE TRIGGER teams_workspace_scope_insert
AFTER INSERT ON teams
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE teams SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

CREATE TRIGGER projects_workspace_scope_insert
AFTER INSERT ON projects
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE projects SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

CREATE TRIGGER issues_workspace_scope_insert
AFTER INSERT ON issues
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE issues SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

CREATE TRIGGER labels_workspace_scope_insert
AFTER INSERT ON labels
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE labels SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

CREATE TRIGGER webhooks_workspace_scope_insert
AFTER INSERT ON webhooks
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE webhooks SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

CREATE TRIGGER saved_views_workspace_scope_insert
AFTER INSERT ON saved_views
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE saved_views SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

CREATE TRIGGER cycles_workspace_scope_insert
AFTER INSERT ON cycles
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE cycles SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

CREATE TRIGGER reviews_workspace_scope_insert
AFTER INSERT ON reviews
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE reviews SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

CREATE TRIGGER initiatives_workspace_scope_insert
AFTER INSERT ON initiatives
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE initiatives SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

CREATE TRIGGER project_updates_workspace_scope_insert
AFTER INSERT ON project_updates
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE project_updates SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

CREATE TRIGGER actor_invitations_workspace_scope_insert
AFTER INSERT ON actor_invitations
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE actor_invitations SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

-- Actor es una identidad global. Durante la transición, crear o cambiar un
-- Actor en una instalación singleton mantiene sincronizada su Membership.
CREATE TRIGGER actors_workspace_membership_insert
AFTER INSERT ON actors
WHEN (SELECT count(*) FROM workspace) = 1
BEGIN
  INSERT INTO workspace_memberships (
    id, workspace_id, actor_id, role, status, created_at, updated_at,
    suspended_at, suspended_by, left_at
  )
  SELECT workspace.id || ':' || NEW.id,
         workspace.id,
         NEW.id,
         NEW.workspace_role,
         NEW.status,
         NEW.created_at,
         NEW.updated_at,
         NEW.suspended_at,
         NEW.suspended_by,
         NEW.left_at
  FROM workspace
  WHERE NOT EXISTS (
    SELECT 1 FROM workspace_memberships
    WHERE workspace_id = workspace.id AND actor_id = NEW.id
  );
END;

CREATE TRIGGER actors_workspace_membership_update
AFTER UPDATE OF workspace_role, status, suspended_at, suspended_by, left_at, updated_at ON actors
WHEN (SELECT count(*) FROM workspace) = 1
BEGIN
  UPDATE workspace_memberships
  SET role = NEW.workspace_role,
      status = NEW.status,
      updated_at = NEW.updated_at,
      suspended_at = NEW.suspended_at,
      suspended_by = NEW.suspended_by,
      left_at = NEW.left_at
  WHERE actor_id = NEW.id
    AND workspace_id = (SELECT id FROM workspace);
END;
