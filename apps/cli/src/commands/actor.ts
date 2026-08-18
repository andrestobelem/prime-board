// pb actor list|create|update
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";

const ACTOR_FIELDS = `id name email type workspaceRole createdAt`;
const USAGE = `Usage:
  pb actor list [--type human|agent] [--json]
  pb actor create --name TEXT --type human|agent [--email EMAIL] [--json]
  pb actor update <ID> [--name TEXT] [--email EMAIL] [--json]`;

export async function actorCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();
  if (action === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { type: { type: "string" }, json: { type: "boolean" } },
    });
    const data = await gqlRequest(
      config,
      `query($type: ActorType) { actors(type: $type) { ${ACTOR_FIELDS} } }`,
      {
        type: values.type ? values.type.toUpperCase() : null,
      },
    );
    if (values.json) return printJson(data.actors);
    for (const actor of data.actors)
      console.log(`${actor.id}  [${actor.type.toLowerCase()}]  ${actor.name}`);
    if (data.actors.length === 0) console.log("No actors found.");
    return;
  }
  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        name: { type: "string" },
        type: { type: "string" },
        email: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.name || !values.type) throw new UsageError(USAGE);
    const input: Record<string, unknown> = { name: values.name, type: values.type.toUpperCase() };
    if (values.email !== undefined) input.email = values.email;
    const data = await gqlRequest(
      config,
      `mutation($input: ActorCreateInput!) {
      actorCreate(input: $input) { actor { ${ACTOR_FIELDS} } }
    }`,
      { input },
    );
    if (values.json) return printJson(data.actorCreate.actor);
    console.log(`Created actor: ${data.actorCreate.actor.name} (${data.actorCreate.actor.id})`);
    return;
  }
  if (action === "update") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: { name: { type: "string" }, email: { type: "string" }, json: { type: "boolean" } },
    });
    const input: Record<string, unknown> = {};
    if (values.name !== undefined) input.name = values.name;
    if (values.email !== undefined) input.email = values.email;
    if (!Object.keys(input).length) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $input: ActorUpdateInput!) {
      actorUpdate(id: $id, input: $input) { actor { ${ACTOR_FIELDS} } }
    }`,
      { id, input },
    );
    if (values.json) return printJson(data.actorUpdate.actor);
    console.log(`Updated actor ${id}`);
    return;
  }
  throw new UsageError(USAGE);
}
