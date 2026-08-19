import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { PersistenceError } from "./persistence.ts";
import { createSqlitePersistence } from "./sqlite-persistence.ts";

describe("createSqlitePersistence", () => {
  it("normaliza one, many y comandos con RETURNING", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    const persistence = createSqlitePersistence(db);

    const inserted = await persistence.execute<{ id: number; name: string }>(
      "INSERT INTO items (name) VALUES ($1) RETURNING id, name",
      ["first"],
    );
    expect(inserted.rowCount).toBe(1);
    expect(inserted.rows).toEqual([{ id: 1, name: "first" }]);

    const item = await persistence.one<{ id: number; name: string }>(
      "SELECT id, name FROM items WHERE id = $1",
      [1],
    );
    expect(item).toEqual({ id: 1, name: "first" });
    expect(await persistence.one("SELECT id FROM items WHERE id = $1", [99])).toBeNull();
    expect(await persistence.many<{ id: number }>("SELECT id FROM items ORDER BY id")).toEqual([
      { id: 1 },
    ]);

    const updated = await persistence.execute<{ id: number; name: string }>(
      "UPDATE items SET name = $1 WHERE id = $2 RETURNING id, name",
      ["renamed", 1],
    );
    expect(updated.rowCount).toBe(1);
    expect(updated.rows).toEqual([{ id: 1, name: "renamed" }]);

    const deleted = await persistence.execute("DELETE FROM items WHERE id = $1", [1]);
    expect(deleted.rowCount).toBe(1);
    expect(deleted.rows).toEqual([]);
    await persistence.close();
  });

  it("confirma una transacción async y revierte otra que falla", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    const persistence = createSqlitePersistence(db);

    await persistence.transaction(async (tx) => {
      await tx.execute("INSERT INTO items (name) VALUES ($1)", ["committed"]);
    });
    expect(await persistence.one("SELECT name FROM items WHERE id = 1")).toEqual({
      name: "committed",
    });

    await expect(
      persistence.transaction(async (tx) => {
        await tx.execute("INSERT INTO items (name) VALUES ($1)", ["rolled back"]);
        throw new Error("domain failure");
      }),
    ).rejects.toThrow("domain failure");
    expect(await persistence.many("SELECT name FROM items ORDER BY id")).toEqual([
      { name: "committed" },
    ]);
    await persistence.close();
  });

  it("cierra de forma idempotente y rechaza operaciones posteriores", async () => {
    const db = new Database(":memory:");
    const persistence = createSqlitePersistence(db);

    await persistence.close();
    await persistence.close();
    await expect(persistence.many("SELECT 1")).rejects.toMatchObject({
      operation: "many",
      message: "Persistence many failed",
    });
  });

  it("expone errores del driver sin filtrar SQL ni parámetros", async () => {
    const db = new Database(":memory:");
    const persistence = createSqlitePersistence(db);

    const rejection = persistence.one("SELECT * FROM missing_table WHERE secret = $1", [
      "do-not-log",
    ]);
    await expect(rejection).rejects.toBeInstanceOf(PersistenceError);
    try {
      await rejection;
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      if (error instanceof PersistenceError) {
        expect(error.message).toBe("Persistence one failed");
        expect(error.message).not.toContain("do-not-log");
      }
    }
    await persistence.close();
  });
});
