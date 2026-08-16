// pb view list|create|update|delete|duplicate
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";
import { resolveTeam } from "../resolve.ts";

const VIEW_FIELDS = `id name scope orderBy groupBy columns archivedAt
  team { id key } owner { id name } filter`;

const USAGE = `Usage:
  pb view list [--team KEY] [--include-archived] [--json]
  pb view create --name TEXT --scope personal|team|workspace [--team KEY]
                 [--order-by ORDER] [--group-by GROUP] [--json]
  pb view update <ID> [--name TEXT] [--archived true|false] [--json]
  pb view duplicate <ID> [--json]
  pb view delete <ID>`;

export async function viewCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();

  if (action === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        team: { type: "string" },
        "include-archived": { type: "boolean" },
        json: { type: "boolean" },
      },
    });
    const teamId = values.team ? (await resolveTeam(config, values.team)).id : null;
    const data = await gqlRequest(
      config,
      `query($teamId: ID, $includeArchived: Boolean) {
      savedViews(teamId: $teamId, includeArchived: $includeArchived) { ${VIEW_FIELDS} }
    }`,
      { teamId, includeArchived: Boolean(values["include-archived"]) },
    );
    if (values.json) return printJson(data.savedViews);
    for (const view of data.savedViews) {
      const scope = view.scope.toLowerCase();
      const team = view.team ? ` team:${view.team.key}` : "";
      const archived = view.archivedAt ? " [archived]" : "";
      console.log(`${view.id}  [${scope}]${team}${archived}  ${view.name}`);
    }
    if (data.savedViews.length === 0) console.log("No saved views found.");
    return;
  }

  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        name: { type: "string" },
        scope: { type: "string" },
        team: { type: "string" },
        "order-by": { type: "string" },
        "group-by": { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.name || !values.scope) throw new UsageError(USAGE);
    const input: Record<string, unknown> = {
      name: values.name,
      scope: values.scope.toUpperCase(),
      filter: {},
    };
    if (values.team) input.teamId = (await resolveTeam(config, values.team)).id;
    if (values["order-by"]) input.orderBy = values["order-by"].toUpperCase();
    if (values["group-by"]) input.groupBy = values["group-by"];
    const data = await gqlRequest(
      config,
      `mutation($input: SavedViewCreateInput!) {
      savedViewCreate(input: $input) { savedView { ${VIEW_FIELDS} } }
    }`,
      { input },
    );
    if (values.json) return printJson(data.savedViewCreate.savedView);
    const view = data.savedViewCreate.savedView;
    console.log(`Created ${view.id}: ${view.name}`);
    return;
  }

  if (action === "update") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        name: { type: "string" },
        archived: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const input: Record<string, unknown> = {};
    if (values.name) input.name = values.name;
    if (values.archived !== undefined) input.archived = values.archived === "true";
    if (Object.keys(input).length === 0) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $input: SavedViewUpdateInput!) {
      savedViewUpdate(id: $id, input: $input) { savedView { ${VIEW_FIELDS} } }
    }`,
      { id, input },
    );
    if (values.json) return printJson(data.savedViewUpdate.savedView);
    console.log(`Updated ${data.savedViewUpdate.savedView.id}`);
    return;
  }

  if (action === "duplicate") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) {
      savedViewDuplicate(id: $id) { savedView { ${VIEW_FIELDS} } }
    }`,
      { id },
    );
    if (values.json) return printJson(data.savedViewDuplicate.savedView);
    console.log(
      `Duplicated as ${data.savedViewDuplicate.savedView.id}: ${data.savedViewDuplicate.savedView.name}`,
    );
    return;
  }

  if (action === "delete") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    await gqlRequest(config, `mutation($id: ID!) { savedViewDelete(id: $id) { success } }`, { id });
    console.log(`Deleted ${id}`);
    return;
  }

  throw new UsageError(USAGE);
}
