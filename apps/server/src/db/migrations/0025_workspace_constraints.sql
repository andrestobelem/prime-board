-- PRB-472: endurece el alcance de Workspace en SQLite.
--
-- Las columnas workspace_id siguen siendo nullable durante la transición. En una
-- instalación singleton los triggers las completan para conservar compatibilidad.
-- Cuando hay más de un Workspace, una escritura sin contexto se rechaza.
-- Las referencias entre recursos usan FKs compuestas (workspace_id, id), para que
-- un ID válido en otro Workspace no sea una referencia válida aquí.

-- La tabla teams de 0001 tenía una unicidad global de key. Se reemplaza por una
-- unicidad parcial por Workspace durante el rebuild de las tablas relacionadas.
DROP TRIGGER IF EXISTS issues_fts_insert;
DROP TRIGGER IF EXISTS issues_fts_delete;
DROP TRIGGER IF EXISTS issues_fts_update;
DROP INDEX IF EXISTS idx_workspace_url_key;
-- SQLite exige que las columnas referidas existan al declarar una FK. Estas
-- columnas temporales se reemplazan por las definiciones completas más abajo.
ALTER TABLE workflow_states ADD COLUMN workspace_id TEXT;
ALTER TABLE milestones ADD COLUMN workspace_id TEXT;
ALTER TABLE activity ADD COLUMN workspace_id TEXT;

CREATE TABLE _prb25_teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  description TEXT,
  next_issue_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  default_state_id TEXT,
  archived_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  access_policy TEXT NOT NULL DEFAULT 'team_members'
    CHECK (access_policy IN ('workspace_members', 'team_members')),
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, default_state_id)
    REFERENCES workflow_states(workspace_id, id)
);
INSERT INTO _prb25_teams
  SELECT id, name, key, description, next_issue_number, created_at, updated_at,
         default_state_id, archived_at, visibility, access_policy, workspace_id
  FROM teams;

CREATE TABLE _prb25_workflow_states (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')),
  color TEXT NOT NULL,
  position REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  workspace_id TEXT,
  UNIQUE (workspace_id, id),
  UNIQUE (team_id, name),
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id)
);
INSERT INTO _prb25_workflow_states
  SELECT workflow_states.id, workflow_states.team_id, workflow_states.name, workflow_states.type,
         workflow_states.color, workflow_states.position, workflow_states.created_at,
         workflow_states.updated_at, teams.workspace_id
  FROM workflow_states JOIN teams ON teams.id = workflow_states.team_id;

CREATE TABLE _prb25_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'backlog' CHECK (state IN ('backlog', 'planned', 'started', 'paused', 'completed', 'canceled')),
  lead_id TEXT REFERENCES actors(id),
  target_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id)
);
INSERT INTO _prb25_projects
  SELECT id, name, description, state, lead_id, target_date, created_at, updated_at,
         archived_at, workspace_id
  FROM projects;

CREATE TABLE _prb25_milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  target_date TEXT,
  position REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  workspace_id TEXT,
  UNIQUE (workspace_id, id),
  UNIQUE (project_id, name),
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);
INSERT INTO _prb25_milestones
  SELECT milestones.id, milestones.project_id, milestones.name, milestones.description,
         milestones.target_date, milestones.position, milestones.created_at, milestones.updated_at,
         projects.workspace_id
  FROM milestones JOIN projects ON projects.id = milestones.project_id;

CREATE TABLE _prb25_issues (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  assignee_id TEXT REFERENCES actors(id),
  parent_id TEXT,
  project_id TEXT,
  creator_id TEXT NOT NULL REFERENCES actors(id),
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  milestone_id TEXT,
  cycle_id TEXT,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  UNIQUE (team_id, number),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id),
  FOREIGN KEY (workspace_id, state_id) REFERENCES workflow_states(workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES issues(workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, milestone_id) REFERENCES milestones(workspace_id, id),
  FOREIGN KEY (workspace_id, cycle_id) REFERENCES cycles(workspace_id, id)
);
INSERT INTO _prb25_issues
  SELECT issues.id, issues.team_id, issues.number, issues.title, issues.description,
         issues.state_id, issues.priority, issues.assignee_id, issues.parent_id, issues.project_id,
         issues.creator_id, issues.sort_order, issues.created_at, issues.updated_at, issues.archived_at,
         issues.milestone_id, issues.cycle_id, issues.workspace_id
  FROM issues;

