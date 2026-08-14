// pb team list
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";

export async function teamCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  if (action !== "list") throw new UsageError("Usage: pb team list [--json]");
  const { values } = parseArgs({ args: argv.slice(1), options: { json: { type: "boolean" } } });
  const config = await loadConfig();
  const data = await gqlRequest(config, `{
    teams { id key name description states { name type } }
  }`);
  if (values.json) return printJson(data.teams);
  for (const team of data.teams) {
    console.log(`${team.key}  ${team.name}  (${team.states.length} states)`);
  }
  return;
}
