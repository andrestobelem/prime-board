import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const CURRENT_EVENT_SCHEMA_VERSION = 1;
export const EVENT_LOG_RELATIVE_PATH = join(".prime-board", "log", "events.jsonl");

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type EventActor = string | JsonObject;

export interface DomainEvent {
  readonly schemaVersion: number;
  readonly eventId: string;
  readonly aggregate: string;
  readonly aggregateKey: string;
  readonly type: string;
  readonly actor: EventActor;
  /** Effective Workspace for scoped events. Legacy events may omit it. */
  readonly workspaceId?: string;
  readonly occurredAt: string;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly payload: JsonObject;
}

export interface EventLogOptions {
  /** Repository root. The default is the current working directory. */
  readonly rootDir?: string;
  /** Absolute or root-relative override. Defaults to .prime-board/log/events.jsonl. */
  readonly filePath?: string;
}

type EventLogLocation = EventLogOptions | string;

export interface AppendResult {
  readonly eventId: string;
  readonly appended: boolean;
}

export interface RecoveryResult {
  readonly recovered: boolean;
  readonly discardedBytes: number;
}

export class EventLogValidationError extends Error {
  readonly code = "EVENT_LOG_INVALID_EVENT";

  constructor(message: string) {
    super(message);
    this.name = "EventLogValidationError";
  }
}

export class EventLogFormatError extends Error {
  readonly code = "EVENT_LOG_INVALID_LINE";
  readonly line: number;

  constructor(line: number, message: string) {
    super(`Invalid event log line ${line}: ${message}`);
    this.name = "EventLogFormatError";
    this.line = line;
  }
}

export class EventLogConflictError extends Error {
  readonly code = "EVENT_LOG_EVENT_ID_CONFLICT";
  readonly eventId: string;

  constructor(eventId: string) {
    super(`Event ID ${eventId} has conflicting event data`);
    this.name = "EventLogConflictError";
    this.eventId = eventId;
  }
}

const ENVELOPE_KEYS = new Set([
  "schemaVersion",
  "eventId",
  "aggregate",
  "aggregateKey",
  "type",
  "actor",
  "workspaceId",
  "occurredAt",
  "causationId",
  "correlationId",
  "payload",
]);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonOwnKeys(value: object, field: string, allowArrayLength = false): void {
  for (const key of Reflect.ownKeys(value)) {
    if (allowArrayLength && key === "length") continue;
    if (typeof key !== "string") {
      throw new EventLogValidationError(`${field} must not contain symbol keys`);
    }
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f\r\n]/u.test(value)
  ) {
    throw new EventLogValidationError(`${field} must be a non-empty safe string`);
  }
}

