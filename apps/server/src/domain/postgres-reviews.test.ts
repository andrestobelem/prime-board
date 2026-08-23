import { describe, expect, it } from "bun:test";
import type {
  Persistence,
  PersistenceResult,
  PersistenceTransaction,
  SqlParameters,
} from "../db/persistence.ts";
import type { ReviewRow } from "./reviews.ts";
import { listPostgresReviews } from "./postgres-reviews.ts";

const rows: ReviewRow[] = [
  {
    id: "review-2",
    issue_id: "issue-1",
    requester_id: "viewer",
    reviewer_id: "reviewer",
    status: "requested",
    created_at: "2030-01-01T00:02:00.000Z",
    updated_at: "2030-01-01T00:02:00.000Z",
  },
  {
    id: "review-1",
    issue_id: "issue-1",
    requester_id: "viewer",
    reviewer_id: "reviewer",
    status: "requested",
    created_at: "2030-01-01T00:01:00.000Z",
    updated_at: "2030-01-01T00:01:00.000Z",
  },
  {
    id: "review-0",
    issue_id: "issue-1",
    requester_id: "viewer",
    reviewer_id: "reviewer",
    status: "requested",
    created_at: "2030-01-01T00:00:00.000Z",
    updated_at: "2030-01-01T00:00:00.000Z",
  },
];

function fakePersistence(): { persistence: Persistence; queries: string[] } {
  const queries: string[] = [];
  const transaction: PersistenceTransaction = {
    one: async <Row extends object>(sql: string, params?: SqlParameters) => {
      queries.push(sql);
      if (!sql.includes("SELECT reviews.created_at")) return null;
      const id = String(params?.[params.length - 1]);
      const row = rows.find((candidate) => candidate.id === id);
      return row ? ({ created_at: row.created_at } as Row) : null;
    },
    many: async <Row extends object>(sql: string) => {
      queries.push(sql);
      if (sql.includes("1 = 0")) return [] as Row[];
      if (sql.includes("(reviews.created_at, reviews.id) <")) {
        return [rows[2]] as Row[];
      }
      return rows as Row[];
    },
    execute: async <Row extends object>() =>
      ({ rows: [], rowCount: 0 }) satisfies PersistenceResult<Row>,
  };
  return {
    persistence: {
      ...transaction,
      transaction: async (callback) => callback(transaction),
      close: async () => undefined,
    },
    queries,
  };
}

describe("PostgreSQL reviews", () => {
  it("returns a ReviewConnection page and validates cursors with filters", async () => {
    const fake = fakePersistence();
    const first = await listPostgresReviews(fake.persistence, "viewer", {
      first: 2,
      reviewerId: "reviewer",
      teamIds: ["team-1"],
    });

    expect(first.rows.map((row) => row.id)).toEqual(["review-2", "review-1"]);
    expect(first.hasNextPage).toBe(true);
    expect(first.endCursor).toBeString();
    expect(fake.queries[0]).toContain("issues.team_id IN ($3)");

    const second = await listPostgresReviews(fake.persistence, "viewer", {
      first: 2,
      after: first.endCursor,
      reviewerId: "reviewer",
      teamIds: ["team-1"],
    });
    expect(second.rows.map((row) => row.id)).toEqual(["review-0"]);
    expect(second.hasNextPage).toBe(false);

    await expect(
      listPostgresReviews(fake.persistence, "viewer", {
        first: 2,
        after: first.endCursor,
        openOnly: true,
        reviewerId: "reviewer",
        teamIds: ["team-1"],
      }),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });
  });

  it("returns an empty page when no authorized Teams remain", async () => {
    const fake = fakePersistence();
    const page = await listPostgresReviews(fake.persistence, "viewer", { teamIds: [] });

    expect(page).toEqual({ rows: [], hasNextPage: false, endCursor: null });
  });
});
