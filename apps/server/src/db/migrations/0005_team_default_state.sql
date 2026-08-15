-- Estado default explícito por team (AT-180): hasta ahora era "el de menor
-- posición", y reordenar estados lo cambiaba en silencio. Se materializa la
-- regla vieja como valor inicial; la posición queda solo como fallback.
ALTER TABLE teams ADD COLUMN default_state_id TEXT REFERENCES workflow_states(id);

UPDATE teams SET default_state_id = (
  SELECT id FROM workflow_states
  WHERE workflow_states.team_id = teams.id
  ORDER BY position LIMIT 1
);