CREATE TABLE _prb25_labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  team_id TEXT,
  created_at TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id)
);
INSERT INTO _prb25_labels SELECT id, name, color, team_id, created_at, workspace_id FROM labels;

CREATE TABLE _prb25_cycles (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('upcoming', 'active', 'completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  UNIQUE (team_id, number),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id)
);
INSERT INTO _prb25_cycles
  SELECT id, team_id, number, name, starts_at, ends_at, state, created_at, updated_at,
         archived_at, workspace_id
  FROM cycles;

CREATE TABLE _prb25_project_teams (
  project_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  workspace_id TEXT,
  PRIMARY KEY (project_id, team_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id)
);
INSERT INTO _prb25_project_teams
  SELECT project_teams.project_id, project_teams.team_id, projects.workspace_id
  FROM project_teams JOIN projects ON projects.id = project_teams.project_id;

CREATE TABLE _prb25_issue_labels (
  issue_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  workspace_id TEXT,
  PRIMARY KEY (issue_id, label_id),
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues(workspace_id, id),
  FOREIGN KEY (workspace_id, label_id) REFERENCES labels(workspace_id, id)
);
INSERT INTO _prb25_issue_labels
  SELECT issue_labels.issue_id, issue_labels.label_id, issues.workspace_id
  FROM issue_labels JOIN issues ON issues.id = issue_labels.issue_id;

CREATE TABLE _prb25_issue_relations (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  related_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('blocks', 'related', 'duplicate_of')),
  created_at TEXT NOT NULL,
  workspace_id TEXT,
  UNIQUE (issue_id, related_id, type),
  CHECK (issue_id != related_id),
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues(workspace_id, id),
  FOREIGN KEY (workspace_id, related_id) REFERENCES issues(workspace_id, id)
);
INSERT INTO _prb25_issue_relations
  SELECT issue_relations.id, issue_relations.issue_id, issue_relations.related_id,
         issue_relations.type, issue_relations.created_at, issues.workspace_id
  FROM issue_relations JOIN issues ON issues.id = issue_relations.issue_id;

CREATE TABLE _prb25_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  workspace_id TEXT,
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues(workspace_id, id)
);
INSERT INTO _prb25_comments
  SELECT comments.id, comments.issue_id, comments.actor_id, comments.body, comments.created_at,
         comments.edited_at, issues.workspace_id
  FROM comments JOIN issues ON issues.id = comments.issue_id;

CREATE TABLE _prb25_activity (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  workspace_id TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues(workspace_id, id)
);
INSERT INTO _prb25_activity
  SELECT activity.id, activity.issue_id, activity.actor_id, activity.type, activity.payload,
         activity.created_at, issues.workspace_id
  FROM activity JOIN issues ON issues.id = activity.issue_id;

CREATE TABLE _prb25_webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["*"]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  owner_id TEXT REFERENCES actors(id),
  team_id TEXT,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE
);
INSERT INTO _prb25_webhooks
  SELECT id, url, secret, events, enabled, created_at, owner_id, team_id, workspace_id FROM webhooks;

CREATE TABLE _prb25_saved_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'team', 'workspace')),
  team_id TEXT,
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
  CHECK ((scope = 'team' AND team_id IS NOT NULL) OR (scope != 'team' AND team_id IS NULL)),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id)
);
INSERT INTO _prb25_saved_views
  SELECT id, name, scope, team_id, owner_id, filter_json, order_by, group_by, created_at,
         updated_at, archived_at, columns_json, workspace_id
  FROM saved_views;

