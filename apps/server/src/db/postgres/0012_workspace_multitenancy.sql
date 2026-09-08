-- PRB-678: prepara el esquema PostgreSQL para varios Workspaces.
-- La migración es transaccional. Los datos históricos solo se asignan cuando
-- existe un Workspace único; una topología ambigua aborta antes del backfill.

DO $$
DECLARE
  workspace_count INTEGER;
  has_unscoped_rows BOOLEAN;
BEGIN
  SELECT count(*)::INTEGER INTO workspace_count FROM workspace;
  SELECT EXISTS (SELECT 1 FROM teams)
       OR EXISTS (SELECT 1 FROM workflow_states)
       OR EXISTS (SELECT 1 FROM projects)
       OR EXISTS (SELECT 1 FROM milestones)
       OR EXISTS (SELECT 1 FROM cycles)
       OR EXISTS (SELECT 1 FROM issues)
       OR EXISTS (SELECT 1 FROM labels)
       OR EXISTS (SELECT 1 FROM project_teams)
       OR EXISTS (SELECT 1 FROM issue_labels)
       OR EXISTS (SELECT 1 FROM issue_relations)
       OR EXISTS (SELECT 1 FROM comments)
       OR EXISTS (SELECT 1 FROM activity)
       OR EXISTS (SELECT 1 FROM webhooks)
       OR EXISTS (SELECT 1 FROM saved_views)
       OR EXISTS (SELECT 1 FROM team_memberships)
       OR EXISTS (SELECT 1 FROM initiatives)
       OR EXISTS (SELECT 1 FROM initiative_projects)
       OR EXISTS (SELECT 1 FROM initiative_teams)
       OR EXISTS (SELECT 1 FROM project_updates)
       OR EXISTS (SELECT 1 FROM reviews)
       OR EXISTS (SELECT 1 FROM inbox_receipts)
       OR EXISTS (SELECT 1 FROM favorites)
       OR EXISTS (SELECT 1 FROM actor_invitations)
    INTO has_unscoped_rows;
  IF workspace_count <> 1 AND has_unscoped_rows THEN
    RAISE EXCEPTION
      'Cannot backfill PostgreSQL Workspace scope: expected one Workspace, found %',
      workspace_count
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- Columns are nullable only for the duration of this migration. The trigger
-- below preserves old single-Workspace writers before the NOT NULL checks.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE workflow_states ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE cycles ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE labels ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE project_teams ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE issue_labels ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE issue_relations ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE activity ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE saved_views ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE team_memberships ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE initiatives ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE initiative_projects ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE initiative_teams ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE project_updates ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE inbox_receipts ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE favorites ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE actor_invitations ADD COLUMN IF NOT EXISTS workspace_id TEXT;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  IF (SELECT count(*) FROM workspace) = 1 THEN
    FOREACH table_name IN ARRAY ARRAY[
      'teams', 'workflow_states', 'projects', 'milestones', 'cycles', 'issues',
      'labels', 'project_teams', 'issue_labels', 'issue_relations', 'comments',
      'activity', 'webhooks', 'saved_views', 'team_memberships', 'initiatives',
      'initiative_projects', 'initiative_teams', 'project_updates', 'reviews',
      'inbox_receipts', 'favorites', 'actor_invitations'
    ] LOOP
      EXECUTE format(
        'UPDATE %I SET workspace_id = (SELECT id FROM workspace LIMIT 1) WHERE workspace_id IS NULL',
        table_name
      );
    END LOOP;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM teams WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM workflow_states WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM projects WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM milestones WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM cycles WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM issues WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM labels WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM project_teams WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM issue_labels WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM issue_relations WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM comments WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM activity WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM webhooks WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM saved_views WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM team_memberships WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM initiatives WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM initiative_projects WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM initiative_teams WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM project_updates WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM reviews WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM inbox_receipts WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM favorites WHERE workspace_id IS NULL)
     OR EXISTS (SELECT 1 FROM actor_invitations WHERE workspace_id IS NULL)
  THEN
    RAISE EXCEPTION
      'PostgreSQL Workspace backfill left unscoped rows'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

