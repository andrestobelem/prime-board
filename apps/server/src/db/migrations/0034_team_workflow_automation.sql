-- PRB-383: agrega la configuración de automatizaciones del Team.
ALTER TABLE teams ADD COLUMN auto_close_period REAL
  CHECK (auto_close_period IS NULL OR auto_close_period > 0);
ALTER TABLE teams ADD COLUMN auto_archive_period REAL
  CHECK (auto_archive_period IS NULL OR auto_archive_period > 0);
ALTER TABLE teams ADD COLUMN auto_close_state_id TEXT;
ALTER TABLE teams ADD COLUMN auto_close_parent_issues INTEGER
  CHECK (auto_close_parent_issues IS NULL OR auto_close_parent_issues IN (0, 1));
ALTER TABLE teams ADD COLUMN auto_close_child_issues INTEGER
  CHECK (auto_close_child_issues IS NULL OR auto_close_child_issues IN (0, 1));
