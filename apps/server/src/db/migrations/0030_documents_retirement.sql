-- PRB-570: retira Documents después de archivarlos fuera del repositorio.
-- El runner verifica el archivo externo antes de ejecutar esta migración.
DROP TRIGGER IF EXISTS documents_workspace_target_insert;
DROP TRIGGER IF EXISTS documents_workspace_target_update;
DROP INDEX IF EXISTS idx_documents_workspace_updated;
DROP INDEX IF EXISTS idx_documents_issue;
DROP INDEX IF EXISTS idx_documents_project;
DROP INDEX IF EXISTS idx_documents_team;
DROP INDEX IF EXISTS idx_documents_initiative;
DROP INDEX IF EXISTS idx_documents_cycle;
DROP TABLE documents;
