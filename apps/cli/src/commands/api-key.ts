// pb api-key create|list|rotate|delete
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";
import { resolveActor, resolveTeam } from "../resolve.ts";

const API_KEY_FIELDS = `id name createdAt lastUsedAt revokedAt expiresAt scopes teamIds actor { id name type }`;
const USAGE = `Usage:
  pb api-key create --actor ID|NAME|me --name TEXT [--scopes read,write] [--team KEY] [--expires-at ISO] [--json]
  pb api-key list [--actor ID|NAME|me] [--json]
  pb api-key rotate <ID> [--name TEXT] [--scopes read,write] [--team KEY] [--expires-at ISO] [--json]
  pb api-key delete <ID> [--json]`;

function scopes(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = value
    .split(",")
    .map((scope) => scope.trim().toUpperCase())
    .filter(Boolean);
  if (!values.length || values.some((scope) => !["READ", "WRITE", "ADMIN"].includes(scope))) {
    throw new UsageError("--scopes must contain read, write or admin");
  }
  return [...new Set(values)];
}

async function teamIds(
  config: Awaited<ReturnType<typeof loadConfig>>,
  values: string[] | undefined,
) {
  if (!values?.length) return undefined;
  const resolved = [];
  for (const value of values) resolved.push((await resolveTeam(config, value)).id);
  return [...new Set(resolved)];
}

export async function apiKeyCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();
  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        actor: { type: "string" },
        name: { type: "string" },
        scopes: { type: "string" },
        team: { type: "string", multiple: true },
        "expires-at": { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.actor || !values.name) throw new UsageError(USAGE);
    const input: Record<string, unknown> = {
      actorId: await resolveActor(config, values.actor),
      name: values.name,
    };
    const selectedScopes = scopes(values.scopes);
    const selectedTeams = await teamIds(config, values.team);
    if (selectedScopes) input.scopes = selectedScopes;
    if (selectedTeams) input.teamIds = selectedTeams;
    if (values["expires-at"] !== undefined) input.expiresAt = values["expires-at"];
    const data = await gqlRequest(
      config,
      `mutation($input: ApiKeyCreateInput!) {
      apiKeyCreate(input: $input) { apiKey { ${API_KEY_FIELDS} } key }
    }`,
      { input },
    );
    if (values.json) return printJson(data.apiKeyCreate);
    console.log(`Created API key ${data.apiKeyCreate.apiKey.id}`);
    console.log(`Secret (save it now, it will not be shown again): ${data.apiKeyCreate.key}`);
    return;
  }
  if (action === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { actor: { type: "string" }, json: { type: "boolean" } },
    });
    const actor = values.actor
      ? await resolveActor(config, values.actor)
      : await (async () => (await gqlRequest(config, "{ viewer { id } }")).viewer.id)();
    const data = await gqlRequest(config, `{ actors { id apiKeys { ${API_KEY_FIELDS} } } }`);
    const keys =
      data.actors.find((candidate: { id: string }) => candidate.id === actor)?.apiKeys ?? [];
    if (values.json) return printJson(keys);
    for (const key of keys)
      console.log(
        `${key.id}  ${key.name}  scopes=${key.scopes.join(",")} teams=${key.teamIds.length ? key.teamIds.join(",") : "*"} expires=${key.expiresAt ?? "never"}`,
      );
    if (!keys.length) console.log("No API keys found.");
    return;
  }
  if (action === "rotate") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        name: { type: "string" },
        scopes: { type: "string" },
        team: { type: "string", multiple: true },
        "expires-at": { type: "string" },
        json: { type: "boolean" },
      },
    });
    const input: Record<string, unknown> = {};
    if (values.name !== undefined) input.name = values.name;
    const selectedScopes = scopes(values.scopes);
    const selectedTeams = await teamIds(config, values.team);
    if (selectedScopes) input.scopes = selectedScopes;
    if (selectedTeams) input.teamIds = selectedTeams;
    if (values["expires-at"] !== undefined) input.expiresAt = values["expires-at"];
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $input: ApiKeyRotateInput!) {
      apiKeyRotate(id: $id, input: $input) { apiKey { ${API_KEY_FIELDS} } key }
    }`,
      { id, input },
    );
    if (values.json) return printJson(data.apiKeyRotate);
    console.log(`Rotated API key ${id}`);
    console.log(`Secret (save it now, it will not be shown again): ${data.apiKeyRotate.key}`);
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
