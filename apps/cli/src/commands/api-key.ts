// pb api-key create|delete
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";
import { resolveActor } from "../resolve.ts";

const API_KEY_FIELDS = `id name createdAt lastUsedAt actor { id name type }`;
const USAGE = `Usage:
  pb api-key create --actor ID|NAME|me --name TEXT [--json]
  pb api-key delete <ID> [--json]`;

export async function apiKeyCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();
  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { actor: { type: "string" }, name: { type: "string" }, json: { type: "boolean" } },
    });
    if (!values.actor || !values.name) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($input: ApiKeyCreateInput!) {
      apiKeyCreate(input: $input) { apiKey { ${API_KEY_FIELDS} } key }
    }`,
      { input: { actorId: await resolveActor(config, values.actor), name: values.name } },
    );
    if (values.json) return printJson(data.apiKeyCreate);
    console.log(`Created API key ${data.apiKeyCreate.apiKey.id}`);
    console.log(`Secret (save it now, it will not be shown again): ${data.apiKeyCreate.key}`);
    return;
  }
  if (action === "delete") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { apiKeyDelete(id: $id) { success } }`,
      { id },
    );
    if (values.json) return printJson(data.apiKeyDelete);
    console.log(`Deleted API key ${id}`);
    return;
  }
  throw new UsageError(USAGE);
}
