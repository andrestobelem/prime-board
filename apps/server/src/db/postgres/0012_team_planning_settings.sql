-- Configuración de planificación del Team (PRB-388).
ALTER TABLE teams ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE teams ADD COLUMN IF NOT EXISTS estimates_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS estimate_scale TEXT NOT NULL DEFAULT 'fibonacci';
ALTER TABLE teams ADD COLUMN IF NOT EXISTS estimate_extended_scale BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS estimate_allow_zero BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS cycles_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS cycle_duration_weeks INTEGER NOT NULL DEFAULT 2;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS cycle_start_day INTEGER NOT NULL DEFAULT 1;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS cycle_cooldown_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS cycle_upcoming_count INTEGER NOT NULL DEFAULT 3;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS cycle_rollover_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS cycle_auto_add_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_estimate_scale_check;
ALTER TABLE teams ADD CONSTRAINT teams_estimate_scale_check
  CHECK (estimate_scale IN ('exponential', 'fibonacci', 'linear', 't_shirt'));
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_cycle_duration_check;
ALTER TABLE teams ADD CONSTRAINT teams_cycle_duration_check CHECK (cycle_duration_weeks BETWEEN 1 AND 8);
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_cycle_start_day_check;
ALTER TABLE teams ADD CONSTRAINT teams_cycle_start_day_check CHECK (cycle_start_day BETWEEN 1 AND 7);
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_cycle_cooldown_check;
ALTER TABLE teams ADD CONSTRAINT teams_cycle_cooldown_check CHECK (cycle_cooldown_days BETWEEN 0 AND 366);
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_cycle_upcoming_count_check;
ALTER TABLE teams ADD CONSTRAINT teams_cycle_upcoming_count_check CHECK (cycle_upcoming_count BETWEEN 0 AND 15);
ALTER TABLE cycles ADD COLUMN IF NOT EXISTS cadence_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE cycles DROP CONSTRAINT IF EXISTS cycles_cadence_source_check;
ALTER TABLE cycles ADD CONSTRAINT cycles_cadence_source_check
  CHECK (cadence_source IN ('cadence', 'manual'));
