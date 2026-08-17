// pb favorite list|create|delete|reorder
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";

const FAVORITE_FIELDS = `id position
  project { id name archivedAt }
  savedView { id name scope archivedAt }`;
const USAGE = `Usage:
  pb favorite list [--json]
  pb favorite create (--project ID | --view ID) [--json]
  pb favorite delete <ID> [--json]
  pb favorite reorder <ID> --position N [--json]`;

function position(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`Invalid position: ${value}`);
  return parsed;
}

export async function favoriteCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();
  if (action === "list") {
    const { values } = parseArgs({ args: argv.slice(1), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(config, `{ favorites { ${FAVORITE_FIELDS} } }`);
    if (values.json) return printJson(data.favorites);
    for (const favorite of data.favorites) {
      const resource = favorite.project ?? favorite.savedView;
      console.log(`${favorite.id}  ${favorite.position}  ${resource?.name ?? favorite.id}`);
    }
    return;
  }
  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { project: { type: "string" }, view: { type: "string" }, json: { type: "boolean" } },
    });
    if ((values.project ? 1 : 0) + (values.view ? 1 : 0) !== 1) throw new UsageError(USAGE);
    const input = values.project ? { projectId: values.project } : { savedViewId: values.view };
    const data = await gqlRequest(
      config,
      `mutation($input: FavoriteCreateInput!) { favoriteCreate(input: $input) { favorite { ${FAVORITE_FIELDS} } } }`,
      { input },
    );
    if (values.json) return printJson(data.favoriteCreate.favorite);
    console.log(`Created favorite ${data.favoriteCreate.favorite.id}`);
    return;
  }
  if (action === "delete") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { favoriteDelete(id: $id) { success } }`,
      { id },
    );
    if (values.json) return printJson(data.favoriteDelete);
    console.log(`Deleted favorite ${id}`);
    return;
  }
  if (action === "reorder") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: { position: { type: "string" }, json: { type: "boolean" } },
    });
    if (values.position === undefined) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $position: Int!) { favoriteReorder(id: $id, position: $position) { favorite { ${FAVORITE_FIELDS} } } }`,
      { id, position: position(values.position) },
    );
    if (values.json) return printJson(data.favoriteReorder.favorite);
    console.log(`Reordered favorite ${id}`);
    return;
  }
  throw new UsageError(USAGE);
}
