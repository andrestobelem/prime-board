-- Proyectos asociados a teams (AT-152): relación N:M como en Linear.
-- Backfill: los proyectos existentes quedan asociados a todos los teams
-- actuales para preservar la visibilidad que tenían (eran globales).

CREATE TABLE project_teams (
  project_id TEXT NOT NULL REFERENCES projects(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  PRIMARY KEY (project_id, team_id)
);

INSERT INTO project_teams (project_id, team_id)
SELECT projects.id, teams.id FROM projects, teams;
