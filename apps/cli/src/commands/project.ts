// pb project list|view|create|archive|unarchive|milestone|update
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { ApiError, UsageError } from "../errors.ts";
import { issueLine, printJson } from "../format.ts";
import { readBody, resolveTeam, resolveViewerId } from "../resolve.ts";

const PROJECT_FIELDS = `id name description state targetDate archivedAt
  lead { id name type } createdAt updatedAt`;
const MILESTONE_FIELDS = `id name description targetDate position createdAt project { id name }`;
const PROJECT_UPDATE_FIELDS = `id health body risks createdAt updatedAt
  project { id name } author { id name type }`;

const USAGE = `Usage:
  pb project list [--state NAME] [--team KEY] [--include-archived] [--json]
  pb project view <ID> [--json]
  pb project create --name TEXT [--team KEY ...] [--description TEXT] [--state NAME]
                    [--lead me|ID] [--target-date YYYY-MM-DD] [--json]
  pb project archive|unarchive <ID> [--json]
  pb project milestone-list <PROJECT_ID> [--json]
  pb project milestone-create --project ID --name TEXT [--description TEXT]
                               [--target-date DATE] [--position N] [--json]
  pb project milestone-update <ID> [--name TEXT] [--description TEXT]
                               [--target-date DATE] [--position N] [--json]
  pb project milestone-delete <ID> [--json]
  pb project update-list <PROJECT_ID> [--json]
  pb project update-create --project ID --health on_track|at_risk|off_track
                            --body TEXT|- [--risks TEXT] [--json]
  pb project update-delete <ID> [--json]`;

function parseJson(argv: string[]) {
  return parseArgs({ args: argv, options: { json: { type: "boolean" } } }).values.json;
}

function parsePosition(value: string): number {
  const position = Number(value);
  if (!Number.isFinite(position)) throw new UsageError(`Invalid position: ${value}`);
  return position;
}

