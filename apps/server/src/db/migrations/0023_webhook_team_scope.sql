-- PRB-381: cada webhook puede quedar limitado a un Team.
ALTER TABLE webhooks ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE CASCADE;
CREATE INDEX idx_webhooks_team ON webhooks(team_id);