CREATE TABLE _prb25_reviews (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  requester_id TEXT NOT NULL REFERENCES actors(id),
  reviewer_id TEXT NOT NULL REFERENCES actors(id),
  status TEXT NOT NULL CHECK (status IN ('requested', 'in_progress', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues(workspace_id, id)
);
INSERT INTO _prb25_reviews
  SELECT reviews.id, reviews.issue_id, reviews.requester_id, reviews.reviewer_id, reviews.status,
         reviews.created_at, reviews.updated_at, reviews.workspace_id
  FROM reviews;

CREATE TABLE _prb25_initiatives (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned', 'active', 'completed', 'canceled')),
  target_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  owner_id TEXT REFERENCES actors(id),
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id)
);
INSERT INTO _prb25_initiatives
  SELECT id, name, description, state, target_date, created_at, updated_at, archived_at,
         owner_id, workspace_id
  FROM initiatives;

CREATE TABLE _prb25_initiative_projects (
  initiative_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_id TEXT,
  PRIMARY KEY (initiative_id, project_id),
  FOREIGN KEY (workspace_id, initiative_id) REFERENCES initiatives(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);
INSERT INTO _prb25_initiative_projects
  SELECT initiative_projects.initiative_id, initiative_projects.project_id, initiatives.workspace_id
  FROM initiative_projects JOIN initiatives ON initiatives.id = initiative_projects.initiative_id;

CREATE TABLE _prb25_initiative_teams (
  initiative_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  workspace_id TEXT,
  PRIMARY KEY (initiative_id, team_id),
  FOREIGN KEY (workspace_id, initiative_id) REFERENCES initiatives(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE
);
INSERT INTO _prb25_initiative_teams
  SELECT initiative_teams.initiative_id, initiative_teams.team_id, initiatives.workspace_id
  FROM initiative_teams JOIN initiatives ON initiatives.id = initiative_teams.initiative_id;

CREATE TABLE _prb25_project_updates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES actors(id),
  health TEXT NOT NULL CHECK (health IN ('on_track', 'at_risk', 'off_track')),
  body TEXT NOT NULL,
  risks TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
);
INSERT INTO _prb25_project_updates
  SELECT project_updates.id, project_updates.project_id, project_updates.author_id, project_updates.health,
         project_updates.body, project_updates.risks, project_updates.created_at, project_updates.updated_at,
         project_updates.workspace_id
  FROM project_updates;

CREATE TABLE _prb25_team_memberships (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  workspace_id TEXT,
  UNIQUE (team_id, actor_id),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE
);
INSERT INTO _prb25_team_memberships
  SELECT team_memberships.id, team_memberships.team_id, team_memberships.actor_id,
         team_memberships.role, team_memberships.created_at, teams.workspace_id
  FROM team_memberships JOIN teams ON teams.id = team_memberships.team_id;

CREATE TABLE _prb25_api_key_team_limits (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  workspace_id TEXT,
  PRIMARY KEY (api_key_id, team_id),
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE RESTRICT
);
INSERT INTO _prb25_api_key_team_limits
  SELECT api_key_team_limits.api_key_id, api_key_team_limits.team_id, teams.workspace_id
  FROM api_key_team_limits JOIN teams ON teams.id = api_key_team_limits.team_id;

CREATE TABLE _prb25_inbox_receipts (
  activity_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  read_at TEXT,
  archived_at TEXT,
  workspace_id TEXT,
  PRIMARY KEY (activity_id, actor_id),
  FOREIGN KEY (workspace_id, activity_id) REFERENCES activity(workspace_id, id) ON DELETE CASCADE
);
INSERT INTO _prb25_inbox_receipts
  SELECT inbox_receipts.activity_id, inbox_receipts.actor_id, inbox_receipts.read_at,
         inbox_receipts.archived_at, issues.workspace_id
  FROM inbox_receipts
  JOIN activity ON activity.id = inbox_receipts.activity_id
  JOIN issues ON issues.id = activity.issue_id;

CREATE TABLE _prb25_favorites (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  project_id TEXT,
  saved_view_id TEXT,
  position INTEGER NOT NULL CHECK (position >= 0 AND typeof(position) = 'integer'),
  created_at TEXT NOT NULL,
  workspace_id TEXT,
  CHECK ((project_id IS NOT NULL) != (saved_view_id IS NOT NULL)),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, saved_view_id) REFERENCES saved_views(workspace_id, id) ON DELETE CASCADE
);
INSERT INTO _prb25_favorites
  SELECT favorites.id, favorites.actor_id, favorites.project_id, favorites.saved_view_id,
         favorites.position, favorites.created_at,
         COALESCE(projects.workspace_id, saved_views.workspace_id)
  FROM favorites
  LEFT JOIN projects ON projects.id = favorites.project_id
  LEFT JOIN saved_views ON saved_views.id = favorites.saved_view_id;

CREATE TABLE _prb25_actor_invitations (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  type TEXT CHECK (type IN ('human', 'agent')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by TEXT NOT NULL REFERENCES actors(id),
  actor_id TEXT REFERENCES actors(id),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, id)
);
INSERT INTO _prb25_actor_invitations
  SELECT id, email, name, type, token_hash, status, invited_by, actor_id, metadata_json,
         created_at, expires_at, accepted_at, revoked_at, workspace_id
  FROM actor_invitations;

-- Los FKs antiguas apuntan a las tablas sin alcance. Con foreign_keys desactivadas
-- solo durante esta migración se pueden reemplazar todas las tablas de una vez.
DROP TABLE issue_relations;
DROP TABLE issue_labels;
DROP TABLE inbox_receipts;
DROP TABLE favorites;
DROP TABLE reviews;
DROP TABLE initiative_projects;
DROP TABLE initiative_teams;
DROP TABLE project_updates;
DROP TABLE project_teams;
DROP TABLE team_memberships;
DROP TABLE api_key_team_limits;
DROP TABLE comments;
DROP TABLE activity;
DROP TABLE actor_invitations;
DROP TABLE webhooks;
DROP TABLE saved_views;
DROP TABLE issues;
DROP TABLE milestones;
DROP TABLE cycles;
DROP TABLE labels;
DROP TABLE projects;
DROP TABLE initiatives;
DROP TABLE workflow_states;
DROP TABLE teams;

ALTER TABLE _prb25_teams RENAME TO teams;
ALTER TABLE _prb25_workflow_states RENAME TO workflow_states;
ALTER TABLE _prb25_projects RENAME TO projects;
ALTER TABLE _prb25_milestones RENAME TO milestones;
ALTER TABLE _prb25_issues RENAME TO issues;
ALTER TABLE _prb25_labels RENAME TO labels;
ALTER TABLE _prb25_cycles RENAME TO cycles;
ALTER TABLE _prb25_project_teams RENAME TO project_teams;
ALTER TABLE _prb25_issue_labels RENAME TO issue_labels;
ALTER TABLE _prb25_issue_relations RENAME TO issue_relations;
ALTER TABLE _prb25_comments RENAME TO comments;
ALTER TABLE _prb25_activity RENAME TO activity;
ALTER TABLE _prb25_webhooks RENAME TO webhooks;
ALTER TABLE _prb25_saved_views RENAME TO saved_views;
ALTER TABLE _prb25_reviews RENAME TO reviews;
ALTER TABLE _prb25_initiatives RENAME TO initiatives;
ALTER TABLE _prb25_initiative_projects RENAME TO initiative_projects;
ALTER TABLE _prb25_initiative_teams RENAME TO initiative_teams;
ALTER TABLE _prb25_project_updates RENAME TO project_updates;
ALTER TABLE _prb25_team_memberships RENAME TO team_memberships;
ALTER TABLE _prb25_api_key_team_limits RENAME TO api_key_team_limits;
ALTER TABLE _prb25_inbox_receipts RENAME TO inbox_receipts;
ALTER TABLE _prb25_favorites RENAME TO favorites;
ALTER TABLE _prb25_actor_invitations RENAME TO actor_invitations;

CREATE UNIQUE INDEX idx_workspace_url_key ON workspace(url_key);
CREATE UNIQUE INDEX idx_teams_workspace_key ON teams(workspace_id, key) WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX idx_teams_workspace_id ON teams(workspace_id, id);
CREATE UNIQUE INDEX idx_workflow_states_workspace_id ON workflow_states(workspace_id, id);
CREATE UNIQUE INDEX idx_projects_workspace_id ON projects(workspace_id, id);
CREATE UNIQUE INDEX idx_milestones_workspace_id ON milestones(workspace_id, id);
CREATE UNIQUE INDEX idx_issues_workspace_id ON issues(workspace_id, id);
CREATE UNIQUE INDEX idx_labels_workspace_id ON labels(workspace_id, id);
CREATE UNIQUE INDEX idx_cycles_workspace_id ON cycles(workspace_id, id);
CREATE UNIQUE INDEX idx_initiatives_workspace_id ON initiatives(workspace_id, id);
CREATE UNIQUE INDEX idx_saved_views_workspace_id ON saved_views(workspace_id, id);
CREATE UNIQUE INDEX idx_activity_workspace_id ON activity(workspace_id, id);
CREATE UNIQUE INDEX idx_project_updates_workspace_id ON project_updates(workspace_id, id);
CREATE UNIQUE INDEX idx_reviews_workspace_id ON reviews(workspace_id, id);
CREATE UNIQUE INDEX idx_webhooks_workspace_id ON webhooks(workspace_id, id);
CREATE UNIQUE INDEX idx_actor_invitations_workspace_id ON actor_invitations(workspace_id, id);
CREATE UNIQUE INDEX idx_workspace_labels_name ON labels(workspace_id, name)
  WHERE workspace_id IS NOT NULL AND team_id IS NULL;
CREATE UNIQUE INDEX idx_team_labels_name ON labels(workspace_id, team_id, name)
  WHERE workspace_id IS NOT NULL AND team_id IS NOT NULL;

CREATE INDEX idx_issues_team_state ON issues(team_id, state_id);
CREATE INDEX idx_issues_assignee ON issues(assignee_id);
CREATE INDEX idx_issues_project ON issues(project_id);
CREATE INDEX idx_issues_parent ON issues(parent_id);
CREATE INDEX idx_issues_milestone ON issues(milestone_id);
CREATE INDEX idx_issues_cycle ON issues(cycle_id);
CREATE INDEX idx_milestones_project ON milestones(project_id);
CREATE INDEX idx_project_teams_team ON project_teams(team_id);
CREATE INDEX idx_issue_relations_related ON issue_relations(related_id);
CREATE INDEX idx_comments_issue ON comments(issue_id);
CREATE INDEX idx_activity_issue ON activity(issue_id);
CREATE INDEX idx_webhooks_owner ON webhooks(owner_id);
CREATE INDEX idx_webhooks_team ON webhooks(team_id);
CREATE INDEX idx_saved_views_scope ON saved_views(scope, team_id);
CREATE INDEX idx_saved_views_owner ON saved_views(owner_id);
CREATE INDEX idx_reviews_reviewer ON reviews(reviewer_id, status);
CREATE INDEX idx_reviews_issue ON reviews(issue_id);
CREATE INDEX idx_initiative_projects_project ON initiative_projects(project_id);
CREATE INDEX idx_initiative_teams_team ON initiative_teams(team_id);
CREATE INDEX idx_project_updates_project ON project_updates(project_id, created_at);
CREATE INDEX idx_team_memberships_actor ON team_memberships(actor_id);
CREATE INDEX idx_api_key_team_limits_team ON api_key_team_limits(team_id);
CREATE INDEX idx_inbox_receipts_actor ON inbox_receipts(actor_id);
CREATE UNIQUE INDEX idx_favorites_actor_project ON favorites(actor_id, project_id)
  WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX idx_favorites_actor_saved_view ON favorites(actor_id, saved_view_id)
  WHERE saved_view_id IS NOT NULL;
CREATE INDEX idx_favorites_actor_position ON favorites(actor_id, position, created_at, id);
CREATE INDEX idx_actor_invitations_status ON actor_invitations(status, created_at);
CREATE INDEX idx_actor_invitations_actor ON actor_invitations(actor_id);
CREATE UNIQUE INDEX idx_actor_invitations_pending_email
  ON actor_invitations(workspace_id, lower(email))
  WHERE status = 'pending' AND email IS NOT NULL;

-- En singleton se conserva el comportamiento legacy. Con varios Workspaces,
-- el contexto debe ser explícito antes de insertar o limpiar una referencia.
CREATE TRIGGER issues_fts_insert AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(rowid, title, description)
  VALUES (new.rowid, new.title, coalesce(new.description, ''));
END;
CREATE TRIGGER issues_fts_delete AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, description)
  VALUES ('delete', old.rowid, old.title, coalesce(old.description, ''));
