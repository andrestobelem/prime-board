-- PRB-545: Documents Markdown en el backend PostgreSQL.
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
  search_vector TSVECTOR NOT NULL DEFAULT ''::tsvector,
  CHECK (
    (CASE WHEN issue_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN project_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN team_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN initiative_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN cycle_id IS NOT NULL THEN 1 ELSE 0 END) <= 1
  )
);

CREATE FUNCTION prime_board_update_document_search_vector() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector := to_tsvector(
    'simple'::regconfig,
    coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, '')
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_search_vector_trigger
BEFORE INSERT OR UPDATE OF title, content ON documents
FOR EACH ROW EXECUTE FUNCTION prime_board_update_document_search_vector();

CREATE INDEX idx_documents_workspace_updated ON documents(workspace_id, updated_at DESC, id DESC);
CREATE INDEX idx_documents_issue ON documents(issue_id) WHERE issue_id IS NOT NULL;
CREATE INDEX idx_documents_project ON documents(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_documents_team ON documents(team_id) WHERE team_id IS NOT NULL;
CREATE INDEX idx_documents_initiative ON documents(initiative_id) WHERE initiative_id IS NOT NULL;
CREATE INDEX idx_documents_cycle ON documents(cycle_id) WHERE cycle_id IS NOT NULL;
CREATE INDEX idx_documents_search ON documents USING GIN (search_vector);
