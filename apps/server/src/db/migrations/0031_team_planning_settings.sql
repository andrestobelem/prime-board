-- Configuración de planificación del Team (PRB-388).
-- Los defaults conservan el comportamiento existente para bases anteriores.
ALTER TABLE teams ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE teams ADD COLUMN estimates_enabled INTEGER NOT NULL DEFAULT 0 CHECK (estimates_enabled IN (0, 1));
ALTER TABLE teams ADD COLUMN estimate_scale TEXT NOT NULL DEFAULT 'fibonacci'
  CHECK (estimate_scale IN ('exponential', 'fibonacci', 'linear', 't_shirt'));
ALTER TABLE teams ADD COLUMN estimate_extended_scale INTEGER NOT NULL DEFAULT 0
  CHECK (estimate_extended_scale IN (0, 1));
ALTER TABLE teams ADD COLUMN estimate_allow_zero INTEGER NOT NULL DEFAULT 0
  CHECK (estimate_allow_zero IN (0, 1));
ALTER TABLE teams ADD COLUMN cycles_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (cycles_enabled IN (0, 1));
ALTER TABLE teams ADD COLUMN cycle_duration_weeks INTEGER NOT NULL DEFAULT 2
  CHECK (cycle_duration_weeks BETWEEN 1 AND 8);
ALTER TABLE teams ADD COLUMN cycle_start_day INTEGER NOT NULL DEFAULT 1
  CHECK (cycle_start_day BETWEEN 1 AND 7);
ALTER TABLE teams ADD COLUMN cycle_cooldown_days INTEGER NOT NULL DEFAULT 0
  CHECK (cycle_cooldown_days BETWEEN 0 AND 366);
ALTER TABLE teams ADD COLUMN cycle_upcoming_count INTEGER NOT NULL DEFAULT 3
  CHECK (cycle_upcoming_count BETWEEN 0 AND 15);
ALTER TABLE teams ADD COLUMN cycle_rollover_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (cycle_rollover_enabled IN (0, 1));
ALTER TABLE teams ADD COLUMN cycle_auto_add_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (cycle_auto_add_enabled IN (0, 1));
ALTER TABLE cycles ADD COLUMN cadence_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (cadence_source IN ('cadence', 'manual'));