export async function projectCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();

  if (action === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        state: { type: "string" },
        team: { type: "string" },
        "include-archived": { type: "boolean" },
        json: { type: "boolean" },
      },
    });
    const teamId = values.team ? (await resolveTeam(config, values.team)).id : null;
    const data = await gqlRequest(
      config,
      `query($state: ProjectState, $team: ID, $includeArchived: Boolean) {
      projects(state: $state, team: $team, includeArchived: $includeArchived) { ${PROJECT_FIELDS} }
    }`,
      {
        state: values.state ? values.state.toUpperCase() : null,
        team: teamId,
        includeArchived: Boolean(values["include-archived"]),
      },
    );
    if (values.json) return printJson(data.projects);
    for (const project of data.projects) {
      const lead = project.lead ? `  lead: ${project.lead.name}` : "";
      const archived = project.archivedAt ? " [archived]" : "";
      console.log(
        `${project.id}  [${project.state.toLowerCase()}]${archived}  ${project.name}${lead}`,
      );
    }
    if (data.projects.length === 0) console.log("No projects found.");
    return;
  }

  if (action === "view") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `query($id: ID!) {
      project(id: $id) {
        ${PROJECT_FIELDS}
        milestones { ${MILESTONE_FIELDS} }
        updates { ${PROJECT_UPDATE_FIELDS} }
        issues(first: 100) { nodes { identifier title priority
          state { name type } assignee { name } labels { name } } }
      }
    }`,
      { id },
    );
    if (!data.project) throw new ApiError(`Project not found: ${id}`, "NOT_FOUND");
    if (values.json) return printJson(data.project);
    const project = data.project;
    console.log(`${project.name}  [${project.state.toLowerCase()}]`);
    if (project.description) console.log(project.description);
    if (project.lead) console.log(`Lead: ${project.lead.name}`);
    if (project.targetDate) console.log(`Target: ${project.targetDate}`);
    console.log("\nMilestones:");
    for (const milestone of project.milestones) console.log(`  ${milestone.id}  ${milestone.name}`);
    console.log("\nUpdates:");
    for (const update of project.updates)
      console.log(`  ${update.id}  [${update.health}]  ${update.body}`);
    console.log("\nIssues:");
    for (const issue of project.issues.nodes) console.log(`  ${issueLine(issue)}`);
    return;
  }

  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        name: { type: "string" },
        description: { type: "string" },
        state: { type: "string" },
        lead: { type: "string" },
        "target-date": { type: "string" },
        team: { type: "string", multiple: true },
        json: { type: "boolean" },
      },
    });
    if (!values.name) throw new UsageError(USAGE);
    const input: Record<string, unknown> = { name: values.name };
    if (values.team?.length) {
      input.teamIds = await Promise.all(
        values.team.map(async (key) => (await resolveTeam(config, key)).id),
      );
    }
    if (values.description) input.description = values.description;
    if (values.state) input.state = values.state.toUpperCase();
    if (values.lead) {
      input.leadId = values.lead === "me" ? await resolveViewerId(config) : values.lead;
    }
    if (values["target-date"]) input.targetDate = values["target-date"];

    const data = await gqlRequest(
      config,
      `mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) { project { ${PROJECT_FIELDS} } }
    }`,
      { input },
    );
    if (values.json) return printJson(data.projectCreate.project);
    console.log(
      `Created project: ${data.projectCreate.project.name} (${data.projectCreate.project.id})`,
    );
    return;
  }

  if (action === "archive" || action === "unarchive") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const jsonOutput = parseJson(argv.slice(2));
    const mutation = action === "archive" ? "projectArchive" : "projectUnarchive";
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) {
      ${mutation}(id: $id) { project { ${PROJECT_FIELDS} } }
    }`,
      { id },
    );
    if (jsonOutput) return printJson(data[mutation].project);
    console.log(`${action === "archive" ? "Archived" : "Unarchived"} project ${id}`);
    return;
  }

  if (action === "milestone-list") {
    const projectId = argv[1];
    if (!projectId) throw new UsageError(USAGE);
    const jsonOutput = parseJson(argv.slice(2));
    const data = await gqlRequest(
      config,
      `query($id: ID!) {
      project(id: $id) { milestones { ${MILESTONE_FIELDS} } }
    }`,
      { id: projectId },
    );
    if (!data.project) throw new ApiError(`Project not found: ${projectId}`, "NOT_FOUND");
    if (jsonOutput) return printJson(data.project.milestones);
    for (const milestone of data.project.milestones)
      console.log(`${milestone.id}  ${milestone.name}`);
    return;
  }

  if (action === "milestone-create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        project: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        "target-date": { type: "string" },
        position: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.project || !values.name) throw new UsageError(USAGE);
    const input: Record<string, unknown> = { projectId: values.project, name: values.name };
    if (values.description !== undefined) input.description = await readBody(values.description);
    if (values["target-date"] !== undefined) input.targetDate = values["target-date"];
    if (values.position !== undefined) input.position = parsePosition(values.position);
    const data = await gqlRequest(
      config,
      `mutation($input: MilestoneCreateInput!) {
      milestoneCreate(input: $input) { milestone { ${MILESTONE_FIELDS} } }
    }`,
      { input },
    );
    if (values.json) return printJson(data.milestoneCreate.milestone);
    console.log(
      `Created milestone: ${data.milestoneCreate.milestone.name} (${data.milestoneCreate.milestone.id})`,
    );
    return;
  }

  if (action === "milestone-update") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        name: { type: "string" },
        description: { type: "string" },
        "target-date": { type: "string" },
        position: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const input: Record<string, unknown> = {};
    if (values.name !== undefined) input.name = values.name;
    if (values.description !== undefined) input.description = await readBody(values.description);
    if (values["target-date"] !== undefined) input.targetDate = values["target-date"];
    if (values.position !== undefined) input.position = parsePosition(values.position);
    if (Object.keys(input).length === 0) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $input: MilestoneUpdateInput!) {
      milestoneUpdate(id: $id, input: $input) { milestone { ${MILESTONE_FIELDS} } }
    }`,
      { id, input },
    );
    if (values.json) return printJson(data.milestoneUpdate.milestone);
    console.log(`Updated milestone ${id}`);
    return;
  }

  if (action === "milestone-delete") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const jsonOutput = parseJson(argv.slice(2));
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) {
      milestoneDelete(id: $id) { success orphanedIssues }
    }`,
      { id },
    );
    if (jsonOutput) return printJson(data.milestoneDelete);
    console.log(`Deleted milestone ${id}`);
    return;
  }

  if (action === "update-list") {
    const projectId = argv[1];
    if (!projectId) throw new UsageError(USAGE);
    const jsonOutput = parseJson(argv.slice(2));
    const data = await gqlRequest(
      config,
      `query($id: ID!) {
      project(id: $id) { updates { ${PROJECT_UPDATE_FIELDS} } }
    }`,
      { id: projectId },
    );
    if (!data.project) throw new ApiError(`Project not found: ${projectId}`, "NOT_FOUND");
    if (jsonOutput) return printJson(data.project.updates);
    for (const update of data.project.updates)
      console.log(`${update.id}  [${update.health}]  ${update.body}`);
    return;
  }

  if (action === "update-create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        project: { type: "string" },
        health: { type: "string" },
        body: { type: "string" },
        risks: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.project || !values.health || values.body === undefined) throw new UsageError(USAGE);
    const input: Record<string, unknown> = {
      projectId: values.project,
      health: values.health.toUpperCase(),
      body: await readBody(values.body),
    };
    if (values.risks !== undefined) input.risks = await readBody(values.risks);
    const data = await gqlRequest(
      config,
      `mutation($input: ProjectUpdateCreateInput!) {
      projectUpdateCreate(input: $input) { projectUpdate { ${PROJECT_UPDATE_FIELDS} } }
    }`,
      { input },
    );
    if (values.json) return printJson(data.projectUpdateCreate.projectUpdate);
    console.log(`Created project update ${data.projectUpdateCreate.projectUpdate.id}`);
    return;
  }

  if (action === "update-delete") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const jsonOutput = parseJson(argv.slice(2));
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) {
      projectUpdateDelete(id: $id) { success }
    }`,
      { id },
    );
    if (jsonOutput) return printJson(data.projectUpdateDelete);
    console.log(`Deleted project update ${id}`);
    return;
  }

  throw new UsageError(USAGE);
}
