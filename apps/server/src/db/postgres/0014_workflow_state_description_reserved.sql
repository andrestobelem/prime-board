-- PRB-383: agrega descripciones y el estado Duplicate administrado por el sistema.
ALTER TABLE workflow_states ADD COLUMN description TEXT;
ALTER TABLE workflow_states ADD COLUMN is_reserved BOOLEAN NOT NULL DEFAULT FALSE;