-- Replace the old global uniqueness rules with Workspace-local rules.
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_key_key;
ALTER TABLE workflow_states DROP CONSTRAINT IF EXISTS workflow_states_team_id_name_key;
ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_project_id_name_key;
ALTER TABLE cycles DROP CONSTRAINT IF EXISTS cycles_team_id_number_key;
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_team_id_number_key;
ALTER TABLE labels DROP CONSTRAINT IF EXISTS labels_team_id_name_key;
ALTER TABLE issue_relations DROP CONSTRAINT IF EXISTS issue_relations_issue_id_related_id_type_key;
ALTER TABLE team_memberships DROP CONSTRAINT IF EXISTS team_memberships_team_id_actor_id_key;
ALTER TABLE issue_subscribers DROP CONSTRAINT IF EXISTS issue_subscribers_pkey;
ALTER TABLE api_key_team_limits DROP CONSTRAINT IF EXISTS api_key_team_limits_pkey;
ALTER TABLE project_teams DROP CONSTRAINT IF EXISTS project_teams_pkey;
ALTER TABLE issue_labels DROP CONSTRAINT IF EXISTS issue_labels_pkey;
ALTER TABLE initiative_projects DROP CONSTRAINT IF EXISTS initiative_projects_pkey;
ALTER TABLE initiative_teams DROP CONSTRAINT IF EXISTS initiative_teams_pkey;
ALTER TABLE inbox_receipts DROP CONSTRAINT IF EXISTS inbox_receipts_pkey;

ALTER TABLE teams ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE workflow_states ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE milestones ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE cycles ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE issues ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE labels ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE project_teams ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE issue_labels ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE issue_relations ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE comments ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE activity ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE webhooks ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE saved_views ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE team_memberships ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE initiatives ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE initiative_projects ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE initiative_teams ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE project_updates ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE reviews ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE inbox_receipts ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE favorites ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE actor_invitations ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE issue_subscribers DROP CONSTRAINT IF EXISTS issue_subscribers_pkey;
ALTER TABLE issue_subscribers ADD CONSTRAINT issue_subscribers_pkey
  PRIMARY KEY (workspace_id, issue_id, actor_id);
ALTER TABLE api_key_team_limits ADD CONSTRAINT api_key_team_limits_pkey
  PRIMARY KEY (workspace_id, api_key_id, team_id);
ALTER TABLE project_teams ADD CONSTRAINT project_teams_pkey
  PRIMARY KEY (workspace_id, project_id, team_id);
ALTER TABLE issue_labels ADD CONSTRAINT issue_labels_pkey
  PRIMARY KEY (workspace_id, issue_id, label_id);
ALTER TABLE initiative_projects ADD CONSTRAINT initiative_projects_pkey
  PRIMARY KEY (workspace_id, initiative_id, project_id);
ALTER TABLE initiative_teams ADD CONSTRAINT initiative_teams_pkey
  PRIMARY KEY (workspace_id, initiative_id, team_id);
ALTER TABLE inbox_receipts ADD CONSTRAINT inbox_receipts_pkey
  PRIMARY KEY (workspace_id, activity_id, actor_id);

-- Preserve the conflict targets used by legacy single-Workspace writers. IDs
-- are global API identities, so these compatibility keys do not weaken scope.
CREATE UNIQUE INDEX issue_subscribers_issue_actor_key
  ON issue_subscribers (issue_id, actor_id);
CREATE UNIQUE INDEX inbox_receipts_activity_actor_key
  ON inbox_receipts (activity_id, actor_id);

-- Every composite reference has a matching Workspace-qualified key.
ALTER TABLE teams ADD CONSTRAINT teams_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE workflow_states ADD CONSTRAINT workflow_states_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE projects ADD CONSTRAINT projects_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE milestones ADD CONSTRAINT milestones_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE cycles ADD CONSTRAINT cycles_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE issues ADD CONSTRAINT issues_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE labels ADD CONSTRAINT labels_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE activity ADD CONSTRAINT activity_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE initiatives ADD CONSTRAINT initiatives_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE saved_views ADD CONSTRAINT saved_views_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE workspace ADD CONSTRAINT workspace_url_key_key UNIQUE (url_key);

