#!/usr/bin/env bun
// CLI `pb`: cliente de la API GraphQL de prime-board (spec §7).
// Exit codes: 0 ok, 1 error de API, 2 error de uso.
import { APP_VERSION } from "@prime-board/schema";
import { authCommand } from "./commands/auth.ts";
import { issueCommand } from "./commands/issue.ts";
import { projectCommand } from "./commands/project.ts";
import { teamCommand } from "./commands/team.ts";
import { webhookCommand } from "./commands/webhook.ts";
import { viewCommand } from "./commands/view.ts";
import { ApiError, UsageError } from "./errors.ts";

const HELP = `pb ${APP_VERSION} — prime-board CLI

Usage: pb <command> [options]

Commands:
  auth login --url <url> --key <api-key>   Save credentials
  auth status                              Show current viewer
  issue list|view|create|update|comment    Work with issues
  project list|view|create|archive|unarchive|milestone-*|update-*  Work with planning
  view list|create|update|duplicate|delete Saved views
  team list                                List teams
  webhook list|create|delete               Manage webhooks

Run \`pb <command>\` without arguments for detailed usage.
Environment: PRIME_BOARD_URL, PRIME_BOARD_API_KEY override the saved config.`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "auth":
      return authCommand(rest);
    case "issue":
      return issueCommand(rest);
    case "project":
      return projectCommand(rest);
    case "view":
      return viewCommand(rest);
    case "team":
      return teamCommand(rest);
    case "webhook":
      return webhookCommand(rest);
    case "--version":
    case "-v":
      console.log(APP_VERSION);
      return;
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return;
    default:
      throw new UsageError(`Unknown command: ${command}\n\n${HELP}`);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exit(2);
  }
  if (error instanceof ApiError) {
    console.error(`API error${error.code ? ` [${error.code}]` : ""}: ${error.message}`);
    process.exit(1);
  }
  // parseArgs tira TypeError en flags desconocidas → error de uso.
  if (error instanceof TypeError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
