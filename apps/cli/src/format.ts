// Salida humana compacta; --json emite JSON estable para agentes.
import { UsageError } from "./errors.ts";

export const PRIORITY_NAMES = ["none", "urgent", "high", "medium", "low"] as const;

export function priorityFromName(name: string): number {
  const index = PRIORITY_NAMES.indexOf(name.toLowerCase() as never);
  if (index === -1) {
    throw new UsageError(`Invalid priority: ${name} (use ${PRIORITY_NAMES.join("|")})`);
  }
  return index;
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function issueLine(issue: any): string {
  const priority = issue.priority > 0 ? ` [${PRIORITY_NAMES[issue.priority]}]` : "";
  const assignee = issue.assignee ? ` @${issue.assignee.name}` : "";
  const labels = issue.labels?.length
    ? ` {${issue.labels.map((label: any) => label.name).join(", ")}}`
    : "";
  return `${issue.identifier}  ${issue.state.name}${priority}  ${issue.title}${assignee}${labels}`;
}
