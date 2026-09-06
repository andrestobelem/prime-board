import { createHash } from "node:crypto";
import type { Persistence } from "../db/persistence.ts";
import { now } from "../db/util.ts";
import {
  EventLogWriter,
  type DomainEvent,
  type EventLogOptions,
  validateDomainEvent,
} from "./event-log.ts";
import {
  createGitCommitter,
  withCanonicalEventLogLock,
  type CanonicalEventLog,
  type GitCommitter,
  type IssueEventProjector,
} from "./issue-event-pipeline.ts";
import { applyCanonicalEvent } from "./postgres-projector.ts";
import {
  regenerateCanonicalProjections,
  type RegenerateCanonicalProjectionsResult,
} from "./canonical-projection.ts";
import {
  replayPostgresEvents,
  type AsyncReplayResult,
  type ProjectorCheckpoint,
  type ProjectorCheckpointStore,
} from "./projector.ts";
import type { WebhookEventName } from "../webhooks/events.ts";

export interface CanonicalActor {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

export interface CanonicalWebhookEventInput {
  readonly workspaceId: string;
  readonly event: WebhookEventName;
  readonly actor: CanonicalActor;
  readonly data: Record<string, unknown>;
  readonly changes?: Record<string, { from: unknown; to: unknown }>;
}

export interface CanonicalMutationInput {
  readonly workspaceId: string;
  readonly actor: CanonicalActor;
  readonly name: string;
  readonly args: unknown;
  readonly result: unknown;
}

export interface CanonicalEventRecorder {
  recordEvent(event: DomainEvent): void;
  recordWebhookEvent(input: CanonicalWebhookEventInput): void;
  recordMutation(input: CanonicalMutationInput): void;
}

export interface PostgresRepoSyncOptions extends EventLogOptions {
  readonly rootDir: string;
  readonly persistence: Persistence;
  readonly stream?: string;
  readonly eventLog?: CanonicalEventLog;
  readonly commitGit?: GitCommitter;
  readonly checkpointStore?: ProjectorCheckpointStore;
  /** Permite probar el seam sin ejecutar el reducer SQL por defecto. */
  readonly projector?: IssueEventProjector;
  readonly regenerate?: boolean;
}

export interface PostgresProjectionStatus {
  readonly result: AsyncReplayResult | undefined;
  readonly projection: RegenerateCanonicalProjectionsResult | undefined;
  readonly error: unknown;
  readonly pendingEventIds: readonly string[];
}

const DEFAULT_STREAM = "canonical";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function clonePublic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clonePublic);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) => !key.startsWith("_") && !/secret|password|token|credential|apikey/i.test(key),
      )
      .map(([key, item]) => [key, clonePublic(item)]),
  );
}

function publicRecord(value: unknown): Record<string, unknown> {
  const clean = clonePublic(value);
  return isRecord(clean) ? clean : {};
}

function eventKey(input: CanonicalWebhookEventInput): { aggregate: string; aggregateKey: string } {
  const { event, data } = input;
  const prefix = event.slice(0, event.indexOf("."));
  // Project update mutations reuse the public project.updated webhook. Keep
  // the durable row in its own aggregate so replay can rebuild project_updates.
  const aggregate =
    event === "project.updated" && stringValue(data.updateId)
      ? "project_update"
      : prefix === "comment"
        ? "comment"
        : prefix || "workspace";
  const key =
    (aggregate === "project_update" ? stringValue(data.updateId) : null) ??
    stringValue(data.identifier) ??
    stringValue(data.id) ??
    stringValue(data.issueId) ??
    stringValue(data.projectId) ??
    input.workspaceId;
  return { aggregate, aggregateKey: key ?? input.workspaceId };
}

function occurredAt(data: Record<string, unknown>): string {
  return stringValue(data.updatedAt) ?? stringValue(data.createdAt) ?? now();
}

