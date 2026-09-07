import { describe, expect, it } from "bun:test";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import type { Persistence, PersistenceTransaction, SqlParameters } from "../db/persistence.ts";
import type { ActorRow } from "../auth/viewer.ts";
import {
  deletePostgresInitiativeUpdate,
  lockPostgresInitiativeScope,
} from "./postgres-initiatives.ts";
import { deletePostgresProjectDependency } from "./postgres-projects.ts";

function row<Row extends object>(value: Record<string, unknown>): Row {
  return fromAny<Row, Record<string, unknown>>(value);
}

interface Waiter {
  readonly owner: string;
  readonly resolve: () => void;
}

/** Simula locks de filas para forzar el interleaving que provocaba el deadlock. */
class RowLockScheduler {
  private readonly owners = new Map<string, string>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly firstTeamOwners = new Set<string>();
  private readonly teamArrivals = new Set<string>();
  private readonly teamBarrier: Promise<void>;
  private releaseTeamBarrier!: () => void;

  constructor() {
    this.teamBarrier = new Promise<void>((resolve) => {
      this.releaseTeamBarrier = resolve;
    });
  }

  async acquire(owner: string, resource: string): Promise<void> {
    if (resource.startsWith("team:") && !this.firstTeamOwners.has(owner)) {
      this.firstTeamOwners.add(owner);
      this.teamArrivals.add(owner);
      if (this.teamArrivals.size === 2) this.releaseTeamBarrier();
      await this.teamBarrier;
    }
    const currentOwner = this.owners.get(resource);
    if (!currentOwner || currentOwner === owner) {
      this.owners.set(resource, owner);
      return;
    }
    await new Promise<void>((resolve) => {
      const resourceWaiters = this.waiters.get(resource) ?? [];
      resourceWaiters.push({ owner, resolve });
      this.waiters.set(resource, resourceWaiters);
    });
  }

  release(owner: string): void {
    for (const [resource, currentOwner] of this.owners) {
      if (currentOwner !== owner) continue;
      const resourceWaiters = this.waiters.get(resource) ?? [];
      const next = resourceWaiters.shift();
      if (next) {
        this.owners.set(resource, next.owner);
        next.resolve();
      } else {
        this.owners.delete(resource);
      }
      if (resourceWaiters.length === 0) this.waiters.delete(resource);
    }
  }

  heldRows(): number {
    return this.owners.size;
  }
}

function planningLockTransaction(
  scheduler: RowLockScheduler,
  owner: string,
  fixture: {
    initiativeId: string;
    projectId: string;
    projectTeamId: string;
    directTeamId: string;
  },
): PersistenceTransaction {
  const lock = async (sql: string, params?: SqlParameters): Promise<void> => {
    if (!sql.includes("FOR UPDATE")) return;
    const id = String(params?.[0]);
    if (sql.includes("FROM initiatives")) {
      await scheduler.acquire(owner, `initiative:${id}`);
    } else if (sql.includes("FROM projects")) {
      await scheduler.acquire(owner, `project:${id}`);
    } else if (sql.includes("FROM teams")) {
      await scheduler.acquire(owner, `team:${id}`);
    } else if (sql.includes("FROM project_teams")) {
      await scheduler.acquire(owner, `project_teams:${fixture.projectId}`);
    } else if (sql.includes("FROM initiative_projects")) {
      await scheduler.acquire(owner, `initiative_projects:${fixture.initiativeId}`);
    } else if (sql.includes("FROM initiative_teams")) {
      await scheduler.acquire(owner, `initiative_teams:${fixture.initiativeId}`);
    }
  };

  return fromPartial<PersistenceTransaction>({
    one: async <Row extends object>(sql: string, params?: SqlParameters) => {
      await lock(sql, params);
      if (sql.includes("FROM initiatives"))
        return row<Row>({ id: fixture.initiativeId, owner_id: null });
      if (sql.includes("FROM projects")) return row<Row>({ id: fixture.projectId });
      if (sql.includes("FROM teams")) return row<Row>({ id: params?.[0] });
      return null;
    },
    many: async <Row extends object>(sql: string, params?: SqlParameters) => {
      if (sql.includes("FROM workspace")) return [row<Row>({ id: "workspace" })];
      await lock(sql, params);
      if (sql.includes("FROM project_teams")) {
        return [row<Row>({ team_id: fixture.projectTeamId })];
      }
      if (sql.includes("FROM initiative_projects")) {
        return [row<Row>({ project_id: fixture.projectId })];
      }
      if (sql.includes("FROM initiative_teams")) {
        return [row<Row>({ team_id: fixture.directTeamId })];
      }
      return [];
    },
    execute: async <Row extends object>() => ({ rows: [], rowCount: 0 }),
  });
}

