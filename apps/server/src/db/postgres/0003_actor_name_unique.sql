-- PRB-431: SQLite rechaza nombres de Actor case-insensitive dentro del singleton.
CREATE UNIQUE INDEX actors_name_lower_idx ON actors (lower(name));
