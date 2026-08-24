-- PRB-552: el trigger legacy de 0007 solo crea el grant implícito
-- cuando la instalación conserva el Workspace singleton. Las mutaciones de
-- API keys asignan de forma explícita el Workspace efectivo.

CREATE OR REPLACE FUNCTION prime_board_seed_api_key_workspace_grant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO api_key_workspaces (api_key_id, workspace_id, is_default, created_at)
  SELECT NEW.id, workspace.id, 1, NEW.created_at
  FROM workspace
  WHERE (SELECT count(*) FROM workspace) = 1
    AND NOT EXISTS (
      SELECT 1
      FROM api_key_workspaces grants
      WHERE grants.api_key_id = NEW.id
        AND grants.workspace_id = workspace.id
    );
  RETURN NEW;
END;
$$;
