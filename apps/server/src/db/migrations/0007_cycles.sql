-- Ciclos time-boxed por team (PRB-203).
CREATE TABLE cycles (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('upcoming', 'active', 'completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (team_id, number)
);
CREATE INDEX idx_cycles_team ON cycles(team_id);

ALTER TABLE issues ADD COLUMN cycle_id TEXT REFERENCES cycles(id);
CREATE INDEX idx_issues_cycle ON issues(cycle_id);