function assertJsonValue(
  value: unknown,
  field: string,
  ancestors: Set<object>,
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new EventLogValidationError(`${field} must contain finite JSON numbers`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new EventLogValidationError(`${field} must contain JSON values only`);
  }
  if (ancestors.has(value)) {
    throw new EventLogValidationError(`${field} must not contain circular data`);
  }
  ancestors.add(value);
  assertJsonOwnKeys(value, field, Array.isArray(value));
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!hasOwn(value, String(index))) {
        throw new EventLogValidationError(`${field} must not contain sparse arrays`);
      }
      assertJsonValue(value[index], `${field}[${index}]`, ancestors);
    }
  } else {
    if (!isPlainObject(value)) {
      throw new EventLogValidationError(`${field} must contain plain JSON objects only`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (isForbiddenKey(key)) {
        throw new EventLogValidationError(`${field}.${key} is not allowed in the event log`);
      }
      assertJsonValue(item, `${field}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function isForbiddenKey(key: string): boolean {
  const compact = normalized(key);
  return (
    compact.includes("secret") ||
    compact.includes("password") ||
    compact.includes("credential") ||
    compact.includes("privatekey") ||
    compact.includes("apikey") ||
    compact.includes("apikeyhash") ||
    compact.includes("apikeyhashed") ||
    compact.includes("hashedapikey") ||
    (compact.includes("webhook") && compact.includes("secret")) ||
    compact === "token" ||
    compact === "accesstoken" ||
    compact === "refreshtoken" ||
    compact === "authorization" ||
    compact.includes("favorite") ||
    compact === "inbox" ||
    (compact.includes("inbox") && compact.includes("receipt"))
  );
}

function isExcludedEvent(aggregate: string, type: string): boolean {
  const aggregateName = normalized(aggregate);
  const typeName = normalized(type);
  return (
    aggregateName === "favorite" ||
    aggregateName === "favorites" ||
    aggregateName === "inboxreceipt" ||
    aggregateName === "inboxreceipts" ||
    aggregateName.includes("apikey") ||
    aggregateName.includes("webhooksecret") ||
    aggregateName.includes("secret") ||
    typeName.includes("favorite") ||
    (typeName.includes("inbox") && typeName.includes("receipt")) ||
    (aggregateName === "inbox" && typeName.includes("receipt")) ||
    typeName.includes("apikey") ||
    typeName.includes("webhooksecret") ||
    typeName.includes("secret")
  );
}

function assertIsoDate(value: unknown): asserts value is string {
  assertString(value, "occurredAt");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !/T/iu.test(value)) {
    throw new EventLogValidationError("occurredAt must be an ISO date-time");
  }
}

/**
 * Validate and return a detached DomainEvent. Validation is deliberately strict:
 * an unknown envelope field or a non-JSON value is rejected instead of being
 * silently dropped. Sensitive projections are not part of this stream.
 */
export function validateDomainEvent(input: unknown): DomainEvent {
  if (!isPlainObject(input)) {
    throw new EventLogValidationError("event must be a plain object");
  }
  assertJsonOwnKeys(input, "event");
  for (const key of Object.keys(input)) {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new EventLogValidationError(`unknown event field: ${key}`);
    }
  }
  for (const key of [
    "schemaVersion",
    "eventId",
    "aggregate",
    "aggregateKey",
    "type",
    "actor",
    "occurredAt",
    "payload",
  ]) {
    if (!hasOwn(input, key)) {
      throw new EventLogValidationError(`missing event field: ${key}`);
    }
  }

  if (input.schemaVersion !== CURRENT_EVENT_SCHEMA_VERSION) {
    throw new EventLogValidationError(`schemaVersion must be ${CURRENT_EVENT_SCHEMA_VERSION}`);
  }
  assertString(input.eventId, "eventId");
  assertString(input.aggregate, "aggregate");
  assertString(input.aggregateKey, "aggregateKey");
  assertString(input.type, "type");
  if (hasOwn(input, "workspaceId")) assertString(input.workspaceId, "workspaceId");
  assertIsoDate(input.occurredAt);
  if (isExcludedEvent(input.aggregate, input.type)) {
    throw new EventLogValidationError("Favorites and Inbox receipts are not event-log data");
  }

  if (typeof input.actor !== "string" && !isPlainObject(input.actor)) {
    throw new EventLogValidationError("actor must be a string or plain JSON object");
  }
  assertJsonValue(input.actor, "actor", new Set());
  if (hasOwn(input, "causationId")) {
    assertString(input.causationId, "causationId");
  }
  if (hasOwn(input, "correlationId")) {
    assertString(input.correlationId, "correlationId");
  }
  if (!isPlainObject(input.payload)) {
    throw new EventLogValidationError("payload must be a plain JSON object");
  }
  assertJsonValue(input.payload, "payload", new Set());

  return structuredClone(input) as unknown as DomainEvent;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}

export function serializeDomainEvent(event: DomainEvent): string {
  const validated = validateDomainEvent(event);
  return `${canonicalJson(validated as unknown as JsonValue)}\n`;
}

/**
 * Compare event data across the Workspace-scope migration.
 *
 * A missing workspaceId is the explicit legacy representation. It is
 * compatible with a scoped copy when all other event data is equal. Two
 * scoped copies still need the same workspaceId, so a real scope or payload
 * change remains a conflict.
 */
export function areDomainEventsEquivalent(left: DomainEvent, right: DomainEvent): boolean {
  const { workspaceId: _leftWorkspaceId, ...leftWithoutWorkspace } = left;
  const { workspaceId: _rightWorkspaceId, ...rightWithoutWorkspace } = right;
  if (
    canonicalJson(leftWithoutWorkspace as unknown as JsonValue) !==
    canonicalJson(rightWithoutWorkspace as unknown as JsonValue)
  ) {
    return false;
  }
  return (
    left.workspaceId === undefined ||
    right.workspaceId === undefined ||
    left.workspaceId === right.workspaceId
  );
}

function compareEvents(left: DomainEvent, right: DomainEvent): number {
  const leftTime = Date.parse(left.occurredAt);
  const rightTime = Date.parse(right.occurredAt);
  return (
    leftTime - rightTime ||
    compareStrings(left.occurredAt, right.occurredAt) ||
    compareStrings(left.eventId, right.eventId)
  );
}

function ensureDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
}

function resolveLogPath(options: EventLogLocation = {}): string {
  const normalizedOptions = typeof options === "string" ? { rootDir: options } : options;
  const rootDir = normalizedOptions.rootDir ?? process.cwd();
  const configured = normalizedOptions.filePath ?? EVENT_LOG_RELATIVE_PATH;
  return configured.startsWith("/") ? configured : join(rootDir, configured);
}

function readRawLines(filePath: string): { lines: string[] } {
  if (!existsSync(filePath)) {
    return { lines: [] };
  }
  const raw = readFileSync(filePath, "utf8");
  if (raw.length === 0) {
    return { lines: [] };
  }
  const hasFinalNewline = raw.endsWith("\n");
  const parts = raw.split("\n");
  if (hasFinalNewline) {
    parts.pop();
  }
  return { lines: parts };
}

function recoverPartialTail(filePath: string): RecoveryResult {
  if (!existsSync(filePath)) {
    return { recovered: false, discardedBytes: 0 };
  }
  const raw = readFileSync(filePath);
  if (raw.length === 0 || raw.at(-1) === 10) {
    return { recovered: false, discardedBytes: 0 };
  }

  const lastNewline = raw.lastIndexOf(10);
  const retainedBytes = lastNewline + 1;
  const fragment = raw.subarray(retainedBytes).toString("utf8");
  try {
    // A complete record without its final newline is safe to repair. A
    // malformed fragment is treated as a torn write and removed below.
    validateDomainEvent(JSON.parse(fragment));
    const fd = openSync(filePath, constants.O_APPEND | constants.O_WRONLY);
    try {
      writeSync(fd, "\n", undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { recovered: true, discardedBytes: 0 };
  } catch {
    const discardedBytes = raw.byteLength - retainedBytes;
    truncateSync(filePath, retainedBytes);
    return { recovered: true, discardedBytes };
  }
}

function parseLog(filePath: string): DomainEvent[] {
  const { lines } = readRawLines(filePath);
  const byId = new Map<string, DomainEvent>();
  lines.forEach((line, index) => {
    if (line.trim().length === 0) {
      throw new EventLogFormatError(index + 1, "line is empty");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new EventLogFormatError(index + 1, "line is not valid JSON");
    }
    let event: DomainEvent;
    try {
      event = validateDomainEvent(parsed);
    } catch (error) {
      throw new EventLogFormatError(
        index + 1,
        error instanceof Error ? error.message : String(error),
      );
    }
    const existing = byId.get(event.eventId);
    if (existing) {
      if (!areDomainEventsEquivalent(existing, event)) {
        throw new EventLogConflictError(event.eventId);
      }
      return;
    }
    byId.set(event.eventId, event);
  });
  return [...byId.values()].sort(compareEvents);
}

/**
 * Append-only, local event-log writer. It never rewrites complete records.
 * RepoSync remains an explicit caller boundary in this slice: this writer does
 * not trigger repository exports or mutate API/SQLite/PostgreSQL state.
 */
export class EventLogWriter {
  readonly filePath: string;

  constructor(options: EventLogLocation = {}) {
    this.filePath = resolveLogPath(options);
  }

  recover(): RecoveryResult {
    ensureDirectory(this.filePath);
    return recoverPartialTail(this.filePath);
  }

  read(): DomainEvent[] {
    return parseLog(this.filePath);
  }

  append(eventInput: unknown): AppendResult {
    return this.appendMany([eventInput])[0]!;
  }

  appendMany(eventInputs: readonly unknown[]): AppendResult[] {
    const events = eventInputs.map(validateDomainEvent);
    if (events.length === 0) return [];

    const eventsById = new Map<string, DomainEvent>();
    for (const event of events) {
      const existing = eventsById.get(event.eventId);
      if (existing && !areDomainEventsEquivalent(existing, event)) {
        throw new EventLogConflictError(event.eventId);
      }
      eventsById.set(event.eventId, event);
    }

    ensureDirectory(this.filePath);
    // A torn final write is the only recoverable corruption. Complete lines
    // remain immutable and malformed complete lines still fail closed in read().
    this.recover();
    const existingEvents = new Map(this.read().map((event) => [event.eventId, event]));
    const results: AppendResult[] = [];
    const lines: string[] = [];

    for (const event of events) {
      const existing = existingEvents.get(event.eventId);
      if (existing) {
        if (!areDomainEventsEquivalent(existing, event)) {
          throw new EventLogConflictError(event.eventId);
        }
        results.push({ eventId: event.eventId, appended: false });
        continue;
      }

      lines.push(serializeDomainEvent(event));
      existingEvents.set(event.eventId, event);
      results.push({ eventId: event.eventId, appended: true });
    }

    if (lines.length === 0) return results;
    const fd = openSync(
      this.filePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
      0o600,
    );
    try {
      for (const line of lines) writeSync(fd, line, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return results;
  }
}

export class EventLogReader {
  readonly filePath: string;

  constructor(options: EventLogLocation = {}) {
    this.filePath = resolveLogPath(options);
  }

  read(): DomainEvent[] {
    return parseLog(this.filePath);
  }
}

export function readEventLog(options: EventLogLocation = {}): DomainEvent[] {
  return new EventLogReader(options).read();
}

export function appendEvent(event: unknown, options: EventLogLocation = {}): AppendResult {
  return new EventLogWriter(options).append(event);
}

/**
 * Merge event streams as a set of event IDs, then order the union by
 * (occurredAt, eventId). Conflicting data for one ID is rejected. This makes
 * both the result and the failure independent of input stream order.
 */
export function mergeEventStreams(...inputs: readonly unknown[]): DomainEvent[] {
  const streams: readonly (readonly unknown[])[] =
    inputs.length === 1 &&
    Array.isArray(inputs[0]) &&
    (inputs[0] as readonly unknown[]).every(Array.isArray)
      ? (inputs[0] as readonly (readonly unknown[])[])
      : inputs.length > 0 && inputs.every(Array.isArray)
        ? (inputs as readonly (readonly unknown[])[])
        : [inputs];
  const byId = new Map<string, DomainEvent>();
  for (const stream of streams) {
    for (const input of stream) {
      const event = validateDomainEvent(input);
      const existing = byId.get(event.eventId);
      if (existing) {
        if (!areDomainEventsEquivalent(existing, event)) {
          throw new EventLogConflictError(event.eventId);
        }
        continue;
      }
      byId.set(event.eventId, event);
    }
  }
  return [...byId.values()].sort(compareEvents);
}

export const mergeEventLogs = mergeEventStreams;
