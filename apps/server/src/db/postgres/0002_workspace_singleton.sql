-- PRB-430: el modelo single-workspace se refuerza también en PostgreSQL.
CREATE UNIQUE INDEX workspace_singleton_idx ON workspace ((TRUE));