ALTER TABLE teams ADD CONSTRAINT teams_workspace_key_key UNIQUE (workspace_id, key);
ALTER TABLE workflow_states ADD CONSTRAINT workflow_states_workspace_team_name_key
  UNIQUE (workspace_id, team_id, name);
ALTER TABLE milestones ADD CONSTRAINT milestones_workspace_project_name_key
  UNIQUE (workspace_id, project_id, name);
ALTER TABLE cycles ADD CONSTRAINT cycles_workspace_team_number_key
  UNIQUE (workspace_id, team_id, number);
ALTER TABLE issues ADD CONSTRAINT issues_workspace_team_number_key
  UNIQUE (workspace_id, team_id, number);
ALTER TABLE labels ADD CONSTRAINT labels_workspace_team_name_key
  UNIQUE (workspace_id, team_id, name);
CREATE UNIQUE INDEX labels_workspace_name_key
  ON labels (workspace_id, name) WHERE team_id IS NULL;
ALTER TABLE issue_relations ADD CONSTRAINT issue_relations_workspace_endpoints_type_key
  UNIQUE (workspace_id, issue_id, related_id, type);
ALTER TABLE team_memberships ADD CONSTRAINT team_memberships_workspace_team_actor_key
  UNIQUE (workspace_id, team_id, actor_id);

-- Existing simple domain FKs are replaced by Workspace-qualified FKs. Actor is
-- a global identity by ADR-0017, so Actor references remain simple IDs.
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_default_state_fkey;
ALTER TABLE workflow_states DROP CONSTRAINT IF EXISTS workflow_states_team_fkey;
ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_project_fkey;
ALTER TABLE cycles DROP CONSTRAINT IF EXISTS cycles_team_fkey;
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_team_fkey;
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_state_fkey;
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_parent_fkey;
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_project_fkey;
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_milestone_fkey;
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_cycle_fkey;
ALTER TABLE labels DROP CONSTRAINT IF EXISTS labels_team_fkey;
ALTER TABLE project_teams DROP CONSTRAINT IF EXISTS project_teams_project_fkey;
ALTER TABLE project_teams DROP CONSTRAINT IF EXISTS project_teams_team_fkey;
ALTER TABLE issue_labels DROP CONSTRAINT IF EXISTS issue_labels_issue_fkey;
ALTER TABLE issue_labels DROP CONSTRAINT IF EXISTS issue_labels_label_fkey;
ALTER TABLE issue_relations DROP CONSTRAINT IF EXISTS issue_relations_issue_fkey;
ALTER TABLE issue_relations DROP CONSTRAINT IF EXISTS issue_relations_related_fkey;
ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_issue_fkey;
ALTER TABLE activity DROP CONSTRAINT IF EXISTS activity_issue_fkey;
ALTER TABLE webhooks DROP CONSTRAINT IF EXISTS webhooks_team_fkey;
ALTER TABLE saved_views DROP CONSTRAINT IF EXISTS saved_views_team_fkey;
ALTER TABLE team_memberships DROP CONSTRAINT IF EXISTS team_memberships_team_fkey;
ALTER TABLE team_memberships DROP CONSTRAINT IF EXISTS team_memberships_actor_fkey;
ALTER TABLE initiative_projects DROP CONSTRAINT IF EXISTS initiative_projects_initiative_fkey;
ALTER TABLE initiative_projects DROP CONSTRAINT IF EXISTS initiative_projects_project_fkey;
ALTER TABLE initiative_teams DROP CONSTRAINT IF EXISTS initiative_teams_initiative_fkey;
ALTER TABLE initiative_teams DROP CONSTRAINT IF EXISTS initiative_teams_team_fkey;
ALTER TABLE project_updates DROP CONSTRAINT IF EXISTS project_updates_project_fkey;
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_issue_fkey;
ALTER TABLE inbox_receipts DROP CONSTRAINT IF EXISTS inbox_receipts_activity_fkey;
ALTER TABLE inbox_receipts DROP CONSTRAINT IF EXISTS inbox_receipts_actor_fkey;
ALTER TABLE favorites DROP CONSTRAINT IF EXISTS favorites_project_fkey;
ALTER TABLE favorites DROP CONSTRAINT IF EXISTS favorites_saved_view_fkey;
ALTER TABLE api_key_team_limits DROP CONSTRAINT IF EXISTS api_key_team_limits_team_fkey;
ALTER TABLE issue_subscribers DROP CONSTRAINT IF EXISTS issue_subscribers_issue_id_fkey;
ALTER TABLE issue_subscribers DROP CONSTRAINT IF EXISTS issue_subscribers_actor_id_fkey;

