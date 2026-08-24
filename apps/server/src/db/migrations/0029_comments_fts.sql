-- Full-text search index for visible issue comments.
CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
  body, content='comments', content_rowid='rowid'
);

INSERT INTO comments_fts(comments_fts) VALUES ('rebuild');

CREATE TRIGGER IF NOT EXISTS comments_fts_insert AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS comments_fts_delete AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS comments_fts_update AFTER UPDATE OF body ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO comments_fts(rowid, body) VALUES (new.rowid, new.body);
END;
