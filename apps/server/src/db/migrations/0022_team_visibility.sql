-- PRB-381: visibilidad y política de acceso por Team.
ALTER TABLE teams ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'private'));
ALTER TABLE teams ADD COLUMN access_policy TEXT NOT NULL DEFAULT 'team_members'
  CHECK (access_policy IN ('workspace_members', 'team_members'));
