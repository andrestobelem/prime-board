import { describe, expect, it } from "bun:test";
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DomainEvent,
  EventLogConflictError,
  EventLogValidationError,
  EventLogWriter,
  mergeEventStreams,
} from "./event-log.ts";

const event = (overrides: Partial<DomainEvent> = {}): DomainEvent => ({
  schemaVersion: 1,
  eventId: "event-1",
  aggregate: "issue",
  aggregateKey: "issue-1",
  type: "issue.created",
  actor: "agent",
  occurredAt: "2025-01-01T00:00:00.000Z",
  payload: { title: "An issue" },
  ...overrides,
});

const logOptions = () => ({ rootDir: mkdtempSync(join(tmpdir(), "prb-event-log-")) });

class CountingEventLogWriter extends EventLogWriter {
  readCalls = 0;

  override read(): DomainEvent[] {
    this.readCalls += 1;
    return super.read();
  }
}

describe("event log", () => {
  it("orders events by occurredAt and eventId", () => {
    const options = logOptions();
    const writer = new EventLogWriter(options);
    writer.append(event({ eventId: "z", occurredAt: "2025-01-02T00:00:00.000Z" }));
    writer.append(event({ eventId: "b", occurredAt: "2025-01-01T00:00:00.000Z" }));
    writer.append(event({ eventId: "a", occurredAt: "2025-01-01T00:00:00.000Z" }));

    expect(writer.read().map(({ eventId }) => eventId)).toEqual(["a", "b", "z"]);
  });

  it("deduplicates idempotent appends and rejects conflicting IDs", () => {
    const writer = new EventLogWriter(logOptions());
    expect(writer.append(event())).toEqual({ eventId: "event-1", appended: true });
    expect(writer.append(event())).toEqual({ eventId: "event-1", appended: false });
    expect(() => writer.append(event({ payload: { title: "changed" } }))).toThrow(
      EventLogConflictError,
    );
    expect(writer.read()).toHaveLength(1);
  });

  it("lee el log una sola vez por lote idempotente", () => {
    const writer = new CountingEventLogWriter(logOptions());
    const events = Array.from({ length: 3 }, (_, index) =>
      event({ eventId: `batch-${index}`, aggregateKey: `issue-${index}` }),
    );

    expect(writer.appendMany(events).every((result) => result.appended)).toBe(true);
    expect(writer.readCalls).toBe(1);

    expect(writer.appendMany(events).every((result) => !result.appended)).toBe(true);
    expect(writer.readCalls).toBe(2);
  });

  it("fails closed for malformed and non-JSON input", () => {
    const options = logOptions();
    const writer = new EventLogWriter(options);
    writer.recover();
    writeFileSync(writer.filePath, "not-json\n");
    expect(() => writer.read()).toThrow();
    expect(() => writer.append({ ...event(), payload: { secret: "no" } })).toThrow(
      EventLogValidationError,
    );
  });

  it("merges by event ID and sorts deterministically independent of stream order", () => {
    const first = event({ eventId: "b", occurredAt: "2025-01-01T00:00:00.000Z" });
    const second = event({ eventId: "a", occurredAt: "2025-01-01T00:00:00.000Z" });
    const duplicate = event({ eventId: "b", occurredAt: "2025-01-01T00:00:00.000Z" });
    expect(mergeEventStreams([[first], [second, duplicate]])).toEqual(
      mergeEventStreams([[duplicate, second], [first]]),
    );
    expect(mergeEventStreams([[first], [second, duplicate]])).toHaveLength(2);
    expect(() =>
      mergeEventStreams([[first], [event({ eventId: "b", payload: { changed: true } })]]),
    ).toThrow(EventLogConflictError);
  });

  it("rejects malformed unterminated input but recovers it on explicit recovery", () => {
    const options = logOptions();
    const writer = new EventLogWriter(options);
    writer.recover();
    writeFileSync(writer.filePath, "{not-json");
    expect(() => writer.read()).toThrow();
    expect(writer.recover()).toMatchObject({ recovered: true });
    expect(writer.read()).toEqual([]);
  });

  it("recovers a complete record that lost only its final newline", () => {
    const options = logOptions();
    const writer = new EventLogWriter(options);
    writer.recover();
    writeFileSync(writer.filePath, JSON.stringify(event()));
    expect(writer.read()).toHaveLength(1);
    expect(writer.recover()).toMatchObject({ recovered: true, discardedBytes: 0 });
    expect(writer.read()).toHaveLength(1);
  });

  it("recovers a torn append before the next atomic append", () => {
    const options = logOptions();
    const writer = new EventLogWriter(options);
    writer.append(event({ eventId: "first" }));
    appendFileSync(writer.filePath, '{"schemaVersion":1,"eventId":"torn"');
    expect(writer.recover().recovered).toBe(true);
    writer.append(event({ eventId: "second", occurredAt: "2025-01-02T00:00:00.000Z" }));
    expect(writer.read().map(({ eventId }) => eventId)).toEqual(["first", "second"]);
    expect(readFileSync(writer.filePath, "utf8").endsWith("\n")).toBe(true);
  });

  it.each([
    ["favorite.created", "favorite", {}],
    ["issue.updated", "issue", { apiKeyHash: "sha256:secret" }],
    ["issue.updated", "issue", { webhookSecret: "secret" }],
    ["inbox.receipt.created", "inbox", {}],
    ["issue.updated", "issue", { inboxReceipt: { id: "receipt-1" } }],
  ])("excludes sensitive or out-of-scope event data", (type, aggregate, payload) => {
    expect(() =>
      new EventLogWriter(logOptions()).append(event({ type, aggregate, payload })),
    ).toThrow(EventLogValidationError);
  });
});
