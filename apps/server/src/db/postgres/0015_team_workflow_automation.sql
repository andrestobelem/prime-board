-- PRB-383: agrega la configuración de automatizaciones del Team.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS auto_close_period DOUBLE PRECISION
  CHECK (auto_close_period IS NULL OR auto_close_period > 0);
ALTER TABLE teams ADD COLUMN IF NOT EXISTS auto_archive_period DOUBLE PRECISION
  CHECK (auto_archive_period IS NULL OR auto_archive_period > 0);
ALTER TABLE teams ADD COLUMN IF NOT EXISTS auto_close_state_id TEXT;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS auto_close_parent_issues BOOLEAN;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS auto_close_child_issues BOOLEAN;
