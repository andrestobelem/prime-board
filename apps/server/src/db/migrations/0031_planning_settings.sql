-- PRB-391: planning settings for Projects and Initiatives.
-- Keep templates, notification channels and Views in their owning domains.
ALTER TABLE projects ADD COLUMN start_date TEXT;

ALTER TABLE initiatives ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4);
ALTER TABLE initiatives ADD COLUMN lead_team_id TEXT REFERENCES teams(id);
ALTER TABLE initiatives ADD COLUMN resources_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, actor_id)
);
CREATE INDEX idx_project_members_actor ON project_members(actor_id);

CREATE TABLE project_dependencies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  depends_on_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'blocks' CHECK (type IN ('blocks', 'related')),
  created_at TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  UNIQUE (project_id, depends_on_project_id, type),
  CHECK (project_id != depends_on_project_id)
);
CREATE INDEX idx_project_dependencies_target ON project_dependencies(depends_on_project_id);

CREATE TABLE initiative_labels (
  initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE,
  PRIMARY KEY (initiative_id, label_id)
);
CREATE INDEX idx_initiative_labels_label ON initiative_labels(label_id);

CREATE TABLE initiative_updates (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES actors(id),
  health TEXT NOT NULL DEFAULT 'on_track' CHECK (health IN ('on_track', 'at_risk', 'off_track')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspace(id) ON DELETE CASCADE
);
CREATE INDEX idx_initiative_updates_initiative ON initiative_updates(initiative_id, created_at);


-- Workspace isolation for the new relations. IDs are globally unique today,
-- but these checks keep the relations safe when the SQLite store has multiple
-- Workspaces. NULL remains valid for legacy rows during the transition.
CREATE TRIGGER project_members_workspace_scope_insert
BEFORE INSERT ON project_members
WHEN (SELECT workspace_id FROM projects WHERE id = NEW.project_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'project member workspace mismatch'); END;
CREATE TRIGGER project_members_workspace_scope_update
BEFORE UPDATE OF project_id, workspace_id ON project_members
WHEN (SELECT workspace_id FROM projects WHERE id = NEW.project_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'project member workspace mismatch'); END;

CREATE TRIGGER project_dependencies_workspace_scope_insert
BEFORE INSERT ON project_dependencies
WHEN (SELECT workspace_id FROM projects WHERE id = NEW.project_id) IS NOT NEW.workspace_id
  OR (SELECT workspace_id FROM projects WHERE id = NEW.depends_on_project_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'project dependency workspace mismatch'); END;
CREATE TRIGGER project_dependencies_workspace_scope_update
BEFORE UPDATE OF project_id, depends_on_project_id, workspace_id ON project_dependencies
WHEN (SELECT workspace_id FROM projects WHERE id = NEW.project_id) IS NOT NEW.workspace_id
  OR (SELECT workspace_id FROM projects WHERE id = NEW.depends_on_project_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'project dependency workspace mismatch'); END;

CREATE TRIGGER initiative_labels_workspace_scope_insert
BEFORE INSERT ON initiative_labels
WHEN (SELECT workspace_id FROM initiatives WHERE id = NEW.initiative_id) IS NOT NEW.workspace_id
  OR (SELECT workspace_id FROM labels WHERE id = NEW.label_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'initiative label workspace mismatch'); END;
CREATE TRIGGER initiative_labels_workspace_scope_update
BEFORE UPDATE OF initiative_id, label_id, workspace_id ON initiative_labels
WHEN (SELECT workspace_id FROM initiatives WHERE id = NEW.initiative_id) IS NOT NEW.workspace_id
  OR (SELECT workspace_id FROM labels WHERE id = NEW.label_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'initiative label workspace mismatch'); END;

CREATE TRIGGER initiatives_lead_team_workspace_scope_insert
BEFORE INSERT ON initiatives
WHEN NEW.lead_team_id IS NOT NULL
  AND (SELECT workspace_id FROM teams WHERE id = NEW.lead_team_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'initiative lead team workspace mismatch'); END;
CREATE TRIGGER initiatives_lead_team_workspace_scope_update
BEFORE UPDATE OF lead_team_id, workspace_id ON initiatives
WHEN NEW.lead_team_id IS NOT NULL
  AND (SELECT workspace_id FROM teams WHERE id = NEW.lead_team_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'initiative lead team workspace mismatch'); END;

CREATE TRIGGER initiative_updates_workspace_scope_insert
BEFORE INSERT ON initiative_updates
WHEN (SELECT workspace_id FROM initiatives WHERE id = NEW.initiative_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'initiative update workspace mismatch'); END;
CREATE TRIGGER initiative_updates_workspace_scope_update
BEFORE UPDATE OF initiative_id, workspace_id ON initiative_updates
WHEN (SELECT workspace_id FROM initiatives WHERE id = NEW.initiative_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'initiative update workspace mismatch'); END;
