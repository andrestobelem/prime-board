-- PRB-221: membresía de actores en teams y alcance team-scoped de iniciativas.
CREATE TABLE team_memberships (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  UNIQUE (team_id, actor_id)
);
CREATE INDEX idx_team_memberships_actor ON team_memberships(actor_id);

CREATE TABLE initiative_teams (
  initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (initiative_id, team_id)
);
CREATE INDEX idx_initiative_teams_team ON initiative_teams(team_id);