function dependencyPersistence(trace: string[]): Persistence {
  const dependency = {
    id: "dependency-1",
    project_id: "project-a",
    depends_on_project_id: "project-b",
    type: "blocks",
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const tx = fromPartial<PersistenceTransaction>({
    one: async <Row extends object>(sql: string, params?: SqlParameters) => {
      if (sql.includes("FROM workspace")) return row<Row>({ id: "workspace" });
      if (sql.includes("FROM project_dependencies")) {
        if (sql.includes("FOR UPDATE")) trace.push("dependency");
        return row<Row>(dependency);
      }
      if (sql.includes("FROM projects")) {
        if (sql.includes("FOR UPDATE")) trace.push(`project:${String(params?.[0])}`);
        return row<Row>({ id: params?.[0] });
      }
      if (sql.includes("FROM teams")) {
        trace.push(`team:${String(params?.[0])}`);
        return row<Row>({ id: params?.[0] });
      }
      return null;
    },
    many: async <Row extends object>(sql: string) => {
      if (sql.includes("FROM project_teams")) return [row<Row>({ team_id: "team-0" })];
      return [];
    },
    execute: async <Row extends object>() => {
      trace.push("delete");
      return { rows: [], rowCount: 1 };
    },
  });
  return fromPartial<Persistence>({
    ...tx,
    transaction: async <Result>(
      callback: (transaction: PersistenceTransaction) => Promise<Result>,
    ) => callback(tx),
    close: async () => undefined,
  });
}

function initiativeUpdatePersistence(trace: string[]): Persistence {
  const tx = fromPartial<PersistenceTransaction>({
    one: async <Row extends object>(sql: string, params?: SqlParameters) => {
      if (sql.includes("FROM workspace")) return row<Row>({ id: "workspace" });
      if (sql.includes("FROM initiative_updates")) {
        if (sql.includes("FOR UPDATE")) trace.push("update");
        return row<Row>({ id: params?.[0], initiative_id: "initiative-a" });
      }
      if (sql.includes("FROM initiatives")) {
        if (sql.includes("FOR UPDATE")) trace.push("initiative");
        return row<Row>({ id: "initiative-a", owner_id: null });
      }
      if (sql.includes("FROM projects")) {
        if (sql.includes("FOR UPDATE")) trace.push("project");
        return row<Row>({ id: "project-a" });
      }
      if (sql.includes("FROM teams")) {
        trace.push("team");
        return row<Row>({ id: "team-0" });
      }
      return null;
    },
    many: async <Row extends object>(sql: string) => {
      if (sql.includes("FROM project_teams")) return [row<Row>({ team_id: "team-0" })];
      if (sql.includes("FROM initiative_projects")) return [row<Row>({ project_id: "project-a" })];
      if (sql.includes("FROM initiative_teams")) return [row<Row>({ team_id: "team-0" })];
      return [];
    },
    execute: async <Row extends object>() => {
      trace.push("delete");
      return { rows: [], rowCount: 1 };
    },
  });
  return fromPartial<Persistence>({
    ...tx,
    transaction: async <Result>(
      callback: (transaction: PersistenceTransaction) => Promise<Result>,
    ) => callback(tx),
    close: async () => undefined,
  });
}

describe("Orden de locks de Planning en PostgreSQL", () => {
  it("serializa scopes cruzados de Initiative sin deadlock", async () => {
    const scheduler = new RowLockScheduler();
    const first = planningLockTransaction(scheduler, "first", {
      initiativeId: "initiative-a",
      projectId: "project-a",
      projectTeamId: "team-1",
      directTeamId: "team-0",
    });
    const second = planningLockTransaction(scheduler, "second", {
      initiativeId: "initiative-b",
      projectId: "project-b",
      projectTeamId: "team-0",
      directTeamId: "team-1",
    });
    const run = async (owner: string, tx: PersistenceTransaction, initiativeId: string) => {
      try {
        return await lockPostgresInitiativeScope(tx, initiativeId);
      } finally {
        scheduler.release(owner);
      }
    };
    const operations = Promise.all([
      run("first", first, "initiative-a"),
      run("second", second, "initiative-b"),
    ]);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("La prueba de locks cruzados de Initiative agotó el timeout")),
        250,
      );
    });

    let result: Awaited<typeof operations>;
    try {
      result = await Promise.race([operations, timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    expect(result).toHaveLength(2);
    expect(result[0]?.teamIds).toEqual(["team-0", "team-1"]);
    expect(result[1]?.teamIds).toEqual(["team-0", "team-1"]);
    expect(scheduler.heldRows()).toBe(0);
  });

  it("bloquea raíces de Project antes de una fila de dependency", async () => {
    const trace: string[] = [];
    await expect(
      deletePostgresProjectDependency(dependencyPersistence(trace), "dependency-1", "workspace"),
    ).resolves.toBe(true);
    expect(trace.indexOf("project:project-a")).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf("project:project-b")).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf("project:project-a")).toBeLessThan(trace.indexOf("project:project-b"));
    expect(trace.indexOf("dependency")).toBeGreaterThan(trace.indexOf("project:project-a"));
    expect(trace.indexOf("dependency")).toBeGreaterThan(trace.indexOf("project:project-b"));
  });

  it("bloquea la raíz de Initiative antes de una fila de update", async () => {
    const trace: string[] = [];
    await expect(
      deletePostgresInitiativeUpdate(
        initiativeUpdatePersistence(trace),
        fromPartial<ActorRow>({ id: "admin", workspace_role: "admin" }),
        "update-1",
        "workspace",
      ),
    ).resolves.toBe(true);
    expect(trace.indexOf("initiative")).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf("project")).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf("team")).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf("update")).toBeGreaterThan(trace.indexOf("initiative"));
    expect(trace.indexOf("update")).toBeGreaterThan(trace.indexOf("project"));
    expect(trace.indexOf("update")).toBeGreaterThan(trace.indexOf("team"));
  });
});
