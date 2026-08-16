-- PRB-235: rol de workspace explícito para autorizar la administración del roster.
ALTER TABLE actors ADD COLUMN workspace_role TEXT NOT NULL DEFAULT 'member'
  CHECK (workspace_role IN ('admin', 'member'));

-- Las instalaciones existentes ya identificaban al actor bootstrap con este nombre.
UPDATE actors SET workspace_role = 'admin' WHERE lower(name) = 'admin';
