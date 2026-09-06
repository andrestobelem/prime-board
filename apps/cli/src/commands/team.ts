// pb team list|create|update|archive|unarchive|membership-*|workflow-state-*|label-*
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";
import { resolveActor, resolveTeam } from "../resolve.ts";

const TEAM_FIELDS = `id key name description visibility accessPolicy timezone estimatesEnabled estimateScale
  estimateExtendedScale estimateAllowZero cyclesEnabled cycleDurationWeeks cycleStartDay
  cycleCooldownDays cycleUpcomingCount cycleRolloverEnabled cycleAutoAddEnabled
  createdAt archivedAt`;
const MEMBERSHIP_FIELDS = `id teamId actorId role createdAt
  team { id key name } actor { id name email type workspaceRole }`;
const STATE_FIELDS = `id name type color position`;
const LABEL_FIELDS = `id name color teamId`;
const USAGE = `Usage:
  pb team list [--include-archived] [--json]
  pb team create --name TEXT --key KEY [--description TEXT] [--visibility public|private] [--access-policy workspace-members|team-members]
                   [--timezone IANA] [--estimates-enabled true|false] [--estimate-scale SCALE] [--estimate-extended-scale true|false]
                   [--estimate-allow-zero true|false] [--cycles-enabled true|false] [--cycle-duration-weeks N] [--cycle-start-day DAY]
                   [--cycle-cooldown-days N] [--cycle-upcoming-count N] [--cycle-rollover-enabled true|false] [--cycle-auto-add-enabled true|false]
                   [--no-<boolean-setting>] [--json]
  pb team update <KEY|ID> [--name TEXT] [--description TEXT] [--default-state ID] [--visibility public|private] [--access-policy workspace-members|team-members]
                   [planning flags as above] [--json]
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

function integerFlag(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new UsageError(`Invalid ${field}: ${value}`);
  return parsed;
}

const BOOLEAN_PLANNING_FLAGS = [
  "estimates-enabled",
  "estimate-extended-scale",
  "estimate-allow-zero",
  "cycles-enabled",
  "cycle-rollover-enabled",
  "cycle-auto-add-enabled",
] as const;

function booleanFlag(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") throw new UsageError(`${field} must be true or false`);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new UsageError(`${field} must be true or false`);
}

/** Acepta --flag, --flag=true, --flag false y --no-flag para settings booleanos. */
function normalizePlanningArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const flag = BOOLEAN_PLANNING_FLAGS.find(
      (candidate) => arg === `--${candidate}` || arg.startsWith(`--${candidate}=`),
    );
    if (!flag) {
      result.push(arg);
      continue;
    }
    const prefix = `--${flag}`;
    if (arg.startsWith(`${prefix}=`)) {
      result.push(prefix, arg.slice(prefix.length + 1));
    } else if (args[index + 1] == null || args[index + 1]!.startsWith("--")) {
      result.push(arg, "true");
    } else {
      result.push(arg);
    }
  }
  return result;
}

function addPlanningFlags(input: Record<string, unknown>, values: Record<string, any>): void {
  if (values.timezone !== undefined) input.timezone = values.timezone;
  if (values["estimates-enabled"] !== undefined || values["no-estimates-enabled"] === true) {
    input.estimatesEnabled =
      values["no-estimates-enabled"] === true
        ? false
        : booleanFlag(values["estimates-enabled"], "--estimates-enabled");
  }
  if (values["estimate-scale"] !== undefined)
    input.estimateScale = values["estimate-scale"].replaceAll("-", "_").toUpperCase();
  if (
    values["estimate-extended-scale"] !== undefined ||
    values["no-estimate-extended-scale"] === true
  ) {
    input.estimateExtendedScale =
      values["no-estimate-extended-scale"] === true
        ? false
        : booleanFlag(values["estimate-extended-scale"], "--estimate-extended-scale");
  }
  if (values["estimate-allow-zero"] !== undefined || values["no-estimate-allow-zero"] === true) {
    input.estimateAllowZero =
      values["no-estimate-allow-zero"] === true
        ? false
        : booleanFlag(values["estimate-allow-zero"], "--estimate-allow-zero");
  }
  if (values["cycles-enabled"] !== undefined || values["no-cycles-enabled"] === true) {
    input.cyclesEnabled =
      values["no-cycles-enabled"] === true
        ? false
        : booleanFlag(values["cycles-enabled"], "--cycles-enabled");
  }
  if (values["cycle-duration-weeks"] !== undefined)
    input.cycleDurationWeeks = integerFlag(values["cycle-duration-weeks"], "cycle duration");
  if (values["cycle-start-day"] !== undefined)
    input.cycleStartDay = values["cycle-start-day"].toUpperCase();
  if (values["cycle-cooldown-days"] !== undefined)
    input.cycleCooldownDays = integerFlag(values["cycle-cooldown-days"], "cycle cooldown");
  if (values["cycle-upcoming-count"] !== undefined)
    input.cycleUpcomingCount = integerFlag(values["cycle-upcoming-count"], "future cycle count");
  if (
    values["cycle-rollover-enabled"] !== undefined ||
    values["no-cycle-rollover-enabled"] === true
  ) {
    input.cycleRolloverEnabled =
      values["no-cycle-rollover-enabled"] === true
        ? false
        : booleanFlag(values["cycle-rollover-enabled"], "--cycle-rollover-enabled");
  }
  if (
    values["cycle-auto-add-enabled"] !== undefined ||
    values["no-cycle-auto-add-enabled"] === true
  ) {
    input.cycleAutoAddEnabled =
      values["no-cycle-auto-add-enabled"] === true
        ? false
        : booleanFlag(values["cycle-auto-add-enabled"], "--cycle-auto-add-enabled");
  }
}

function planningOptions(): Record<string, { type: "string" | "boolean" }> {
  const options: Record<string, { type: "string" | "boolean" }> = {
    timezone: { type: "string" },
    "estimate-scale": { type: "string" },
    "cycle-duration-weeks": { type: "string" },
    "cycle-start-day": { type: "string" },
    "cycle-cooldown-days": { type: "string" },
    "cycle-upcoming-count": { type: "string" },
  };
  for (const flag of BOOLEAN_PLANNING_FLAGS) {
    options[flag] = { type: "string" };
    options[`no-${flag}`] = { type: "boolean" };
  }
  return options;
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
      args: normalizePlanningArgs(argv.slice(1)),
      options: {
        name: { type: "string" },
        key: { type: "string" },
        description: { type: "string" },
        visibility: { type: "string" },
        "access-policy": { type: "string" },
        ...planningOptions(),
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
    addPlanningFlags(input, values);
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
      args: normalizePlanningArgs(argv.slice(2)),
      options: {
        name: { type: "string" },
        description: { type: "string" },
        "default-state": { type: "string" },
        visibility: { type: "string" },
        "access-policy": { type: "string" },
        ...planningOptions(),
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
    addPlanningFlags(input, values);
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
