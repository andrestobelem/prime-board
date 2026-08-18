// pb workspace view|update
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";

const WORKSPACE_FIELDS = "id name urlKey createdAt";
const USAGE = `Usage:
  pb workspace view [--json]
  pb workspace update --name TEXT [--json]`;

export async function workspaceCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();

  if (action === "view" || action === "get") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { json: { type: "boolean" } },
    });
    const data = await gqlRequest(config, `{ workspace { ${WORKSPACE_FIELDS} } }`);
    if (values.json) return printJson(data.workspace);
    console.log(`${data.workspace.name} (${data.workspace.urlKey})`);
    return;
  }

  if (action === "update") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { name: { type: "string" }, json: { type: "boolean" } },
    });
    if (values.name === undefined || !values.name.trim()) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($input: WorkspaceUpdateInput!) {
        workspaceUpdate(input: $input) { success workspace { ${WORKSPACE_FIELDS} } }
      }`,
      { input: { name: values.name } },
    );
    if (values.json) return printJson(data.workspaceUpdate.workspace);
    console.log(`Updated workspace: ${data.workspaceUpdate.workspace.name}`);
    return;
  }

  throw new UsageError(USAGE);
}
