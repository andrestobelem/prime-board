-- PRB-541: documentos Markdown enlazables a recursos del Workspace.
-- Un documento puede ser global o pertenecer a un único recurso de trabajo.
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  creator_id TEXT NOT NULL REFERENCES actors(id),
  issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  initiative_id TEXT REFERENCES initiatives(id) ON DELETE CASCADE,
  cycle_id TEXT REFERENCES cycles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK (
    (CASE WHEN issue_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN project_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN team_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN initiative_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN cycle_id IS NOT NULL THEN 1 ELSE 0 END) <= 1
  ),
  UNIQUE (workspace_id, id)
);
CREATE INDEX idx_documents_workspace_updated ON documents(workspace_id, updated_at DESC);
CREATE INDEX idx_documents_issue ON documents(workspace_id, issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX idx_documents_project ON documents(workspace_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_documents_team ON documents(workspace_id, team_id) WHERE team_id IS NOT NULL;
CREATE INDEX idx_documents_initiative ON documents(workspace_id, initiative_id) WHERE initiative_id IS NOT NULL;
CREATE INDEX idx_documents_cycle ON documents(workspace_id, cycle_id) WHERE cycle_id IS NOT NULL;

-- Los FKs simples garantizan existencia, pero no el alcance. Estos triggers
-- impiden vincular un Document a un recurso de otra Workspace.
CREATE TRIGGER documents_workspace_target_insert
BEFORE INSERT ON documents
WHEN (NEW.issue_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM issues WHERE id = NEW.issue_id AND workspace_id = NEW.workspace_id
       ))
  OR (NEW.project_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM projects WHERE id = NEW.project_id AND workspace_id = NEW.workspace_id
       ))
  OR (NEW.team_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM teams WHERE id = NEW.team_id AND workspace_id = NEW.workspace_id
       ))
  OR (NEW.initiative_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM initiatives WHERE id = NEW.initiative_id AND workspace_id = NEW.workspace_id
       ))
  OR (NEW.cycle_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM cycles WHERE id = NEW.cycle_id AND workspace_id = NEW.workspace_id
       ))
BEGIN
  SELECT RAISE(ABORT, 'Document target must belong to the same Workspace');
END;

CREATE TRIGGER documents_workspace_target_update
BEFORE UPDATE OF workspace_id, issue_id, project_id, team_id, initiative_id, cycle_id ON documents
WHEN (NEW.issue_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM issues WHERE id = NEW.issue_id AND workspace_id = NEW.workspace_id
       ))
  OR (NEW.project_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM projects WHERE id = NEW.project_id AND workspace_id = NEW.workspace_id
       ))
  OR (NEW.team_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM teams WHERE id = NEW.team_id AND workspace_id = NEW.workspace_id
       ))
  OR (NEW.initiative_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM initiatives WHERE id = NEW.initiative_id AND workspace_id = NEW.workspace_id
       ))
  OR (NEW.cycle_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM cycles WHERE id = NEW.cycle_id AND workspace_id = NEW.workspace_id
       ))
BEGIN
  SELECT RAISE(ABORT, 'Document target must belong to the same Workspace');
END;
