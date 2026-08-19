// pb actor list|create|update|invite|suspend|reactivate|revoke|leave
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";

const ACTOR_FIELDS = `id name email type workspaceRole status createdAt`;
const USAGE = `Usage:
  pb actor list [--type human|agent] [--json]
  pb actor create --name TEXT --type human|agent [--email EMAIL] [--json]
  pb actor update <ID> [--name TEXT] [--email EMAIL] [--json]
  pb actor invite [--email EMAIL] [--name TEXT] [--type human|agent] [--expires-at ISO] [--json]
  pb actor accept-invite --token TOKEN [--name TEXT] [--type human|agent] [--json]
  pb actor revoke-invite <ID> [--json]
  pb actor suspend <ID> [--json]
  pb actor reactivate <ID> [--json]
  pb actor revoke <ID> [--json]
  pb actor leave [ID] [--json]`;

function actorMutation(action: string, id: string, data: any, json: boolean): void {
  const actor = data[action].actor;
  if (json) return printJson(actor);
  console.log(`${action} actor: ${actor.name} (${actor.id})`);
}

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
      { type: values.type ? values.type.toUpperCase() : null },
    );
    if (values.json) return printJson(data.actors);
    for (const actor of data.actors)
      console.log(
        `${actor.id}  [${actor.type.toLowerCase()}]  ${actor.name}  (${actor.status.toLowerCase()})`,
      );
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
  if (action === "invite") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        email: { type: "string" },
        name: { type: "string" },
        type: { type: "string" },
        "expires-at": { type: "string" },
        json: { type: "boolean" },
      },
    });
    const input: Record<string, unknown> = {};
    if (values.email !== undefined) input.email = values.email;
    if (values.name !== undefined) input.name = values.name;
    if (values.type !== undefined) input.type = values.type.toUpperCase();
    if (values["expires-at"] !== undefined) input.expiresAt = values["expires-at"];
    const data = await gqlRequest(
      config,
      `mutation($input: ActorInviteInput!) { actorInvite(input: $input) {
      invitation { id email name type status expiresAt } token
    } }`,
      { input },
    );
    if (values.json) return printJson(data.actorInvite);
    console.log(`Invitation created: ${data.actorInvite.invitation.id}`);
    console.log(`Token (save it now): ${data.actorInvite.token}`);
    return;
  }
  if (action === "accept-invite") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        token: { type: "string" },
        name: { type: "string" },
        type: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.token) throw new UsageError(USAGE);
    const input: Record<string, unknown> = {};
    if (values.name !== undefined) input.name = values.name;
    if (values.type !== undefined) input.type = values.type.toUpperCase();
    const data = await gqlRequest(
      config,
      `mutation($token: String!, $input: ActorInvitationAcceptInput!) {
      actorInvitationAccept(token: $token, input: $input) {
        actor { ${ACTOR_FIELDS} } invitation { id status } key
      }
    }`,
      { token: values.token, input },
    );
    if (values.json) return printJson(data.actorInvitationAccept);
    console.log(`Accepted invitation for ${data.actorInvitationAccept.actor.name}`);
    console.log(`API key (save it now): ${data.actorInvitationAccept.key}`);
    return;
  }
  if (action === "revoke-invite") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { actorInvitationRevoke(id: $id) { invitation { id status } } }`,
      { id },
    );
    if (values.json) return printJson(data.actorInvitationRevoke.invitation);
    console.log(`Revoked invitation: ${id}`);
    return;
  }
  if (["suspend", "reactivate", "revoke"].includes(action ?? "")) {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const mutation =
      action === "suspend"
        ? "actorSuspend"
        : action === "reactivate"
          ? "actorReactivate"
          : "actorRevoke";
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { ${mutation}(id: $id) { actor { ${ACTOR_FIELDS} } } }`,
      { id },
    );
    return actorMutation(mutation, id, data, Boolean(values.json));
  }
  if (action === "leave") {
    const candidate = argv[1];
    const { values } = parseArgs({
      args: candidate?.startsWith("-") ? argv.slice(1) : argv.slice(2),
      options: { json: { type: "boolean" } },
    });
    const data = await gqlRequest(
      config,
      `mutation($id: ID) { actorLeave(id: $id) { actor { ${ACTOR_FIELDS} } } }`,
      { id: candidate?.startsWith("-") || candidate === undefined ? null : candidate },
    );
    return actorMutation("actorLeave", candidate ?? "me", data, Boolean(values.json));
  }
  throw new UsageError(USAGE);
}
