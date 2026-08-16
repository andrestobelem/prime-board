-- PRB-208: archivar vistas y columnas visibles.
ALTER TABLE saved_views ADD COLUMN archived_at TEXT;
ALTER TABLE saved_views ADD COLUMN columns_json TEXT NOT NULL DEFAULT '[]';
