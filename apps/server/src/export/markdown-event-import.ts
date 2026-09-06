import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  EventLogWriter,
  type DomainEvent,
  type EventLogOptions,
  validateDomainEvent,
} from "./event-log.ts";
import { now } from "../db/util.ts";
import { withCanonicalEventLogLock } from "./issue-event-pipeline.ts";

export interface MarkdownEventImportOptions extends EventLogOptions {
  readonly rootDir: string;
  /** Actor estable que autoriza la importación explícita. */
  readonly actor: string;
  readonly occurredAt?: string;
  readonly dryRun?: boolean;
  readonly eventLog?: EventLogWriter;
  readonly commit?: (eventIds: readonly string[]) => void;
}

export interface MarkdownEventImportResult {
  readonly status: "completed";
  readonly scanned: number;
  readonly emitted: number;
  readonly duplicates: number;
  readonly warnings: readonly string[];
  readonly events: readonly DomainEvent[];
}

interface ParsedMarkdown {
  readonly identifier: string;
  readonly metadata: Record<string, unknown>;
  readonly description: string | null;
  readonly source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseIssueMarkdown(path: string): ParsedMarkdown {
  const source = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(source);
  if (!match) throw new Error(`Invalid issue file (missing front matter): ${path}`);
  const parsed: unknown = parseYaml(match[1]!);
  if (!isRecord(parsed)) throw new Error(`Invalid issue front matter: ${path}`);
  const identifier = typeof parsed.id === "string" ? parsed.id.trim() : "";
  if (!identifier) throw new Error(`Issue file is missing id: ${path}`);
  if (!/^[A-Za-z][A-Za-z0-9]{0,7}-\d+$/u.test(identifier)) {
    throw new Error(`Issue file has an invalid id: ${identifier}`);
  }
  const body = match[2]!
    .replace(/^\s*#[^\n]*\n?/u, "")
    .replace(/^\s*Created by .+\.\n?/u, "")
    .trim();
  const metadata: Record<string, unknown> = { ...parsed };
  delete metadata.id;
  metadata.description = body.length > 0 ? body : null;
  return {
    identifier,
    metadata,
    description: body.length > 0 ? body : null,
    source,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function eventId(markdown: ParsedMarkdown): string {
  const digest = createHash("sha256")
    .update(stableJson({ identifier: markdown.identifier, metadata: markdown.metadata }))
    .digest("hex")
    .slice(0, 32);
  return `markdown:${markdown.identifier}:${digest}`;
}

function eventForMarkdown(
  markdown: ParsedMarkdown,
  actor: string,
  fallbackOccurredAt: string | undefined,
): DomainEvent {
  const occurredAt =
    (typeof markdown.metadata.updatedAt === "string" ? markdown.metadata.updatedAt : undefined) ??
    (typeof markdown.metadata.createdAt === "string" ? markdown.metadata.createdAt : undefined) ??
    fallbackOccurredAt ??
    now();
  const payload: Record<string, unknown> = {
    ...markdown.metadata,
    identifier: markdown.identifier,
    title:
      typeof markdown.metadata.title === "string" ? markdown.metadata.title : markdown.identifier,
  };
  return validateDomainEvent({
    schemaVersion: 1,
    eventId: eventId(markdown),
    aggregate: "issue",
    aggregateKey: markdown.identifier,
    type: "issue.created",
    actor,
    occurredAt,
    payload,
  });
}

/** Convierte Markdown en eventos. No abre una DB y no conoce PostgreSQL. */
export function markdownToDomainEvents(
  rootDir: string,
  options: Pick<MarkdownEventImportOptions, "actor" | "occurredAt">,
): DomainEvent[] {
  const issuesDir = join(rootDir, ".prime-board", "issues");
  if (!existsSync(issuesDir)) throw new Error(`No issue directory in ${rootDir}`);
  const files = readdirSync(issuesDir)
    .filter((file) => file.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right));
  return files.map((file) =>
    eventForMarkdown(parseIssueMarkdown(join(issuesDir, file)), options.actor, options.occurredAt),
  );
}

/** Emite los eventos de un import explícito y deja el commit al caller. */
export function importMarkdownEvents(
  options: MarkdownEventImportOptions,
): MarkdownEventImportResult {
  const events = markdownToDomainEvents(options.rootDir, options);
  const writer = options.eventLog ?? new EventLogWriter(options);
  let emitted: DomainEvent[] = [];
  const appendAndCommit = (): void => {
    const existing = new Set(writer.read().map((event) => event.eventId));
    emitted = events.filter((event) => !existing.has(event.eventId));
    if (emitted.length === 0) return;
    writer.appendMany(emitted);
    options.commit?.(emitted.map((event) => event.eventId));
  };
  if (!options.dryRun) {
    withCanonicalEventLogLock(options.rootDir, appendAndCommit);
  } else {
    const existing = new Set(writer.read().map((event) => event.eventId));
    emitted = events.filter((event) => !existing.has(event.eventId));
  }
  return {
    status: "completed",
    scanned: events.length,
    emitted: emitted.length,
    duplicates: events.length - emitted.length,
    warnings: [],
    events,
  };
}

export const importMarkdownToEventLog = importMarkdownEvents;
export const emitMarkdownEvents = importMarkdownEvents;
