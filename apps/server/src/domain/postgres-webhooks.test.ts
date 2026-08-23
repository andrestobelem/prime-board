import { describe, expect, it } from "bun:test";
import type {
  Persistence,
  PersistenceResult,
  PersistenceTransaction,
  SqlParameters,
} from "../db/persistence.ts";
import {
  createPostgresWebhook,
  deletePostgresWebhook,
  listPostgresWebhooks,
  mapPostgresWebhook,
} from "./postgres-webhooks.ts";
import type { PostgresWebhookRow } from "./postgres-webhooks.ts";

function fakePersistence(rows: PostgresWebhookRow[]): {
  persistence: Persistence;
  inserts: SqlParameters[];
  deletes: SqlParameters[];
} {
  const inserts: SqlParameters[] = [];
  const deletes: SqlParameters[] = [];
  const transaction: PersistenceTransaction = {
    one: async <Row extends object>(sql: string, params?: SqlParameters) => {
      if (sql.includes("INSERT INTO webhooks")) {
        inserts.push(params ?? []);
        const [id, url, secret, events, createdAt, ownerId, teamId] = params ?? [];
        return {
          id,
          url,
          secret,
          events,
          enabled: true,
          created_at: createdAt,
          owner_id: ownerId,
          team_id: teamId,
        } as Row;
      }
      if (sql.includes("FROM webhooks")) {
        const id = params?.[0];
        return ((id ? rows.find((row) => row.id === id) : rows[0]) as Row | undefined) ?? null;
      }
      if (sql.includes("FROM teams")) {
        return { id: params?.[0], visibility: "public" } as Row;
      }
      return null;
    },
    many: async <Row extends object>(sql: string, params?: SqlParameters) => {
      if (sql.includes("FROM webhooks")) {
        const ownerId = params?.[0];
        return rows.filter((row) => ownerId === undefined || row.owner_id === ownerId) as Row[];
      }
      return [];
    },
    execute: async <Row extends object>(sql: string, params?: SqlParameters) => {
      if (sql.includes("DELETE FROM webhooks")) deletes.push(params ?? []);
      return { rows: [], rowCount: 1 } satisfies PersistenceResult<Row>;
    },
  };
  return {
    persistence: {
      ...transaction,
      transaction: async (callback) => callback(transaction),
      close: async () => undefined,
    },
    inserts,
    deletes,
  };
}

const row: PostgresWebhookRow = {
  id: "hook-1",
  url: "https://example.test/hook",
  secret: "SUPERSECRET",
  events: '["issue.created"]',
  enabled: true,
  created_at: "2026-01-01T00:00:00.000Z",
  owner_id: "actor-1",
  team_id: null,
};

describe("PostgreSQL webhooks", () => {
  it("maps the public contract without exporting ownership or the secret", () => {
    const mapped = mapPostgresWebhook(row);
    expect(mapped).toEqual({
      id: "hook-1",
      url: "https://example.test/hook",
      events: ["issue.created"],
      enabled: true,
      teamId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(mapped).not.toHaveProperty("secret");
    expect(mapped).not.toHaveProperty("ownerId");
  });

  it("persists a provided secret and returns it only from creation", async () => {
    const fake = fakePersistence([]);
    const created = await createPostgresWebhook(
      fake.persistence,
      { id: "actor-1", workspace_role: "member" },
      {
        url: row.url,
        secret: row.secret,
        events: ["issue.created"],
      },
    );

    expect(fake.inserts[0]?.[2]).toBe("SUPERSECRET");
    expect(created.secret).toBe("SUPERSECRET");
    expect(mapPostgresWebhook(created.row)).not.toHaveProperty("secret");
  });

  it("lists only the owner's hooks for a non-admin and preserves enabled", async () => {
    const fake = fakePersistence([
      row,
      { ...row, id: "hook-2", owner_id: "actor-1", enabled: false },
    ]);
    const listed = await listPostgresWebhooks(fake.persistence, {
      id: "actor-1",
      workspace_role: "member",
    });
    expect(listed.map((hook) => hook.id)).toEqual(["hook-1", "hook-2"]);
    expect(listed[1]?.enabled).toBe(false);

    await deletePostgresWebhook(fake.persistence, "hook-1", {
      id: "actor-1",
      workspace_role: "member",
    });
    expect(fake.deletes).toEqual([["hook-1"]]);
  });
});
