// pb cycle list|view|create|update|delete|carry-over
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";
import { resolveTeam } from "../resolve.ts";

const CYCLE_FIELDS = `id number name startsAt endsAt state progress completedIssues totalIssues
  archivedAt createdAt updatedAt team { id key name }`;
const USAGE = `Usage:
  pb cycle list --team KEY [--include-archived] [--json]
  pb cycle view <ID> [--json]
  pb cycle create --team KEY --name TEXT --starts-at DATE --ends-at DATE [--state STATE] [--json]
  pb cycle update <ID> [--name TEXT] [--starts-at DATE] [--ends-at DATE]
                    [--state STATE] [--archived true|false] [--json]
  pb cycle delete <ID> [--json]
  pb cycle carry-over --from ID --to ID [--json]`;

export async function cycleCommand(argv: string[]): Promise<void> {
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
    if (!values.team) throw new UsageError(USAGE);
    const teamId = (await resolveTeam(config, values.team)).id;
    const data = await gqlRequest(
      config,
      `query($teamId: ID!, $includeArchived: Boolean) {
      cycles(teamId: $teamId, includeArchived: $includeArchived) { ${CYCLE_FIELDS} }
    }`,
      { teamId, includeArchived: Boolean(values["include-archived"]) },
    );
    if (values.json) return printJson(data.cycles);
    for (const cycle of data.cycles)
      console.log(`${cycle.id}  [${cycle.state.toLowerCase()}]  ${cycle.name}`);
    if (data.cycles.length === 0) console.log("No cycles found.");
    return;
  }
  if (action === "view") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `query($id: ID!) { cycle(id: $id) { ${CYCLE_FIELDS} } }`,
      { id },
    );
    if (!data.cycle) throw new UsageError(`Cycle not found: ${id}`);
    if (values.json) return printJson(data.cycle);
    console.log(`${data.cycle.name}  [${data.cycle.state.toLowerCase()}]`);
    console.log(`${data.cycle.startsAt} → ${data.cycle.endsAt}`);
    return;
  }
  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        team: { type: "string" },
        name: { type: "string" },
        "starts-at": { type: "string" },
        "ends-at": { type: "string" },
        state: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.team || !values.name || !values["starts-at"] || !values["ends-at"])
      throw new UsageError(USAGE);
    const input: Record<string, unknown> = {
      teamId: (await resolveTeam(config, values.team)).id,
      name: values.name,
      startsAt: values["starts-at"],
      endsAt: values["ends-at"],
    };
    if (values.state) input.state = values.state.toUpperCase();
    const data = await gqlRequest(
      config,
      `mutation($input: CycleCreateInput!) {
      cycleCreate(input: $input) { cycle { ${CYCLE_FIELDS} } }
    }`,
      { input },
    );
    if (values.json) return printJson(data.cycleCreate.cycle);
    console.log(`Created cycle: ${data.cycleCreate.cycle.name} (${data.cycleCreate.cycle.id})`);
    return;
  }
  if (action === "update") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        name: { type: "string" },
        "starts-at": { type: "string" },
        "ends-at": { type: "string" },
        state: { type: "string" },
        archived: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const input: Record<string, unknown> = {};
    if (values.name !== undefined) input.name = values.name;
    if (values["starts-at"] !== undefined) input.startsAt = values["starts-at"];
    if (values["ends-at"] !== undefined) input.endsAt = values["ends-at"];
    if (values.state !== undefined) input.state = values.state.toUpperCase();
    if (values.archived !== undefined) input.archived = values.archived === "true";
    if (!Object.keys(input).length) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $input: CycleUpdateInput!) {
      cycleUpdate(id: $id, input: $input) { cycle { ${CYCLE_FIELDS} } }
    }`,
      { id, input },
    );
    if (values.json) return printJson(data.cycleUpdate.cycle);
    console.log(`Updated cycle ${id}`);
    return;
  }
  if (action === "delete") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { cycleDelete(id: $id) { success } }`,
      { id },
    );
    if (values.json) return printJson(data.cycleDelete);
    console.log(`Deleted cycle ${id}`);
    return;
  }
  if (action === "carry-over") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { from: { type: "string" }, to: { type: "string" }, json: { type: "boolean" } },
    });
    if (!values.from || !values.to) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($from: ID!, $to: ID!) {
      cycleCarryOver(fromCycleId: $from, toCycleId: $to) { success movedIssues }
    }`,
      { from: values.from, to: values.to },
    );
    if (values.json) return printJson(data.cycleCarryOver);
    console.log(`Carried over ${data.cycleCarryOver.movedIssues} issues`);
    return;
  }
  throw new UsageError(USAGE);
}
