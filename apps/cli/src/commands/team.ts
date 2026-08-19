// pb team list|create|update|archive|unarchive|membership-*|workflow-state-*|label-*
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";
import { resolveActor, resolveTeam } from "../resolve.ts";

const TEAM_FIELDS = `id key name description visibility accessPolicy createdAt archivedAt`;
const MEMBERSHIP_FIELDS = `id teamId actorId role createdAt
  team { id key name } actor { id name email type workspaceRole }`;
const STATE_FIELDS = `id name type color position`;
const LABEL_FIELDS = `id name color teamId`;
const USAGE = `Usage:
  pb team list [--include-archived] [--json]
  pb team create --name TEXT --key KEY [--description TEXT] [--visibility public|private] [--access-policy workspace-members|team-members] [--json]
  pb team update <KEY|ID> [--name TEXT] [--description TEXT] [--default-state ID] [--visibility public|private] [--access-policy workspace-members|team-members] [--json]
  pb team archive <KEY|ID> [--json]
  pb team unarchive <KEY|ID> [--json]
  pb team delete <KEY|ID> --confirm KEY [--json]
  pb team membership-list <KEY|ID> [--json]
  pb team membership-create --team <KEY|ID> --actor <ID|NAME|me> [--role member|owner] [--json]
  pb team membership-delete <ID> [--json]
  pb team workflow-state-create --team <KEY|ID> --name TEXT --type TYPE [--color COLOR] [--position N] [--json]
  pb team workflow-state-update <ID> [--name TEXT] [--type TYPE] [--color COLOR] [--position N] [--json]
  pb team workflow-state-delete <ID> [--move-to ID] [--json]
  pb team label-create --name TEXT [--team <KEY|ID>] [--color COLOR] [--json]
  pb team label-update <ID> [--name TEXT] [--color COLOR] [--json]
  pb team label-delete <ID> [--json]`;

function position(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`Invalid position: ${value}`);
  return parsed;
}

function jsonFlag(argv: string[]) {
  return parseArgs({ args: argv, options: { json: { type: "boolean" } } }).values.json;
}

function enumValue(value: string, kind: "visibility" | "access policy"): string {
  const normalized = value.replaceAll("-", "_").toUpperCase();
  const allowed =
    kind === "visibility" ? ["PUBLIC", "PRIVATE"] : ["WORKSPACE_MEMBERS", "TEAM_MEMBERS"];
  if (!allowed.includes(normalized)) throw new UsageError(`Invalid ${kind}: ${value}`);
  return normalized;
}

