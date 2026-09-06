-- PRB-386: preferencias personales de notificaciones por categoría y canal.
-- La fila solo puede apuntar a una Membership válida del mismo Workspace.
-- La migración 0031 pertenece a PRB-382; este dominio queda separado de UserSettings.
CREATE TABLE notification_preferences (
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN ('assignments', 'mentions', 'comments', 'status_changes', 'reviews', 'project_updates')
  ),
  channel TEXT NOT NULL CHECK (
    channel IN ('inbox', 'desktop', 'mobile', 'email', 'slack')
  ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  email_delivery TEXT CHECK (email_delivery IN ('digest', 'immediate')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, actor_id, category, channel),
  CHECK (
    (channel = 'email' AND email_delivery IS NOT NULL)
    OR (channel <> 'email' AND email_delivery IS NULL)
  ),
  FOREIGN KEY (workspace_id, actor_id)
    REFERENCES workspace_memberships(workspace_id, actor_id) ON DELETE CASCADE
);
CREATE INDEX idx_notification_preferences_actor_workspace
  ON notification_preferences(actor_id, workspace_id);
