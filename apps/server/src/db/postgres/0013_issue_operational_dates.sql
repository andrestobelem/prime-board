-- PRB-526: fechas de planificación y ciclo de vida de Issues.
-- Las fechas se almacenan como ISO-8601 TEXT para conservar el formato de la réplica.
ALTER TABLE issues ADD COLUMN due_date TEXT;
ALTER TABLE issues ADD COLUMN started_at TEXT;
ALTER TABLE issues ADD COLUMN completed_at TEXT;
ALTER TABLE issues ADD COLUMN canceled_at TEXT;

CREATE INDEX idx_issues_due_date ON issues(due_date);
CREATE INDEX idx_issues_started_at ON issues(started_at);
CREATE INDEX idx_issues_completed_at ON issues(completed_at);
CREATE INDEX idx_issues_canceled_at ON issues(canceled_at);