function stableEventId(prefix: string, aggregate: string, key: string, timestamp: string): string {
  return `${prefix}:${aggregate}:${key}:${timestamp}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Construye el envelope público sin copiar campos internos del dispatcher. */
export function canonicalEventFromWebhook(input: CanonicalWebhookEventInput): DomainEvent {
  const { aggregate, aggregateKey } = eventKey(input);
  const payload = publicRecord(input.data);
  if (aggregate === "project_update") {
    payload.id = aggregateKey;
    payload.projectId =
      stringValue(input.data.id) ?? stringValue(input.data.projectId) ?? input.workspaceId;
  }
  if (input.changes && Object.keys(input.changes).length > 0)
    payload.changes = publicRecord(input.changes);
  const timestamp = occurredAt(input.data);
  const type = aggregate === "project_update" ? "project_update.created" : input.event;
  return validateDomainEvent({
    schemaVersion: 1,
    eventId: stableEventId("webhook", aggregate, aggregateKey, timestamp),
    aggregate,
    aggregateKey,
    type,
    actor: publicRecord(input.actor),
    workspaceId: input.workspaceId,
    occurredAt: timestamp,
    payload,
  });
}

interface MutationDescriptor {
  readonly aggregate: string;
  readonly type: string;
  readonly target: Record<string, unknown>;
  readonly key: string;
  readonly occurredAt: string;
}

function mutationParts(name: string): { aggregate: string; action: string } {
  const values: Array<[string, string]> = [
    ["workspace", "workspace"],
    ["teamMembership", "team_membership"],
    ["workflowState", "workflow_state"],
    ["savedView", "saved_view"],
    ["projectUpdate", "project_update"],
    ["actorInvitation", "actor_invitation"],
    ["apiKey", "api_key"],
    ["webhook", "webhook"],
    ["favorite", "favorite"],
    ["inbox", "inbox"],
    ["initiative", "initiative"],
    ["milestone", "milestone"],
    ["project", "project"],
    ["cycle", "cycle"],
    ["review", "review"],
    ["label", "label"],
    ["team", "team"],
    ["actor", "actor"],
    ["issue", "issue"],
    ["comment", "comment"],
  ];
  const match = values.find(([prefix]) => name.startsWith(prefix));
  const aggregate = match?.[1] ?? "mutation";
  const prefix = match?.[0] ?? "";
  const suffix = name.slice(prefix.length);
  const action =
    suffix === "Create"
      ? "created"
      : suffix === "Delete"
        ? "deleted"
        : suffix === "Archive"
          ? "archived"
          : suffix === "Unarchive"
            ? "unarchived"
            : "updated";
  return { aggregate, action };
}

function mutationInput(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return {};
  const input = args.input;
  return isRecord(input) ? publicRecord(input) : publicRecord(args);
}

function mutationTarget(result: unknown, args: unknown): Record<string, unknown> {
  if (isRecord(result)) {
    for (const [key, value] of Object.entries(result)) {
      if (key === "success" || key === "movedIssues" || key === "orphanedIssues") continue;
      if (isRecord(value)) return publicRecord(value);
    }
  }
  return mutationInput(args);
}

function mutationDescriptor(input: CanonicalMutationInput): MutationDescriptor {
  const { aggregate, action } = mutationParts(input.name);
  const target = mutationTarget(input.result, input.args);
  const args = isRecord(input.args) ? input.args : {};
  const argsInput = isRecord(args.input) ? args.input : {};
  const key =
    stringValue(target.id) ??
    stringValue(target.identifier) ??
    stringValue(args.id) ??
    stringValue(argsInput.id) ??
    `${input.name}:${input.actor.id}`;
  const timestamp =
    stringValue(target.updatedAt) ?? stringValue(target.createdAt) ?? input.workspaceId;
  return { aggregate, type: `${aggregate}.${action}`, target, key, occurredAt: timestamp };
}

/** Crea un evento para mutaciones que no tienen un webhook Activity explícito. */
export function canonicalEventFromMutation(input: CanonicalMutationInput): DomainEvent | undefined {
  const { aggregate, type, target, key, occurredAt } = mutationDescriptor(input);
  // El estado personal y el material sensible no son Repository Source.
  if (
    ["favorite", "inbox", "api_key", "webhook", "actor_invitation", "mutation"].includes(
      aggregate,
    ) ||
    input.name === "cycleCarryOver"
  ) {
    return undefined;
  }
  const payload = { ...target, ...mutationInput(input.args) };
  const digest = createHash("sha256")
    .update(stableJson({ aggregate, key, type, payload }))
    .digest("hex")
    .slice(0, 32);
  return validateDomainEvent({
    schemaVersion: 1,
    eventId: `mutation:${aggregate}:${key}:${digest}`,
    aggregate,
    aggregateKey: key,
    type,
    actor: publicRecord(input.actor),
    workspaceId: input.workspaceId,
    occurredAt:
      stringValue(target.updatedAt) ??
      stringValue(target.archivedAt) ??
      stringValue(target.createdAt) ??
      "1970-01-01T00:00:00.000Z",
    payload,
  });
}

/** RepoSync del backend PostgreSQL. El archivo y Git son la autoridad; PG es un índice. */
export class PostgresRepoSync implements CanonicalEventRecorder {
  readonly root: string;
  readonly eventLog: CanonicalEventLog;
  private readonly stream: string;
  private readonly persistence: Persistence;
  private readonly commitGit: GitCommitter;
  private readonly checkpointStore: ProjectorCheckpointStore | undefined;
  private readonly customProjector: IssueEventProjector | undefined;
  private readonly regenerate: boolean;
  private readonly pending = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private lastResult: AsyncReplayResult | undefined;
  private lastProjection: RegenerateCanonicalProjectionsResult | undefined;
  private lastError: unknown;

  constructor(options: PostgresRepoSyncOptions) {
    this.root = options.rootDir;
    this.stream = options.stream ?? DEFAULT_STREAM;
    this.persistence = options.persistence;
    this.eventLog =
      options.eventLog ?? new EventLogWriter({ rootDir: this.root, filePath: options.filePath });
    this.commitGit = options.commitGit ?? createGitCommitter(this.root);
    this.checkpointStore = options.checkpointStore;
    this.customProjector = options.projector;
    this.regenerate = options.regenerate !== false;
  }

  recordEvent(eventInput: DomainEvent): void {
    const event = validateDomainEvent(eventInput);
    withCanonicalEventLogLock(this.root, () => {
      const result = this.eventLog.appendMany([event]);
      this.pending.add(result[0]!.eventId);
    });
  }

  append(event: DomainEvent): void {
    this.recordEvent(event);
  }

  recordWebhookEvent(input: CanonicalWebhookEventInput): void {
    this.recordEvent(canonicalEventFromWebhook(input));
  }

  recordMutation(input: CanonicalMutationInput): void {
    const event = canonicalEventFromMutation(input);
    if (event) this.recordEvent(event);
  }

  sync(): Promise<void> {
    const run = this.chain.then(() => this.flush());
    this.chain = run.catch(() => undefined);
    return run;
  }

  syncIssue(_issueId: string): Promise<void> {
    return this.sync();
  }

  getStatus(): PostgresProjectionStatus {
    return {
      result: this.lastResult,
      projection: this.lastProjection,
      error: this.lastError,
      pendingEventIds: [...this.pending],
    };
  }

  status(): PostgresProjectionStatus {
    return this.getStatus();
  }

  getCheckpoint(): ProjectorCheckpoint | undefined {
    return this.lastResult?.checkpoint;
  }

  private async flush(): Promise<void> {
    this.lastError = undefined;
    try {
      const pending = [...this.pending];
      if (pending.length > 0) {
        withCanonicalEventLogLock(this.root, () => {
          this.commitGit({ rootDir: this.root, eventIds: pending });
          const present = new Set(this.eventLog.read().map((event) => event.eventId));
          for (const eventId of pending) if (present.has(eventId)) this.pending.delete(eventId);
        });
      }
      const result = this.customProjector
        ? await replayPostgresEvents(
            async (_tx, event) => {
              this.customProjector!.apply(event);
            },
            {
              rootDir: this.root,
              stream: this.stream,
              persistence: this.persistence,
              checkpointStore: this.checkpointStore,
            },
          )
        : await replayPostgresEvents(applyCanonicalEvent, {
            rootDir: this.root,
            stream: this.stream,
            persistence: this.persistence,
            checkpointStore: this.checkpointStore,
          });
      this.lastResult = result;
      if (result.failed) {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
      }
      if (this.regenerate) {
        this.lastProjection = regenerateCanonicalProjections(this.root);
      }
    } catch (error) {
      this.lastError = error;
      throw error;
    }
  }
}

export function createPostgresRepoSync(
  persistence: Persistence,
  rootDir: string,
  options: Omit<PostgresRepoSyncOptions, "persistence" | "rootDir"> = {},
): PostgresRepoSync {
  return new PostgresRepoSync({ ...options, persistence, rootDir });
}

export const createPostgresCanonicalRepo = createPostgresRepoSync;
