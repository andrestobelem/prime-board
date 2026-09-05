-- PRB-570: retira Documents después de que el runner verifique un archivo externo.
-- La migración no escribe el archivo: migratePostgres exige un manifest válido
-- antes de ejecutar este SQL cuando la tabla contiene filas.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'documents'
  ) THEN
    DROP TRIGGER IF EXISTS documents_search_vector_trigger ON documents;
    DROP INDEX IF EXISTS idx_documents_workspace_updated;
    DROP INDEX IF EXISTS idx_documents_issue;
    DROP INDEX IF EXISTS idx_documents_project;
    DROP INDEX IF EXISTS idx_documents_team;
    DROP INDEX IF EXISTS idx_documents_initiative;
    DROP INDEX IF EXISTS idx_documents_cycle;
    DROP INDEX IF EXISTS idx_documents_search;
    DROP FUNCTION IF EXISTS prime_board_update_document_search_vector();
    DROP TABLE documents;
  END IF;
END
$$;
