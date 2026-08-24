import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLogWriter, type DomainEvent } from "./event-log.ts";
import {
  IssueEventPipeline,
  type CanonicalEventLog,
  type IssueEventCheckpointStore,
} from "./issue-event-pipeline.ts";
import type { ProjectorCheckpoint } from "./projector.ts";

const event = (eventId = "event-1"): DomainEvent => ({
  schemaVersion: 1,
  eventId,
  aggregate: "issue",
  aggregateKey: "PB-1",
  type: "created",
  actor: "admin",
  occurredAt: "2026-08-24T00:00:00.000Z",
  payload: { title: "Canonical issue" },
});

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "prb-issue-events-"));
  const writer = new EventLogWriter({ rootDir });
  const calls: string[] = [];
  const checkpoint: { value: ProjectorCheckpoint | undefined; fail: boolean } = {
    value: undefined,
    fail: false,
  };
  const store: IssueEventCheckpointStore = {
    load: () => checkpoint.value,
    save: (next) => {
      calls.push(`checkpoint:${next.eventId}`);
      if (checkpoint.fail) throw new Error("checkpoint unavailable");
      checkpoint.value = next;
    },
  };
  const eventLog: CanonicalEventLog = {
    appendMany: (events) => {
      calls.push("append");
      return writer.appendMany(events);
    },
    read: () => writer.read(),
  };
  return { rootDir, calls, checkpoint, eventLog, store };
}

describe("SQLite issue event pipeline", () => {
  it("retries an append failure without running later stages", () => {
    const fixtureData = fixture();
    let failAppend = true;
    const calls = fixtureData.calls;
    const eventLog: CanonicalEventLog = {
      appendMany: (events) => {
        calls.push("append");
        if (failAppend) throw new Error("log unavailable");
        return fixtureData.eventLog.appendMany(events);
      },
      read: () => fixtureData.eventLog.read(),
    };
    const pipeline = new IssueEventPipeline({
      rootDir: fixtureData.rootDir,
      eventLog,
      commitGit: () => calls.push("commit"),
      projector: { apply: () => calls.push("project") },
      checkpointStore: fixtureData.store,
    });

    expect(() => pipeline.append([event()])).toThrow("log unavailable");
    expect(calls).toEqual(["append"]);
    expect(pipeline.getCheckpoint()).toBeUndefined();

    failAppend = false;
    pipeline.append([event()]);
    pipeline.commit();
    pipeline.project();
    expect(calls).toEqual([
      "append",
      "append",
      "append",
      "commit",
      "project",
      "checkpoint:event-1",
    ]);
  });

  it("keeps append → Git commit → projector → checkpoint order and deduplicates retry", () => {
    const fixtureData = fixture();
    const applied: string[] = [];
    let failCommit = true;
    const pipeline = new IssueEventPipeline({
      rootDir: fixtureData.rootDir,
      eventLog: fixtureData.eventLog,
      commitGit: () => {
        fixtureData.calls.push("commit");
        if (failCommit) throw new Error("git unavailable");
      },
      projector: {
        apply: (current) => {
          fixtureData.calls.push(`project:${current.eventId}`);
          applied.push(current.eventId);
        },
      },
      checkpointStore: fixtureData.store,
    });

    pipeline.append([event()]);
    expect(() => pipeline.commit()).toThrow("git unavailable");
    expect(pipeline.getCheckpoint()).toBeUndefined();
    expect(fixtureData.calls).toEqual(["append", "commit"]);

    failCommit = false;
    pipeline.commit();
    pipeline.project();
    expect(fixtureData.calls).toEqual([
      "append",
      "commit",
      "commit",
      "project:event-1",
      "checkpoint:event-1",
    ]);
    expect(applied).toEqual(["event-1"]);
    expect(pipeline.getCheckpoint()).toEqual({
      stream: "issues",
      eventId: "event-1",
      occurredAt: event().occurredAt,
    });

    // The next mutation/retry sees the same event but does not reapply it.
    pipeline.append([event()]);
    pipeline.commit();
    const result = pipeline.project();
    expect(result).toMatchObject({ applied: 0, skipped: 1 });
    expect(applied).toEqual(["event-1"]);
    expect(writerEvents(fixtureData.eventLog)).toHaveLength(1);
  });

  it("does not advance the checkpoint when projector or checkpoint fails", () => {
    const fixtureData = fixture();
    let failProjector = true;
    const applied: string[] = [];
    const pipeline = new IssueEventPipeline({
      rootDir: fixtureData.rootDir,
      eventLog: fixtureData.eventLog,
      projector: {
        apply: (current) => {
          applied.push(current.eventId);
          if (failProjector) throw new Error("projector unavailable");
        },
      },
      checkpointStore: fixtureData.store,
    });
    pipeline.append([event()]);
    pipeline.commit();

    expect(() => pipeline.project()).toThrow("projector unavailable");
    expect(pipeline.getCheckpoint()).toBeUndefined();
    expect(fixtureData.checkpoint.value).toBeUndefined();

    failProjector = false;
    fixtureData.checkpoint.fail = true;
    expect(() => pipeline.project()).toThrow("checkpoint unavailable");
    expect(pipeline.getCheckpoint()).toBeUndefined();
    expect(fixtureData.checkpoint.value).toBeUndefined();

    fixtureData.checkpoint.fail = false;
    expect(pipeline.project()).toMatchObject({ applied: 1, skipped: 0 });
    expect(applied).toEqual(["event-1", "event-1", "event-1"]);
  });
});

function writerEvents(eventLog: CanonicalEventLog): DomainEvent[] {
  return eventLog.read();
}
