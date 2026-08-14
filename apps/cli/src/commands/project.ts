// pb project list|view|create
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { issueLine, printJson } from "../format.ts";
import { resolveTeam, resolveViewerId } from "../resolve.ts";

const PROJECT_FIELDS = `id name description state targetDate
  lead { id name type } createdAt updatedAt`;

const USAGE = `Usage:
  pb project list [--state NAME] [--team KEY] [--json]
  pb project view <ID> [--json]
  pb project create --name TEXT [--team KEY ...] [--description TEXT] [--state NAME]
                    [--lead me|ID] [--target-date YYYY-MM-DD] [--json]`;

export async function projectCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();

  if (action === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { state: { type: "string" }, team: { type: "string" }, json: { type: "boolean" } },
    });
    const teamId = values.team ? (await resolveTeam(config, values.team)).id : null;
    const data = await gqlRequest(config, `query($state: ProjectState, $team: ID) {
      projects(state: $state, team: $team) { ${PROJECT_FIELDS} }
    }`, { state: values.state ? values.state.toUpperCase() : null, team: teamId });
    if (values.json) return printJson(data.projects);
    for (const project of data.projects) {
      const lead = project.lead ? `  lead: ${project.lead.name}` : "";
      console.log(`${project.id}  [${project.state.toLowerCase()}]  ${project.name}${lead}`);
    }
    if (data.projects.length === 0) console.log("No projects found.");
    return;
  }

  if (action === "view") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(config, `query($id: ID!) {
      project(id: $id) {
        ${PROJECT_FIELDS}
        issues(first: 100) { nodes { identifier title priority
          state { name type } assignee { name } labels { name } } }
      }
    }`, { id });
    if (!data.project) throw new UsageError(`Project not found: ${id}`);
    if (values.json) return printJson(data.project);
    const project = data.project;
    console.log(`${project.name}  [${project.state.toLowerCase()}]`);
    if (project.description) console.log(project.description);
    if (project.lead) console.log(`Lead: ${project.lead.name}`);
    if (project.targetDate) console.log(`Target: ${project.targetDate}`);
    console.log("\nIssues:");
    for (const issue of project.issues.nodes) console.log(`  ${issueLine(issue)}`);
    return;
  }

  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        name: { type: "string" }, description: { type: "string" }, state: { type: "string" },
        lead: { type: "string" }, "target-date": { type: "string" }, json: { type: "boolean" },
      },
    });
    if (!values.name) throw new UsageError(USAGE);
    const input: Record<string, unknown> = { name: values.name };
    if (values.description) input.description = values.description;
    if (values.state) input.state = values.state.toUpperCase();
    if (values.lead) {
      input.leadId = values.lead === "me" ? await resolveViewerId(config) : values.lead;
    }
    if (values["target-date"]) input.targetDate = values["target-date"];

    const data = await gqlRequest(config, `mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) { project { ${PROJECT_FIELDS} } }
    }`, { input });
    if (values.json) return printJson(data.projectCreate.project);
    console.log(`Created project: ${data.projectCreate.project.name} (${data.projectCreate.project.id})`);
    return;
  }

  throw new UsageError(USAGE);
}