END;
CREATE TRIGGER issues_fts_update AFTER UPDATE OF title, description ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, description)
  VALUES ('delete', old.rowid, old.title, coalesce(old.description, ''));
  INSERT INTO issues_fts(rowid, title, description)
  VALUES (new.rowid, new.title, coalesce(new.description, ''));
END;

CREATE TRIGGER teams_workspace_scope_insert AFTER INSERT ON teams
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE teams SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;
CREATE TRIGGER projects_workspace_scope_insert AFTER INSERT ON projects
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE projects SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;
CREATE TRIGGER issues_workspace_scope_insert AFTER INSERT ON issues
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE issues SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;
CREATE TRIGGER labels_workspace_scope_insert AFTER INSERT ON labels
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE labels SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;
CREATE TRIGGER webhooks_workspace_scope_insert AFTER INSERT ON webhooks
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE webhooks SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;
CREATE TRIGGER saved_views_workspace_scope_insert AFTER INSERT ON saved_views
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE saved_views SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;
CREATE TRIGGER cycles_workspace_scope_insert AFTER INSERT ON cycles
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE cycles SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;
CREATE TRIGGER reviews_workspace_scope_insert AFTER INSERT ON reviews
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE reviews SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;
CREATE TRIGGER initiatives_workspace_scope_insert AFTER INSERT ON initiatives
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE initiatives SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;
CREATE TRIGGER project_updates_workspace_scope_insert AFTER INSERT ON project_updates
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE project_updates SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;
CREATE TRIGGER actor_invitations_workspace_scope_insert AFTER INSERT ON actor_invitations
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE actor_invitations SET workspace_id = (SELECT id FROM workspace) WHERE id = NEW.id;
END;

