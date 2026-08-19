import { afterEach, describe, expect, it } from "bun:test";
import { openPersistence, resolvePersistenceBackend } from "./backend.ts";
import { loadConfig } from "../config.ts";
import type { Persistence } from "./persistence.ts";

const openConnections: Persistence[] = [];

afterEach(async () => {
  while (openConnections.length > 0) {
    await openConnections.pop()!.close();
  }
});

describe("persistence backend selection", () => {
  it("resolves SQLite by default and keeps its compatibility pragmas", async () => {
    const persistence = openPersistence({ path: ":memory:" });
    openConnections.push(persistence);

    const foreignKeys = await persistence.one<{ foreign_keys: number }>("PRAGMA foreign_keys");
    expect(foreignKeys).toEqual({ foreign_keys: 1 });
    await persistence.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    await persistence.execute("INSERT INTO items (name) VALUES ($1)", ["SQLite fallback"]);
    expect(
      await persistence.one<{ name: string }>("SELECT name FROM items WHERE id = $1", [1]),
    ).toEqual({
      name: "SQLite fallback",
    });
  });

  it("accepts an explicit SQLite selection and rejects unsupported values early", () => {
    expect(loadConfig({}).persistenceBackend).toBe("sqlite");
    expect(loadConfig({ PRIME_BOARD_PERSISTENCE: "sqlite" }).persistenceBackend).toBe("sqlite");
    expect(resolvePersistenceBackend(undefined)).toBe("sqlite");
    expect(resolvePersistenceBackend("sqlite")).toBe("sqlite");
    expect(resolvePersistenceBackend("postgres")).toBe("postgres");
    expect(() => resolvePersistenceBackend("mysql")).toThrow(
      "Unsupported persistence backend: mysql",
    );
    expect(() => openPersistence({ backend: "postgres", path: ":memory:" })).toThrow(
      "PostgreSQL persistence backend is not available yet",
    );
  });
});
