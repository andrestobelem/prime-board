import { describe, expect, test } from "bun:test";
import type { Persistence } from "../db/persistence.ts";
import { canQueryPostgresIssueFilter } from "./issue-resolvers.ts";
import type { Context } from "./context.ts";

describe("PostgreSQL issue filter authorization", () => {
  test("denies a Team-limited key when a milestone project spans another Team", async () => {
    const persistence = {
      one: async <Row extends object = Record<string, unknown>>() =>
        ({ id: "milestone-a", project_id: "project-shared" }) as Row,
      many: async <Row extends object = Record<string, unknown>>() =>
        [{ team_id: "team-a" }, { team_id: "team-b" }] as Row[],
    } as unknown as Persistence;
    const context = {
      persistence,
      auth: { teamIds: ["team-a"] },
    } as unknown as Context;

    await expect(
      canQueryPostgresIssueFilter(context, { milestone: { eq: "milestone-a" } }),
    ).resolves.toBe(false);
  });

  test("allows a milestone filter when all project Teams are in the key allowlist", async () => {
    const persistence = {
      one: async <Row extends object = Record<string, unknown>>() =>
        ({ id: "milestone-a", project_id: "project-a" }) as Row,
      many: async <Row extends object = Record<string, unknown>>() =>
        [{ team_id: "team-a" }] as Row[],
    } as unknown as Persistence;
    const context = {
      persistence,
      auth: { teamIds: ["team-a"] },
    } as unknown as Context;

    await expect(
      canQueryPostgresIssueFilter(context, { milestone: { eq: "milestone-a" } }),
    ).resolves.toBe(true);
  });
});
