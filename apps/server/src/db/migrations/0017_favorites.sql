-- Favoritos privados y ordenados por actor (PRB-268).
CREATE TABLE favorites (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  saved_view_id TEXT REFERENCES saved_views(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0 AND typeof(position) = 'integer'),
  created_at TEXT NOT NULL,
  CHECK ((project_id IS NOT NULL) != (saved_view_id IS NOT NULL)
)
);

CREATE UNIQUE INDEX idx_favorites_actor_project ON favorites(actor_id, project_id)
  WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX idx_favorites_actor_saved_view ON favorites(actor_id, saved_view_id)
  WHERE saved_view_id IS NOT NULL;
CREATE INDEX idx_favorites_actor_position ON favorites(actor_id, position, created_at, id);
