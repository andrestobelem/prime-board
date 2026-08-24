import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DomainEvent, EventLogWriter } from "./event-log.ts";
import type { Persistence, PersistenceTransaction } from "../db/persistence.ts";
import { EventProjector, replayPostgresEvents } from "./projector.ts";

const event = (eventId: string, occurredAt: string): DomainEvent => ({
  schemaVersion: 1,
  eventId,
  aggregate: "issue",
  aggregateKey: "issue-1",
  type: "issue.updated",
  actor: "agent",
  occurredAt,
  payload: { eventId },
});

describe("event projector", () => {
  it("replays from a checkpoint and advances only after apply succeeds", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-projector-"));
    const writer = new EventLogWriter({ rootDir });
    writer.append(event("one", "2025-01-01T00:00:00.000Z"));
    writer.append(event("two", "2025-01-02T00:00:00.000Z"));
    const applied: string[] = [];
    const projector = new EventProjector((current) => applied.push(current.eventId), {
      rootDir,
      stream: "issues",
      checkpoint: { stream: "issues", eventId: "one", occurredAt: "2025-01-01T00:00:00.000Z" },
    });

    const result = projector.replay();
    expect(result).toMatchObject({ applied: 1, skipped: 1, failed: false });
    expect(applied).toEqual(["two"]);
    expect(projector.getCheckpoint()).toEqual({
      stream: "issues",
      eventId: "two",
      occurredAt: "2025-01-02T00:00:00.000Z",
    });
  });

  it("supports a complete replay and an explicit resume checkpoint", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-projector-"));
    const writer = new EventLogWriter({ rootDir });
    writer.append(event("one", "2025-01-01T00:00:00.000Z"));
    writer.append(event("two", "2025-01-02T00:00:00.000Z"));
    const applied: string[] = [];
    const projector = new EventProjector((current) => applied.push(current.eventId), {
      rootDir,
      stream: "issues",
    });

    expect(projector.replayFromBeginning()).toMatchObject({ applied: 2, failed: false });
    expect(
      projector.resume({
        stream: "issues",
        eventId: "one",
        occurredAt: "2025-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({ applied: 1, skipped: 1, failed: false });
    expect(applied).toEqual(["one", "two", "two"]);
  });

  it("returns a retry-visible failure and does not advance the checkpoint", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-projector-"));
    const writer = new EventLogWriter({ rootDir });
    writer.append(event("one", "2025-01-01T00:00:00.000Z"));
    writer.append(event("two", "2025-01-02T00:00:00.000Z"));
    let shouldFail = true;
    const applied: string[] = [];
    const projector = new EventProjector(
      (current) => {
        if (shouldFail && current.eventId === "two") throw new Error("temporary failure");
        applied.push(current.eventId);
      },
      { rootDir, stream: "issues" },
    );

    const failed = projector.replay();
    expect(failed).toMatchObject({ applied: 1, skipped: 0, failed: true });
    expect(failed.error).toBeInstanceOf(Error);
    expect(failed.checkpoint).toEqual({
      stream: "issues",
      eventId: "one",
      occurredAt: "2025-01-01T00:00:00.000Z",
    });
    expect(projector.getCheckpoint()).toEqual(failed.checkpoint);

    shouldFail = false;
    const retried = projector.replay();
    expect(retried).toMatchObject({ applied: 1, failed: false });
    expect(applied).toEqual(["one", "two"]);
  });
});

