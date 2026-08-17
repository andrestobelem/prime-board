// pb initiative list|view|create|update|delete
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";
import { readBody, resolveTeam } from "../resolve.ts";

const INITIATIVE_FIELDS = `id name description state targetDate archivedAt progress completedIssues totalIssues
  createdAt updatedAt owner { id name type } projects { id name } teams { id key name }`;
const USAGE = `Usage:
  pb initiative list [--include-archived] [--json]
  pb initiative view <ID> [--json]
  pb initiative create --name TEXT [--description TEXT|-] [--state STATE]
                       [--target-date DATE] [--project ID ...] [--team KEY ...] [--json]
  pb initiative update <ID> [--name TEXT] [--description TEXT|-] [--state STATE]
                       [--target-date DATE] [--archived true|false] [--project ID ...] [--team KEY ...] [--json]
  pb initiative delete <ID> [--json]`;

async function teamIds(
  config: Awaited<ReturnType<typeof loadConfig>>,
  keys?: string[],
): Promise<string[] | undefined> {
  return keys
    ? Promise.all(keys.map(async (key) => (await resolveTeam(config, key)).id))
    : undefined;
}

export async function initiativeCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();
  if (action === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { "include-archived": { type: "boolean" }, json: { type: "boolean" } },
    });
    const data = await gqlRequest(
      config,
      `query($includeArchived: Boolean) { initiatives(includeArchived: $includeArchived) { ${INITIATIVE_FIELDS} } }`,
      { includeArchived: Boolean(values["include-archived"]) },
    );
    if (values.json) return printJson(data.initiatives);
    for (const initiative of data.initiatives)
      console.log(`${initiative.id}  [${initiative.state.toLowerCase()}]  ${initiative.name}`);
    if (data.initiatives.length === 0) console.log("No initiatives found.");
    return;
  }
  if (action === "view") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `query($id: ID!) { initiative(id: $id) { ${INITIATIVE_FIELDS} } }`,
      { id },
    );
    if (!data.initiative) throw new UsageError(`Initiative not found: ${id}`);
    if (values.json) return printJson(data.initiative);
    console.log(`${data.initiative.name}  [${data.initiative.state.toLowerCase()}]`);
    return;
  }
  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        name: { type: "string" },
        description: { type: "string" },
        state: { type: "string" },
        "target-date": { type: "string" },
        project: { type: "string", multiple: true },
        team: { type: "string", multiple: true },
        json: { type: "boolean" },
      },
    });
    if (!values.name) throw new UsageError(USAGE);
    const input: Record<string, unknown> = { name: values.name };
    if (values.description !== undefined) input.description = await readBody(values.description);
    if (values.state) input.state = values.state.toUpperCase();
    if (values["target-date"]) input.targetDate = values["target-date"];
    if (values.project?.length) input.projectIds = values.project;
    if (values.team?.length) input.teamIds = await teamIds(config, values.team);
    const data = await gqlRequest(
      config,
      `mutation($input: InitiativeCreateInput!) { initiativeCreate(input: $input) { initiative { ${INITIATIVE_FIELDS} } } }`,
      { input },
    );
    if (values.json) return printJson(data.initiativeCreate.initiative);
    console.log(
      `Created initiative: ${data.initiativeCreate.initiative.name} (${data.initiativeCreate.initiative.id})`,
    );
    return;
  }
  if (action === "update") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        name: { type: "string" },
        description: { type: "string" },
        state: { type: "string" },
        "target-date": { type: "string" },
        archived: { type: "string" },
        project: { type: "string", multiple: true },
        team: { type: "string", multiple: true },
        json: { type: "boolean" },
      },
    });
    const input: Record<string, unknown> = {};
    if (values.name !== undefined) input.name = values.name;
    if (values.description !== undefined) input.description = await readBody(values.description);
    if (values.state !== undefined) input.state = values.state.toUpperCase();
    if (values["target-date"] !== undefined) input.targetDate = values["target-date"];
    if (values.archived !== undefined) input.archived = values.archived === "true";
    if (values.project) input.projectIds = values.project;
    if (values.team) input.teamIds = await teamIds(config, values.team);
    if (!Object.keys(input).length) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $input: InitiativeUpdateInput!) { initiativeUpdate(id: $id, input: $input) { initiative { ${INITIATIVE_FIELDS} } } }`,
      { id, input },
    );
    if (values.json) return printJson(data.initiativeUpdate.initiative);
    console.log(`Updated initiative ${id}`);
    return;
  }
  if (action === "delete") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { initiativeDelete(id: $id) { success } }`,
      { id },
    );
    if (values.json) return printJson(data.initiativeDelete);
    console.log(`Deleted initiative ${id}`);
    return;
  }
  throw new UsageError(USAGE);
}
