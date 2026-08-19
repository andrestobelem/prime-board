-- Baseline PostgreSQL equivalente al esquema SQLite vigente (PRB-427).
-- Las fechas e IDs se mantienen como TEXT para conservar el formato de la réplica.
-- Los campos JSON conservan su representación TEXT actual y la búsqueda usa un tsvector derivado.
-- Se usa la configuración built-in simple; no se requiere la extensión unaccent en el baseline.
BEGIN;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  type TEXT NOT NULL CHECK (type IN ('human', 'agent')),
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  workspace_role TEXT NOT NULL DEFAULT 'member' CHECK (workspace_role IN ('admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'left')),
  suspended_at TEXT,
  suspended_by TEXT,
  left_at TEXT
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  description TEXT,
  next_issue_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  default_state_id TEXT,
  archived_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  access_policy TEXT NOT NULL DEFAULT 'team_members'
    CHECK (access_policy IN ('workspace_members', 'team_members'))
);

CREATE TABLE workflow_states (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled')),
  color TEXT NOT NULL,
  position DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (team_id, name)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'backlog'
    CHECK (state IN ('backlog', 'planned', 'started', 'paused', 'completed', 'canceled')),
  lead_id TEXT,
  target_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  target_date TEXT,
  position DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE cycles (
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
  UNIQUE (team_id, number)
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  assignee_id TEXT,
  parent_id TEXT,
  project_id TEXT,
  creator_id TEXT NOT NULL,
  sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  milestone_id TEXT,
  cycle_id TEXT,
  search_vector TSVECTOR NOT NULL DEFAULT ''::tsvector,
  UNIQUE (team_id, number)
);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  team_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (team_id, name)
);

CREATE TABLE project_teams (
  project_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  PRIMARY KEY (project_id, team_id)
);

CREATE TABLE issue_labels (
  issue_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (issue_id, label_id)
);

CREATE TABLE issue_relations (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  related_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('blocks', 'related', 'duplicate_of')),
  created_at TEXT NOT NULL,
  UNIQUE (issue_id, related_id, type),
  CHECK (issue_id <> related_id)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT
);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["*"]',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  owner_id TEXT,
  team_id TEXT
);

CREATE TABLE saved_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'team', 'workspace')),
  team_id TEXT,
  owner_id TEXT NOT NULL,
  filter_json TEXT NOT NULL DEFAULT '{}',
  order_by TEXT NOT NULL DEFAULT 'CREATED_DESC',
  group_by TEXT NOT NULL DEFAULT 'state',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  columns_json TEXT NOT NULL DEFAULT '[]',
  CHECK (
    (scope = 'team' AND team_id IS NOT NULL)
    OR (scope <> 'team' AND team_id IS NULL)
  )
);

CREATE TABLE team_memberships (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  UNIQUE (team_id, actor_id)
);

CREATE TABLE initiatives (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned', 'active', 'completed', 'canceled')),
  target_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  owner_id TEXT
);

CREATE TABLE initiative_projects (
  initiative_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (initiative_id, project_id)
);

CREATE TABLE initiative_teams (
  initiative_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  PRIMARY KEY (initiative_id, team_id)
);

CREATE TABLE project_updates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  health TEXT NOT NULL CHECK (health IN ('on_track', 'at_risk', 'off_track')),
  body TEXT NOT NULL,
  risks TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'in_progress', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE inbox_receipts (
  activity_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  read_at TEXT,
  archived_at TEXT,
  PRIMARY KEY (activity_id, actor_id)
);

CREATE TABLE favorites (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  project_id TEXT,
  saved_view_id TEXT,
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  CHECK ((project_id IS NOT NULL) <> (saved_view_id IS NOT NULL))
);

