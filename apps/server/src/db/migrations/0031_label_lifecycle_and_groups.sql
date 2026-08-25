-- PRB-389: descripción, ciclo de vida, grupos y referencias de labels.
ALTER TABLE labels ADD COLUMN description TEXT;
ALTER TABLE labels ADD COLUMN archived_at TEXT;
ALTER TABLE labels ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1));
ALTER TABLE labels ADD COLUMN group_id TEXT REFERENCES labels(id);
ALTER TABLE labels ADD COLUMN merged_into_id TEXT REFERENCES labels(id);

CREATE INDEX idx_labels_group ON labels(group_id);
CREATE INDEX idx_labels_merged_into ON labels(merged_into_id);