describe("async projector checkpoints", () => {
  it("loads and saves a durable checkpoint only after apply succeeds", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-projector-"));
    const writer = new EventLogWriter({ rootDir });
    writer.append(event("one", "2025-01-01T00:00:00.000Z"));
    writer.append(event("two", "2025-01-02T00:00:00.000Z"));
    const calls: string[] = [];
    const store = {
      async load(stream: string) {
        calls.push(`load:${stream}`);
        return {
          stream,
          eventId: "one",
          occurredAt: "2025-01-01T00:00:00.000Z",
        };
      },
      async save(checkpoint: { eventId: string }) {
        calls.push(`save:${checkpoint.eventId}`);
      },
    };
    const projector = new EventProjector(
      async (current) => {
        calls.push(`apply:${current.eventId}`);
      },
      { rootDir, stream: "issues", checkpointStore: store },
    );

    const result = await projector.replayAsync();
    expect(result).toMatchObject({
      status: "completed",
      kind: "completed",
      applied: 1,
      skipped: 1,
      failed: false,
      lag: 0,
      retry: false,
    });
    expect(calls).toEqual(["load:issues", "apply:two", "save:two"]);
  });

  it("returns a discriminated retry result and leaves the failed event pending", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-projector-"));
    const writer = new EventLogWriter({ rootDir });
    writer.append(event("one", "2025-01-01T00:00:00.000Z"));
    writer.append(event("two", "2025-01-02T00:00:00.000Z"));
    let shouldFail = true;
    const saves: string[] = [];
    const projector = new EventProjector(
      async (current) => {
        if (shouldFail && current.eventId === "two") throw new Error("temporary failure");
      },
      {
        rootDir,
        stream: "issues",
        checkpointStore: {
          async load() {
            return undefined;
          },
          async save(checkpoint) {
            saves.push(checkpoint.eventId);
          },
        },
      },
    );

    const failed = await projector.replayAsync();
    expect(failed).toMatchObject({
      status: "failed",
      kind: "failed",
      applied: 1,
      failed: true,
      lag: 1,
      lagging: true,
      retry: true,
      retryable: true,
    });
    expect(saves).toEqual(["one"]);
    shouldFail = false;
    const retried = await projector.replayAsync();
    expect(retried).toMatchObject({ status: "completed", applied: 1, failed: false });
    expect(saves).toEqual(["one", "two"]);
  });
});

describe("atomic PostgreSQL projector", () => {
  function persistence() {
    const committed: string[] = [];
    const store = {
      one: async () => null,
      many: async () => [],
      execute: async () => ({ rows: [], rowCount: 0 }),
      close: async () => undefined,
      transaction: async <Result>(callback: (tx: PersistenceTransaction) => Promise<Result>) => {
        const pending: string[] = [];
        const tx: PersistenceTransaction = {
          one: async () => null,
          many: async () => [],
          execute: async (sql: string) => {
            pending.push(sql.includes("projector_checkpoints") ? "checkpoint" : "domain");
            return { rows: [], rowCount: 1 };
          },
        };
        const result = await callback(tx);
        committed.push(...pending);
        return result;
      },
    } satisfies Persistence;
    return { persistence: store, committed };
  }

  it("commits domain apply and checkpoint together", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-projector-pg-"));
    const writer = new EventLogWriter({ rootDir });
    writer.append(event("one", "2025-01-01T00:00:00.000Z"));
    const fake = persistence();
    const result = await replayPostgresEvents(
      async (tx, current) => {
        await tx.execute("INSERT INTO projected_events (event_id) VALUES ($1)", [current.eventId]);
      },
      { rootDir, stream: "issues", persistence: fake.persistence },
    );
    expect(result).toMatchObject({ status: "completed", applied: 1, lag: 0 });
    expect(fake.committed).toEqual(["domain", "checkpoint"]);
  });

  it("rolls back both writes and retries the failed event", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "prb-projector-pg-"));
    const writer = new EventLogWriter({ rootDir });
    writer.append(event("one", "2025-01-01T00:00:00.000Z"));
    writer.append(event("two", "2025-01-02T00:00:00.000Z"));
    const fake = persistence();
    let fail = true;
    const first = await replayPostgresEvents(
      async (tx, current) => {
        await tx.execute("INSERT INTO projected_events (event_id) VALUES ($1)", [current.eventId]);
        if (fail && current.eventId === "two") throw new Error("domain failure");
      },
      { rootDir, stream: "issues", persistence: fake.persistence },
    );
    expect(first).toMatchObject({ status: "failed", applied: 1, failed: true, lag: 1 });
    expect(fake.committed).toEqual(["domain", "checkpoint"]);
    fail = false;
    const second = await replayPostgresEvents(
      async (tx, current) => {
        await tx.execute("INSERT INTO projected_events (event_id) VALUES ($1)", [current.eventId]);
      },
      { rootDir, stream: "issues", persistence: fake.persistence, checkpoint: first.checkpoint },
    );
    expect(second).toMatchObject({ status: "completed", applied: 1, skipped: 1 });
    expect(fake.committed).toEqual(["domain", "checkpoint", "domain", "checkpoint"]);
  });
});