CREATE TRIGGER workflow_states_workspace_scope_insert AFTER INSERT ON workflow_states
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE workflow_states SET workspace_id = (SELECT workspace_id FROM teams WHERE id = NEW.team_id) WHERE id = NEW.id;
END;
CREATE TRIGGER milestones_workspace_scope_insert AFTER INSERT ON milestones
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE milestones SET workspace_id = (SELECT workspace_id FROM projects WHERE id = NEW.project_id) WHERE id = NEW.id;
END;
CREATE TRIGGER project_teams_workspace_scope_insert AFTER INSERT ON project_teams
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE project_teams SET workspace_id = (SELECT workspace_id FROM projects WHERE id = NEW.project_id)
  WHERE project_id = NEW.project_id AND team_id = NEW.team_id;
END;
CREATE TRIGGER issue_labels_workspace_scope_insert AFTER INSERT ON issue_labels
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE issue_labels SET workspace_id = (SELECT workspace_id FROM issues WHERE id = NEW.issue_id)
  WHERE issue_id = NEW.issue_id AND label_id = NEW.label_id;
END;
CREATE TRIGGER issue_relations_workspace_scope_insert AFTER INSERT ON issue_relations
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE issue_relations SET workspace_id = (SELECT workspace_id FROM issues WHERE id = NEW.issue_id)
  WHERE id = NEW.id;