export async function teamCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();

  if (action === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { "include-archived": { type: "boolean" }, json: { type: "boolean" } },
    });
    const data = await gqlRequest(
      config,
      `query($includeArchived: Boolean) {
        teams(includeArchived: $includeArchived) { ${TEAM_FIELDS} states { ${STATE_FIELDS} } }
      }`,
      { includeArchived: Boolean(values["include-archived"]) },
    );
    if (values.json) return printJson(data.teams);
    for (const team of data.teams)
      console.log(
        `${team.key}  ${team.name}${team.archivedAt ? "  [archived]" : ""}  (${team.states.length} states)`,
      );
    return;
  }

  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        name: { type: "string" },
        key: { type: "string" },
        description: { type: "string" },
        visibility: { type: "string" },
        "access-policy": { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.name || !values.key) throw new UsageError(USAGE);
    const input: Record<string, unknown> = { name: values.name, key: values.key };
    if (values.description !== undefined) input.description = values.description;
    if (values.visibility !== undefined)
      input.visibility = enumValue(values.visibility, "visibility");
    if (values["access-policy"] !== undefined) {
      input.accessPolicy = enumValue(values["access-policy"], "access policy");
    }
    const data = await gqlRequest(
      config,
      `mutation($input: TeamCreateInput!) {
      teamCreate(input: $input) { team { ${TEAM_FIELDS} } }
    }`,
      { input },
    );
    if (values.json) return printJson(data.teamCreate.team);
    console.log(`Created team: ${data.teamCreate.team.key} (${data.teamCreate.team.id})`);
    return;
  }

  if (action === "archive" || action === "unarchive") {
    const ref = argv[1];
    if (!ref) throw new UsageError(USAGE);
    const jsonOutput = jsonFlag(argv.slice(2));
    const team = await resolveTeam(config, ref, action === "unarchive");
    const mutation = action === "archive" ? "teamArchive" : "teamUnarchive";
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { ${mutation}(id: $id) { team { ${TEAM_FIELDS} } } }`,
      { id: team.id },
    );
    if (jsonOutput) return printJson(data[mutation].team);
    console.log(
      `${action === "archive" ? "Archived" : "Unarchived"} team ${data[mutation].team.key}`,
    );
    return;
  }

  if (action === "delete") {
    const ref = argv[1];
    if (!ref) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: { confirm: { type: "string" }, json: { type: "boolean" } },
    });
    if (!values.confirm) throw new UsageError("Deletion requires --confirm TEAM_KEY\n" + USAGE);
    const team = await resolveTeam(config, ref, true);
    if (!values.json) {
      console.error(
        `WARNING: deleting ${team.key} is permanent; Issues, Projects, Cycles, Labels, Saved Views and Initiatives must already be removed.`,
      );
    }
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $confirmation: String!) {
        teamDelete(id: $id, confirmation: $confirmation) { success }
      }`,
      { id: team.id, confirmation: values.confirm },
    );
    if (values.json) return printJson(data.teamDelete);
    console.log(`Deleted team ${team.key}`);
    return;
  }

  if (action === "update") {
    const ref = argv[1];
    if (!ref) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        name: { type: "string" },
        description: { type: "string" },
        "default-state": { type: "string" },
        visibility: { type: "string" },
        "access-policy": { type: "string" },
        json: { type: "boolean" },
      },
    });
    const input: Record<string, unknown> = {};
    if (values.name !== undefined) input.name = values.name;
    if (values.description !== undefined) input.description = values.description;
    if (values["default-state"] !== undefined) input.defaultStateId = values["default-state"];
    if (values.visibility !== undefined)
      input.visibility = enumValue(values.visibility, "visibility");
    if (values["access-policy"] !== undefined) {
      input.accessPolicy = enumValue(values["access-policy"], "access policy");
    }
    if (!Object.keys(input).length) throw new UsageError(USAGE);
    const team = await resolveTeam(config, ref);
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $input: TeamUpdateInput!) {
      teamUpdate(id: $id, input: $input) { team { ${TEAM_FIELDS} } }
    }`,
      { id: team.id, input },
    );
    if (values.json) return printJson(data.teamUpdate.team);
    console.log(`Updated team ${data.teamUpdate.team.key}`);
    return;
  }

  if (action === "membership-list") {
    const ref = argv[1];
    if (!ref) throw new UsageError(USAGE);
    const jsonOutput = jsonFlag(argv.slice(2));
    const team = await resolveTeam(config, ref);
    const data = await gqlRequest(
      config,
      `query($teamId: ID!) {
      teamMemberships(teamId: $teamId) { ${MEMBERSHIP_FIELDS} }
    }`,
      { teamId: team.id },
    );
    if (jsonOutput) return printJson(data.teamMemberships);
    for (const membership of data.teamMemberships)
      console.log(`${membership.id}  ${membership.role}  ${membership.actor.name}`);
    return;
  }

  if (action === "membership-create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        team: { type: "string" },
        actor: { type: "string" },
        role: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.team || !values.actor) throw new UsageError(USAGE);
    const input: Record<string, unknown> = {
      teamId: (await resolveTeam(config, values.team)).id,
      actorId: await resolveActor(config, values.actor),
    };
    if (values.role !== undefined) input.role = values.role.toUpperCase();
    const data = await gqlRequest(
      config,
      `mutation($input: TeamMembershipCreateInput!) {
      teamMembershipCreate(input: $input) { membership { ${MEMBERSHIP_FIELDS} } }
    }`,
      { input },
    );
    if (values.json) return printJson(data.teamMembershipCreate.membership);
    console.log(`Created membership ${data.teamMembershipCreate.membership.id}`);
    return;
  }

  if (action === "membership-delete") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const jsonOutput = jsonFlag(argv.slice(2));
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { teamMembershipDelete(id: $id) { success } }`,
      { id },
    );
    if (jsonOutput) return printJson(data.teamMembershipDelete);
    console.log(`Deleted membership ${id}`);
    return;
  }

  if (action === "workflow-state-create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        team: { type: "string" },
        name: { type: "string" },
        type: { type: "string" },
        color: { type: "string" },
        position: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.team || !values.name || !values.type) throw new UsageError(USAGE);
    const input: Record<string, unknown> = {
      teamId: (await resolveTeam(config, values.team)).id,
      name: values.name,
      type: values.type.toUpperCase(),
    };
    if (values.color !== undefined) input.color = values.color;
    if (values.position !== undefined) input.position = position(values.position);
    const data = await gqlRequest(
      config,
      `mutation($input: WorkflowStateCreateInput!) {
      workflowStateCreate(input: $input) { workflowState { ${STATE_FIELDS} } }
    }`,
      { input },
    );
    if (values.json) return printJson(data.workflowStateCreate.workflowState);
    console.log(
      `Created workflow state: ${data.workflowStateCreate.workflowState.name} (${data.workflowStateCreate.workflowState.id})`,
    );
    return;
  }

  if (action === "workflow-state-update") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        name: { type: "string" },
        type: { type: "string" },
        color: { type: "string" },
        position: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const input: Record<string, unknown> = {};
    if (values.name !== undefined) input.name = values.name;
    if (values.type !== undefined) input.type = values.type.toUpperCase();
    if (values.color !== undefined) input.color = values.color;
    if (values.position !== undefined) input.position = position(values.position);
    if (!Object.keys(input).length) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $input: WorkflowStateUpdateInput!) {
      workflowStateUpdate(id: $id, input: $input) { workflowState { ${STATE_FIELDS} } }
    }`,
      { id, input },
    );
    if (values.json) return printJson(data.workflowStateUpdate.workflowState);
    console.log(`Updated workflow state ${id}`);
    return;
  }

  if (action === "workflow-state-delete") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: { "move-to": { type: "string" }, json: { type: "boolean" } },
    });
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $moveToStateId: ID) {
      workflowStateDelete(id: $id, moveToStateId: $moveToStateId) { success movedIssues }
    }`,
      { id, moveToStateId: values["move-to"] ?? null },
    );
    if (values.json) return printJson(data.workflowStateDelete);
    console.log(`Deleted workflow state ${id}`);
    return;
  }

  if (action === "label-create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        name: { type: "string" },
        team: { type: "string" },
        color: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.name) throw new UsageError(USAGE);
    const input: Record<string, unknown> = { name: values.name };
    if (values.team !== undefined) input.teamId = (await resolveTeam(config, values.team)).id;
    if (values.color !== undefined) input.color = values.color;
    const data = await gqlRequest(
      config,
      `mutation($input: LabelCreateInput!) {
      labelCreate(input: $input) { label { ${LABEL_FIELDS} } }
    }`,
      { input },
    );
    if (values.json) return printJson(data.labelCreate.label);
    console.log(`Created label: ${data.labelCreate.label.name} (${data.labelCreate.label.id})`);
    return;
  }

  if (action === "label-update") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: { name: { type: "string" }, color: { type: "string" }, json: { type: "boolean" } },
    });
    const input: Record<string, unknown> = {};
    if (values.name !== undefined) input.name = values.name;
    if (values.color !== undefined) input.color = values.color;
    if (!Object.keys(input).length) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $input: LabelUpdateInput!) {
      labelUpdate(id: $id, input: $input) { label { ${LABEL_FIELDS} } }
    }`,
      { id, input },
    );
    if (values.json) return printJson(data.labelUpdate.label);
    console.log(`Updated label ${id}`);
    return;
  }

  if (action === "label-delete") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const jsonOutput = jsonFlag(argv.slice(2));
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { labelDelete(id: $id) { success affectedIssues } }`,
      { id },
    );
    if (jsonOutput) return printJson(data.labelDelete);
    console.log(`Deleted label ${id}`);
    return;
  }

  throw new UsageError(USAGE);
}