ALTER TABLE teams ADD CONSTRAINT teams_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE workflow_states ADD CONSTRAINT workflow_states_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE projects ADD CONSTRAINT projects_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE milestones ADD CONSTRAINT milestones_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE cycles ADD CONSTRAINT cycles_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE issues ADD CONSTRAINT issues_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE labels ADD CONSTRAINT labels_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE project_teams ADD CONSTRAINT project_teams_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE issue_labels ADD CONSTRAINT issue_labels_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE issue_relations ADD CONSTRAINT issue_relations_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE comments ADD CONSTRAINT comments_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE activity ADD CONSTRAINT activity_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE webhooks ADD CONSTRAINT webhooks_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE saved_views ADD CONSTRAINT saved_views_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE team_memberships ADD CONSTRAINT team_memberships_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE initiatives ADD CONSTRAINT initiatives_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE initiative_projects ADD CONSTRAINT initiative_projects_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE initiative_teams ADD CONSTRAINT initiative_teams_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE project_updates ADD CONSTRAINT project_updates_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE reviews ADD CONSTRAINT reviews_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE inbox_receipts ADD CONSTRAINT inbox_receipts_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE favorites ADD CONSTRAINT favorites_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;
ALTER TABLE actor_invitations ADD CONSTRAINT actor_invitations_workspace_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE CASCADE;

ALTER TABLE teams ADD CONSTRAINT teams_default_state_workspace_fkey
  FOREIGN KEY (workspace_id, default_state_id)
  REFERENCES workflow_states(workspace_id, id);
ALTER TABLE workflow_states ADD CONSTRAINT workflow_states_team_workspace_fkey
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id);
ALTER TABLE milestones ADD CONSTRAINT milestones_project_workspace_fkey
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id);
ALTER TABLE cycles ADD CONSTRAINT cycles_team_workspace_fkey
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id);
ALTER TABLE issues ADD CONSTRAINT issues_team_workspace_fkey
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id);
ALTER TABLE issues ADD CONSTRAINT issues_state_workspace_fkey
  FOREIGN KEY (workspace_id, state_id) REFERENCES workflow_states(workspace_id, id);
ALTER TABLE issues ADD CONSTRAINT issues_parent_workspace_fkey
  FOREIGN KEY (workspace_id, parent_id) REFERENCES issues(workspace_id, id);
ALTER TABLE issues ADD CONSTRAINT issues_project_workspace_fkey
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id);
ALTER TABLE issues ADD CONSTRAINT issues_milestone_workspace_fkey
  FOREIGN KEY (workspace_id, milestone_id) REFERENCES milestones(workspace_id, id);
ALTER TABLE issues ADD CONSTRAINT issues_cycle_workspace_fkey
  FOREIGN KEY (workspace_id, cycle_id) REFERENCES cycles(workspace_id, id);
ALTER TABLE labels ADD CONSTRAINT labels_team_workspace_fkey
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id);
ALTER TABLE project_teams ADD CONSTRAINT project_teams_project_workspace_fkey
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id);
ALTER TABLE project_teams ADD CONSTRAINT project_teams_team_workspace_fkey
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id);
ALTER TABLE issue_labels ADD CONSTRAINT issue_labels_issue_workspace_fkey
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues(workspace_id, id);
ALTER TABLE issue_labels ADD CONSTRAINT issue_labels_label_workspace_fkey
  FOREIGN KEY (workspace_id, label_id) REFERENCES labels(workspace_id, id);