END;
CREATE TRIGGER comments_workspace_scope_insert AFTER INSERT ON comments
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE comments SET workspace_id = (SELECT workspace_id FROM issues WHERE id = NEW.issue_id) WHERE id = NEW.id;
END;
CREATE TRIGGER activity_workspace_scope_insert AFTER INSERT ON activity
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE activity SET workspace_id = (SELECT workspace_id FROM issues WHERE id = NEW.issue_id) WHERE id = NEW.id;
END;
CREATE TRIGGER team_memberships_workspace_scope_insert AFTER INSERT ON team_memberships
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE team_memberships SET workspace_id = (SELECT workspace_id FROM teams WHERE id = NEW.team_id) WHERE id = NEW.id;
END;
CREATE TRIGGER api_key_team_limits_workspace_scope_insert AFTER INSERT ON api_key_team_limits
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE api_key_team_limits SET workspace_id = (SELECT workspace_id FROM teams WHERE id = NEW.team_id)
  WHERE api_key_id = NEW.api_key_id AND team_id = NEW.team_id;
END;
CREATE TRIGGER inbox_receipts_workspace_scope_insert AFTER INSERT ON inbox_receipts
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE inbox_receipts SET workspace_id = (SELECT workspace_id FROM activity WHERE id = NEW.activity_id)
  WHERE activity_id = NEW.activity_id AND actor_id = NEW.actor_id;