CREATE TABLE actor_invitations (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  type TEXT CHECK (type IN ('human', 'agent')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by TEXT NOT NULL,
  actor_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  expires_at TEXT,
  rotated_from_id TEXT
);

CREATE TABLE api_key_scopes (
  api_key_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write', 'admin')),
  PRIMARY KEY (api_key_id, scope)
);

CREATE TABLE api_key_team_limits (
  api_key_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  PRIMARY KEY (api_key_id, team_id)
);

-- Foreign keys se agregan tras crear todas las tablas para permitir el ciclo
-- teams ↔ workflow_states y las referencias recursivas de actors/issues.
ALTER TABLE actors ADD CONSTRAINT actors_suspended_by_fkey
  FOREIGN KEY (suspended_by) REFERENCES actors(id);
ALTER TABLE teams ADD CONSTRAINT teams_default_state_fkey
  FOREIGN KEY (default_state_id) REFERENCES workflow_states(id);
ALTER TABLE workflow_states ADD CONSTRAINT workflow_states_team_fkey
  FOREIGN KEY (team_id) REFERENCES teams(id);
ALTER TABLE projects ADD CONSTRAINT projects_lead_fkey
  FOREIGN KEY (lead_id) REFERENCES actors(id);
ALTER TABLE milestones ADD CONSTRAINT milestones_project_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE cycles ADD CONSTRAINT cycles_team_fkey
  FOREIGN KEY (team_id) REFERENCES teams(id);
ALTER TABLE issues ADD CONSTRAINT issues_team_fkey
  FOREIGN KEY (team_id) REFERENCES teams(id);
ALTER TABLE issues ADD CONSTRAINT issues_state_fkey
  FOREIGN KEY (state_id) REFERENCES workflow_states(id);
ALTER TABLE issues ADD CONSTRAINT issues_assignee_fkey
  FOREIGN KEY (assignee_id) REFERENCES actors(id);
ALTER TABLE issues ADD CONSTRAINT issues_parent_fkey
  FOREIGN KEY (parent_id) REFERENCES issues(id);
ALTER TABLE issues ADD CONSTRAINT issues_project_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE issues ADD CONSTRAINT issues_creator_fkey
  FOREIGN KEY (creator_id) REFERENCES actors(id);
ALTER TABLE issues ADD CONSTRAINT issues_milestone_fkey
  FOREIGN KEY (milestone_id) REFERENCES milestones(id);
ALTER TABLE issues ADD CONSTRAINT issues_cycle_fkey
  FOREIGN KEY (cycle_id) REFERENCES cycles(id);
ALTER TABLE labels ADD CONSTRAINT labels_team_fkey
  FOREIGN KEY (team_id) REFERENCES teams(id);
ALTER TABLE project_teams ADD CONSTRAINT project_teams_project_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE project_teams ADD CONSTRAINT project_teams_team_fkey
  FOREIGN KEY (team_id) REFERENCES teams(id);
ALTER TABLE issue_labels ADD CONSTRAINT issue_labels_issue_fkey
  FOREIGN KEY (issue_id) REFERENCES issues(id);
ALTER TABLE issue_labels ADD CONSTRAINT issue_labels_label_fkey
  FOREIGN KEY (label_id) REFERENCES labels(id);
ALTER TABLE issue_relations ADD CONSTRAINT issue_relations_issue_fkey
  FOREIGN KEY (issue_id) REFERENCES issues(id);
ALTER TABLE issue_relations ADD CONSTRAINT issue_relations_related_fkey
  FOREIGN KEY (related_id) REFERENCES issues(id);
ALTER TABLE comments ADD CONSTRAINT comments_issue_fkey
  FOREIGN KEY (issue_id) REFERENCES issues(id);
ALTER TABLE comments ADD CONSTRAINT comments_actor_fkey
  FOREIGN KEY (actor_id) REFERENCES actors(id);
ALTER TABLE activity ADD CONSTRAINT activity_issue_fkey
  FOREIGN KEY (issue_id) REFERENCES issues(id);
ALTER TABLE activity ADD CONSTRAINT activity_actor_fkey
  FOREIGN KEY (actor_id) REFERENCES actors(id);
ALTER TABLE webhooks ADD CONSTRAINT webhooks_owner_fkey
  FOREIGN KEY (owner_id) REFERENCES actors(id);
ALTER TABLE webhooks ADD CONSTRAINT webhooks_team_fkey
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
ALTER TABLE saved_views ADD CONSTRAINT saved_views_team_fkey
  FOREIGN KEY (team_id) REFERENCES teams(id);
ALTER TABLE saved_views ADD CONSTRAINT saved_views_owner_fkey
  FOREIGN KEY (owner_id) REFERENCES actors(id);
ALTER TABLE team_memberships ADD CONSTRAINT team_memberships_team_fkey
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
ALTER TABLE team_memberships ADD CONSTRAINT team_memberships_actor_fkey
  FOREIGN KEY (actor_id) REFERENCES actors(id) ON DELETE CASCADE;
ALTER TABLE initiatives ADD CONSTRAINT initiatives_owner_fkey
  FOREIGN KEY (owner_id) REFERENCES actors(id);
ALTER TABLE initiative_projects ADD CONSTRAINT initiative_projects_initiative_fkey
  FOREIGN KEY (initiative_id) REFERENCES initiatives(id) ON DELETE CASCADE;
ALTER TABLE initiative_projects ADD CONSTRAINT initiative_projects_project_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE initiative_teams ADD CONSTRAINT initiative_teams_initiative_fkey
  FOREIGN KEY (initiative_id) REFERENCES initiatives(id) ON DELETE CASCADE;
ALTER TABLE initiative_teams ADD CONSTRAINT initiative_teams_team_fkey
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
ALTER TABLE project_updates ADD CONSTRAINT project_updates_project_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE project_updates ADD CONSTRAINT project_updates_author_fkey
  FOREIGN KEY (author_id) REFERENCES actors(id);
ALTER TABLE reviews ADD CONSTRAINT reviews_issue_fkey
  FOREIGN KEY (issue_id) REFERENCES issues(id);
ALTER TABLE reviews ADD CONSTRAINT reviews_requester_fkey
  FOREIGN KEY (requester_id) REFERENCES actors(id);
ALTER TABLE reviews ADD CONSTRAINT reviews_reviewer_fkey
  FOREIGN KEY (reviewer_id) REFERENCES actors(id);
ALTER TABLE inbox_receipts ADD CONSTRAINT inbox_receipts_activity_fkey
  FOREIGN KEY (activity_id) REFERENCES activity(id) ON DELETE CASCADE;
ALTER TABLE inbox_receipts ADD CONSTRAINT inbox_receipts_actor_fkey
  FOREIGN KEY (actor_id) REFERENCES actors(id) ON DELETE CASCADE;
ALTER TABLE favorites ADD CONSTRAINT favorites_actor_fkey
  FOREIGN KEY (actor_id) REFERENCES actors(id) ON DELETE CASCADE;
ALTER TABLE favorites ADD CONSTRAINT favorites_project_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE favorites ADD CONSTRAINT favorites_saved_view_fkey
  FOREIGN KEY (saved_view_id) REFERENCES saved_views(id) ON DELETE CASCADE;
ALTER TABLE actor_invitations ADD CONSTRAINT actor_invitations_invited_by_fkey
  FOREIGN KEY (invited_by) REFERENCES actors(id);
ALTER TABLE actor_invitations ADD CONSTRAINT actor_invitations_actor_fkey
  FOREIGN KEY (actor_id) REFERENCES actors(id);
ALTER TABLE api_keys ADD CONSTRAINT api_keys_actor_fkey
  FOREIGN KEY (actor_id) REFERENCES actors(id);
ALTER TABLE api_keys ADD CONSTRAINT api_keys_rotated_from_fkey
  FOREIGN KEY (rotated_from_id) REFERENCES api_keys(id);
ALTER TABLE api_key_scopes ADD CONSTRAINT api_key_scopes_key_fkey
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE;
ALTER TABLE api_key_team_limits ADD CONSTRAINT api_key_team_limits_key_fkey
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE;
ALTER TABLE api_key_team_limits ADD CONSTRAINT api_key_team_limits_team_fkey
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE RESTRICT;

CREATE FUNCTION prime_board_update_issue_search_vector() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector := to_tsvector(
    'simple'::regconfig,
    coalesce(NEW.title, '') || ' ' || coalesce(NEW.description, '')
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER issues_search_vector_trigger
BEFORE INSERT OR UPDATE OF title, description ON issues
FOR EACH ROW EXECUTE FUNCTION prime_board_update_issue_search_vector();

CREATE INDEX idx_project_teams_team ON project_teams(team_id, project_id);
CREATE INDEX idx_issue_labels_label ON issue_labels(label_id, issue_id);
CREATE INDEX idx_issue_relations_issue ON issue_relations(issue_id, type, related_id);
CREATE INDEX idx_issues_team_state ON issues(team_id, state_id);
CREATE INDEX idx_issues_assignee ON issues(assignee_id);
CREATE INDEX idx_issues_project ON issues(project_id);
CREATE INDEX idx_issues_parent ON issues(parent_id);
CREATE INDEX idx_issues_milestone ON issues(milestone_id);
CREATE INDEX idx_issues_cycle ON issues(cycle_id);
CREATE INDEX idx_issues_search ON issues USING GIN (search_vector);
CREATE INDEX idx_comments_issue ON comments(issue_id);
CREATE INDEX idx_activity_issue ON activity(issue_id);
CREATE INDEX idx_milestones_project ON milestones(project_id);
CREATE INDEX idx_issue_relations_related ON issue_relations(related_id);
CREATE INDEX idx_saved_views_scope ON saved_views(scope, team_id);
CREATE INDEX idx_saved_views_owner ON saved_views(owner_id);
CREATE INDEX idx_cycles_team ON cycles(team_id);
CREATE INDEX idx_reviews_reviewer ON reviews(reviewer_id, status);
CREATE INDEX idx_reviews_issue ON reviews(issue_id);
CREATE INDEX idx_initiative_projects_project ON initiative_projects(project_id);
CREATE INDEX idx_initiative_teams_team ON initiative_teams(team_id);
CREATE INDEX idx_project_updates_project ON project_updates(project_id, created_at);
CREATE INDEX idx_inbox_receipts_actor ON inbox_receipts(actor_id);
CREATE INDEX idx_team_memberships_actor ON team_memberships(actor_id);
CREATE INDEX idx_webhooks_owner ON webhooks(owner_id);
CREATE INDEX idx_webhooks_team ON webhooks(team_id);
CREATE INDEX idx_actors_status ON actors(status);
CREATE INDEX idx_actor_invitations_status ON actor_invitations(status, created_at);
CREATE INDEX idx_actor_invitations_actor ON actor_invitations(actor_id);
CREATE INDEX idx_api_keys_actor_revoked ON api_keys(actor_id, revoked_at);
CREATE INDEX idx_api_key_scopes_scope ON api_key_scopes(scope);
CREATE INDEX idx_api_key_team_limits_team ON api_key_team_limits(team_id);
CREATE INDEX idx_favorites_actor_position ON favorites(actor_id, position, created_at, id);
CREATE UNIQUE INDEX idx_favorites_actor_project
  ON favorites(actor_id, project_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX idx_favorites_actor_saved_view
  ON favorites(actor_id, saved_view_id) WHERE saved_view_id IS NOT NULL;
CREATE UNIQUE INDEX idx_actor_invitations_pending_email
  ON actor_invitations(lower(email)) WHERE status = 'pending' AND email IS NOT NULL;

COMMIT;
