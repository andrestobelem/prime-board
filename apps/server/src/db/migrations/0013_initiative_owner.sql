-- PRB-215: ownership de iniciativas (solo el dueño edita/borra).
ALTER TABLE initiatives ADD COLUMN owner_id TEXT REFERENCES actors(id);