ALTER TABLE issue_relations ADD CONSTRAINT issue_relations_issue_workspace_fkey
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues(workspace_id, id);
ALTER TABLE issue_relations ADD CONSTRAINT issue_relations_related_workspace_fkey
  FOREIGN KEY (workspace_id, related_id) REFERENCES issues(workspace_id, id);
ALTER TABLE comments ADD CONSTRAINT comments_issue_workspace_fkey
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues(workspace_id, id);
ALTER TABLE activity ADD CONSTRAINT activity_issue_workspace_fkey
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues(workspace_id, id);
ALTER TABLE webhooks ADD CONSTRAINT webhooks_team_workspace_fkey
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE saved_views ADD CONSTRAINT saved_views_team_workspace_fkey
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id);
ALTER TABLE team_memberships ADD CONSTRAINT team_memberships_team_workspace_fkey
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE team_memberships ADD CONSTRAINT team_memberships_actor_workspace_fkey
  FOREIGN KEY (workspace_id, actor_id)
  REFERENCES workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE;
ALTER TABLE initiative_projects ADD CONSTRAINT initiative_projects_initiative_workspace_fkey
  FOREIGN KEY (workspace_id, initiative_id) REFERENCES initiatives(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE initiative_projects ADD CONSTRAINT initiative_projects_project_workspace_fkey
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE initiative_teams ADD CONSTRAINT initiative_teams_initiative_workspace_fkey
  FOREIGN KEY (workspace_id, initiative_id) REFERENCES initiatives(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE initiative_teams ADD CONSTRAINT initiative_teams_team_workspace_fkey
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE project_updates ADD CONSTRAINT project_updates_project_workspace_fkey
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE reviews ADD CONSTRAINT reviews_issue_workspace_fkey
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues(workspace_id, id);
ALTER TABLE inbox_receipts ADD CONSTRAINT inbox_receipts_activity_workspace_fkey
  FOREIGN KEY (workspace_id, activity_id) REFERENCES activity(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE inbox_receipts ADD CONSTRAINT inbox_receipts_actor_workspace_fkey
  FOREIGN KEY (workspace_id, actor_id)
  REFERENCES workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE;
ALTER TABLE favorites ADD CONSTRAINT favorites_project_workspace_fkey
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE favorites ADD CONSTRAINT favorites_saved_view_workspace_fkey
  FOREIGN KEY (workspace_id, saved_view_id) REFERENCES saved_views(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE api_key_team_limits ADD CONSTRAINT api_key_team_limits_team_workspace_fkey
  FOREIGN KEY (workspace_id, team_id) REFERENCES teams(workspace_id, id) ON DELETE RESTRICT;
ALTER TABLE api_key_team_limits ADD CONSTRAINT api_key_team_limits_grant_workspace_fkey
  FOREIGN KEY (api_key_id, workspace_id)
  REFERENCES api_key_workspaces(api_key_id, workspace_id) ON DELETE CASCADE;
ALTER TABLE issue_subscribers ADD CONSTRAINT issue_subscribers_issue_workspace_fkey
  FOREIGN KEY (workspace_id, issue_id) REFERENCES issues(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE issue_subscribers ADD CONSTRAINT issue_subscribers_actor_workspace_fkey
  FOREIGN KEY (workspace_id, actor_id)
  REFERENCES workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE;

-- In singleton mode, old PostgreSQL writers omit workspace_id. Fill that
-- omission safely; with two Workspaces, an omitted scope is an error.
CREATE OR REPLACE FUNCTION prime_board_assign_workspace_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  candidate TEXT;
BEGIN
  IF NEW.workspace_id IS NULL THEN
    SELECT min(id) INTO candidate FROM workspace;
    IF (SELECT count(*) FROM workspace) <> 1 THEN
      RAISE EXCEPTION 'workspace_id is required for table %', TG_TABLE_NAME
        USING ERRCODE = 'not_null_violation';
    END IF;
    NEW.workspace_id := candidate;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER teams_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON teams
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER workflow_states_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON workflow_states
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER projects_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON projects
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER milestones_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON milestones
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER cycles_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON cycles
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER issues_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON issues
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER labels_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON labels
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER project_teams_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON project_teams
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER issue_labels_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON issue_labels
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER issue_relations_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON issue_relations
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER comments_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON comments
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER activity_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON activity
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER webhooks_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON webhooks
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER saved_views_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON saved_views
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER team_memberships_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON team_memberships
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER initiatives_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON initiatives
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER initiative_projects_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON initiative_projects
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER initiative_teams_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON initiative_teams
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER project_updates_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON project_updates
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER reviews_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON reviews
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER inbox_receipts_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON inbox_receipts
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER favorites_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON favorites
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();
CREATE TRIGGER actor_invitations_workspace_id_trigger
BEFORE INSERT OR UPDATE OF workspace_id ON actor_invitations
FOR EACH ROW EXECUTE FUNCTION prime_board_assign_workspace_id();

-- Prevent the old Actor trigger from granting every Workspace in a shared DB.
CREATE OR REPLACE FUNCTION prime_board_seed_workspace_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
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
  WHERE (SELECT count(*) FROM workspace) = 1
    AND NOT EXISTS (
      SELECT 1 FROM workspace_memberships memberships
      WHERE memberships.workspace_id = workspace.id
        AND memberships.actor_id = NEW.id
    );
  RETURN NEW;
END;
$$;

-- Workspace-first indexes. Search GIN stays independent because PostgreSQL
-- cannot use a leading scalar key in a GIN tsvector index.
DROP INDEX IF EXISTS idx_project_teams_team;
DROP INDEX IF EXISTS idx_issue_subscribers_actor;
DROP INDEX IF EXISTS idx_issue_subscribers_issue;
DROP INDEX IF EXISTS idx_workspace_memberships_actor_workspace;
DROP INDEX IF EXISTS idx_issue_labels_label;
DROP INDEX IF EXISTS idx_issue_relations_issue;
DROP INDEX IF EXISTS idx_issues_team_state;
DROP INDEX IF EXISTS idx_issues_assignee;
DROP INDEX IF EXISTS idx_issues_project;
DROP INDEX IF EXISTS idx_issues_parent;
DROP INDEX IF EXISTS idx_issues_milestone;
DROP INDEX IF EXISTS idx_issues_cycle;
DROP INDEX IF EXISTS idx_comments_issue;
DROP INDEX IF EXISTS idx_activity_issue;
DROP INDEX IF EXISTS idx_milestones_project;
DROP INDEX IF EXISTS idx_issue_relations_related;
DROP INDEX IF EXISTS idx_saved_views_scope;
DROP INDEX IF EXISTS idx_saved_views_owner;
DROP INDEX IF EXISTS idx_cycles_team;
DROP INDEX IF EXISTS idx_reviews_reviewer;
DROP INDEX IF EXISTS idx_reviews_issue;
DROP INDEX IF EXISTS idx_initiative_projects_project;
DROP INDEX IF EXISTS idx_initiative_teams_team;
DROP INDEX IF EXISTS idx_project_updates_project;
DROP INDEX IF EXISTS idx_inbox_receipts_actor;
DROP INDEX IF EXISTS idx_team_memberships_actor;
DROP INDEX IF EXISTS idx_webhooks_owner;
DROP INDEX IF EXISTS idx_webhooks_team;
DROP INDEX IF EXISTS idx_actor_invitations_status;
DROP INDEX IF EXISTS idx_actor_invitations_actor;
DROP INDEX IF EXISTS idx_api_key_team_limits_workspace;
DROP INDEX IF EXISTS idx_api_key_team_limits_team;
DROP INDEX IF EXISTS idx_favorites_actor_position;
DROP INDEX IF EXISTS idx_favorites_actor_project;
DROP INDEX IF EXISTS idx_favorites_actor_saved_view;
DROP INDEX IF EXISTS idx_actor_invitations_pending_email;

CREATE INDEX idx_project_teams_team ON project_teams(workspace_id, team_id, project_id);
CREATE INDEX idx_issue_subscribers_actor ON issue_subscribers(workspace_id, actor_id, issue_id);
CREATE INDEX idx_issue_subscribers_issue ON issue_subscribers(workspace_id, issue_id, actor_id);
CREATE INDEX idx_workspace_memberships_actor_workspace
  ON workspace_memberships(workspace_id, actor_id);
CREATE INDEX idx_issue_labels_label ON issue_labels(workspace_id, label_id, issue_id);
CREATE INDEX idx_issue_relations_issue ON issue_relations(workspace_id, issue_id, type, related_id);
CREATE INDEX idx_issues_team_state ON issues(workspace_id, team_id, state_id);
CREATE INDEX idx_issues_assignee ON issues(workspace_id, assignee_id);
CREATE INDEX idx_issues_project ON issues(workspace_id, project_id);
CREATE INDEX idx_issues_parent ON issues(workspace_id, parent_id);
CREATE INDEX idx_issues_milestone ON issues(workspace_id, milestone_id);
CREATE INDEX idx_issues_cycle ON issues(workspace_id, cycle_id);
CREATE INDEX idx_comments_issue ON comments(workspace_id, issue_id);
CREATE INDEX idx_activity_issue ON activity(workspace_id, issue_id);
CREATE INDEX idx_milestones_project ON milestones(workspace_id, project_id);
CREATE INDEX idx_issue_relations_related ON issue_relations(workspace_id, related_id);
CREATE INDEX idx_saved_views_scope ON saved_views(workspace_id, scope, team_id);
CREATE INDEX idx_saved_views_owner ON saved_views(workspace_id, owner_id);
CREATE INDEX idx_cycles_team ON cycles(workspace_id, team_id);
CREATE INDEX idx_reviews_reviewer ON reviews(workspace_id, reviewer_id, status);
CREATE INDEX idx_reviews_issue ON reviews(workspace_id, issue_id);
CREATE INDEX idx_initiative_projects_project ON initiative_projects(workspace_id, project_id, initiative_id);
CREATE INDEX idx_initiative_teams_team ON initiative_teams(workspace_id, team_id, initiative_id);
CREATE INDEX idx_project_updates_project ON project_updates(workspace_id, project_id, created_at);
CREATE INDEX idx_inbox_receipts_actor ON inbox_receipts(workspace_id, actor_id);
CREATE INDEX idx_team_memberships_actor ON team_memberships(workspace_id, actor_id);
CREATE INDEX idx_webhooks_owner ON webhooks(workspace_id, owner_id);
CREATE INDEX idx_webhooks_team ON webhooks(workspace_id, team_id);
CREATE INDEX idx_actor_invitations_status ON actor_invitations(workspace_id, status, created_at);
CREATE INDEX idx_actor_invitations_actor ON actor_invitations(workspace_id, actor_id);
CREATE INDEX idx_api_key_team_limits_workspace ON api_key_team_limits(workspace_id, team_id, api_key_id);
CREATE INDEX idx_favorites_actor_position ON favorites(workspace_id, actor_id, position, created_at, id);
CREATE UNIQUE INDEX idx_favorites_actor_project
  ON favorites(workspace_id, actor_id, project_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX idx_favorites_actor_saved_view
  ON favorites(workspace_id, actor_id, saved_view_id) WHERE saved_view_id IS NOT NULL;
CREATE UNIQUE INDEX idx_actor_invitations_pending_email
  ON actor_invitations(workspace_id, lower(email))
  WHERE status = 'pending' AND email IS NOT NULL;

DROP INDEX IF EXISTS workspace_singleton_idx;