END;
CREATE TRIGGER favorites_workspace_scope_insert AFTER INSERT ON favorites
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE favorites SET workspace_id = COALESCE(
    (SELECT workspace_id FROM projects WHERE id = NEW.project_id),
    (SELECT workspace_id FROM saved_views WHERE id = NEW.saved_view_id)
  ) WHERE id = NEW.id;
END;
CREATE TRIGGER initiative_projects_workspace_scope_insert AFTER INSERT ON initiative_projects
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE initiative_projects SET workspace_id = (SELECT workspace_id FROM initiatives WHERE id = NEW.initiative_id)
  WHERE initiative_id = NEW.initiative_id AND project_id = NEW.project_id;
END;
CREATE TRIGGER initiative_teams_workspace_scope_insert AFTER INSERT ON initiative_teams
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) = 1 BEGIN
  UPDATE initiative_teams SET workspace_id = (SELECT workspace_id FROM initiatives WHERE id = NEW.initiative_id)
  WHERE initiative_id = NEW.initiative_id AND team_id = NEW.team_id;
END;

-- A partir de dos Workspaces no se acepta NULL como bypass de las FKs compuestas.
CREATE TRIGGER teams_workspace_required_insert BEFORE INSERT ON teams
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for teams');
END;
CREATE TRIGGER teams_workspace_required_update BEFORE UPDATE OF workspace_id ON teams
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for teams');
END;
CREATE TRIGGER workflow_states_workspace_required_insert BEFORE INSERT ON workflow_states
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for workflow_states');
END;
CREATE TRIGGER workflow_states_workspace_required_update BEFORE UPDATE OF workspace_id ON workflow_states
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for workflow_states');
END;
CREATE TRIGGER projects_workspace_required_insert BEFORE INSERT ON projects
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for projects');
END;
CREATE TRIGGER projects_workspace_required_update BEFORE UPDATE OF workspace_id ON projects
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for projects');
END;
CREATE TRIGGER milestones_workspace_required_insert BEFORE INSERT ON milestones
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for milestones');
END;
CREATE TRIGGER milestones_workspace_required_update BEFORE UPDATE OF workspace_id ON milestones
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for milestones');
END;
CREATE TRIGGER issues_workspace_required_insert BEFORE INSERT ON issues
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for issues');
END;
CREATE TRIGGER issues_workspace_required_update BEFORE UPDATE OF workspace_id ON issues
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for issues');
END;
CREATE TRIGGER labels_workspace_required_insert BEFORE INSERT ON labels
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for labels');
END;
CREATE TRIGGER labels_workspace_required_update BEFORE UPDATE OF workspace_id ON labels
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for labels');
END;
CREATE TRIGGER cycles_workspace_required_insert BEFORE INSERT ON cycles
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for cycles');
END;
CREATE TRIGGER cycles_workspace_required_update BEFORE UPDATE OF workspace_id ON cycles
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for cycles');
END;
CREATE TRIGGER project_teams_workspace_required_insert BEFORE INSERT ON project_teams
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for project_teams');
END;
CREATE TRIGGER project_teams_workspace_required_update BEFORE UPDATE OF workspace_id ON project_teams
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for project_teams');
END;
CREATE TRIGGER issue_labels_workspace_required_insert BEFORE INSERT ON issue_labels
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for issue_labels');
END;
CREATE TRIGGER issue_labels_workspace_required_update BEFORE UPDATE OF workspace_id ON issue_labels
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for issue_labels');
END;
CREATE TRIGGER issue_relations_workspace_required_insert BEFORE INSERT ON issue_relations
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for issue_relations');
END;
CREATE TRIGGER issue_relations_workspace_required_update BEFORE UPDATE OF workspace_id ON issue_relations
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for issue_relations');
END;
CREATE TRIGGER comments_workspace_required_insert BEFORE INSERT ON comments
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for comments');
END;
CREATE TRIGGER comments_workspace_required_update BEFORE UPDATE OF workspace_id ON comments
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for comments');
END;
CREATE TRIGGER activity_workspace_required_insert BEFORE INSERT ON activity
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for activity');
END;
CREATE TRIGGER activity_workspace_required_update BEFORE UPDATE OF workspace_id ON activity
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for activity');
END;
CREATE TRIGGER webhooks_workspace_required_insert BEFORE INSERT ON webhooks
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for webhooks');
END;
CREATE TRIGGER webhooks_workspace_required_update BEFORE UPDATE OF workspace_id ON webhooks
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for webhooks');
END;
CREATE TRIGGER saved_views_workspace_required_insert BEFORE INSERT ON saved_views
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for saved_views');
END;
CREATE TRIGGER saved_views_workspace_required_update BEFORE UPDATE OF workspace_id ON saved_views
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for saved_views');
END;
CREATE TRIGGER reviews_workspace_required_insert BEFORE INSERT ON reviews
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for reviews');
END;
CREATE TRIGGER reviews_workspace_required_update BEFORE UPDATE OF workspace_id ON reviews
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for reviews');
END;
CREATE TRIGGER initiatives_workspace_required_insert BEFORE INSERT ON initiatives
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for initiatives');
END;
CREATE TRIGGER initiatives_workspace_required_update BEFORE UPDATE OF workspace_id ON initiatives
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for initiatives');
END;
CREATE TRIGGER initiative_projects_workspace_required_insert BEFORE INSERT ON initiative_projects
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for initiative_projects');
END;
CREATE TRIGGER initiative_projects_workspace_required_update BEFORE UPDATE OF workspace_id ON initiative_projects
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for initiative_projects');
END;
CREATE TRIGGER initiative_teams_workspace_required_insert BEFORE INSERT ON initiative_teams
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for initiative_teams');
END;
CREATE TRIGGER initiative_teams_workspace_required_update BEFORE UPDATE OF workspace_id ON initiative_teams
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for initiative_teams');
END;
CREATE TRIGGER project_updates_workspace_required_insert BEFORE INSERT ON project_updates
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for project_updates');
END;
CREATE TRIGGER project_updates_workspace_required_update BEFORE UPDATE OF workspace_id ON project_updates
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for project_updates');
END;
CREATE TRIGGER team_memberships_workspace_required_insert BEFORE INSERT ON team_memberships
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for team_memberships');
END;
CREATE TRIGGER team_memberships_workspace_required_update BEFORE UPDATE OF workspace_id ON team_memberships
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for team_memberships');
END;
CREATE TRIGGER api_key_team_limits_workspace_required_insert BEFORE INSERT ON api_key_team_limits
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for api_key_team_limits');
END;
CREATE TRIGGER api_key_team_limits_workspace_required_update BEFORE UPDATE OF workspace_id ON api_key_team_limits
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for api_key_team_limits');
END;
CREATE TRIGGER inbox_receipts_workspace_required_insert BEFORE INSERT ON inbox_receipts
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for inbox_receipts');
END;
CREATE TRIGGER inbox_receipts_workspace_required_update BEFORE UPDATE OF workspace_id ON inbox_receipts
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for inbox_receipts');
END;
CREATE TRIGGER favorites_workspace_required_insert BEFORE INSERT ON favorites
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for favorites');
END;
CREATE TRIGGER favorites_workspace_required_update BEFORE UPDATE OF workspace_id ON favorites
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for favorites');
END;
CREATE TRIGGER actor_invitations_workspace_required_insert BEFORE INSERT ON actor_invitations
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for actor_invitations');
END;
CREATE TRIGGER actor_invitations_workspace_required_update BEFORE UPDATE OF workspace_id ON actor_invitations
WHEN NEW.workspace_id IS NULL AND (SELECT count(*) FROM workspace) > 1 BEGIN
  SELECT RAISE(ABORT, 'Workspace context is required for actor_invitations');
END;
