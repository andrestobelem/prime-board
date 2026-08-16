-- Reviews de issues (PRB-205): cola de aprobación.
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  requester_id TEXT NOT NULL REFERENCES actors(id),
  reviewer_id TEXT NOT NULL REFERENCES actors(id),
  status TEXT NOT NULL CHECK (status IN ('requested', 'in_progress', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_reviews_reviewer ON reviews(reviewer_id, status);
CREATE INDEX idx_reviews_issue ON reviews(issue_id);
