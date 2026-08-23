// pb document list|view|create|update|archive|unarchive
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { ApiError, UsageError } from "../errors.ts";
import { printJson } from "../format.ts";
import { readBody, resolveTeam } from "../resolve.ts";

const DOCUMENT_FIELDS = `id title content createdAt updatedAt archivedAt url
  creator { id name type }
  issue { id identifier title }
  project { id name }
  team { id key name }
  initiative { id name }
  cycle { id number name }`;

const TARGET_OPTIONS = {
  issue: { type: "string" as const },
  project: { type: "string" as const },
  team: { type: "string" as const },
  initiative: { type: "string" as const },
  cycle: { type: "string" as const },
};

const USAGE = `Usage:
  pb document list [--issue ID] [--project ID] [--team KEY] [--initiative ID] [--cycle ID]
                    [--search TEXT] [--include-archived] [--json]
  pb document view <ID> [--json]
  pb document create --title TEXT [--content TEXT|-] [--issue REF|--project ID|--team KEY
                      |--initiative ID|--cycle ID] [--json]
  pb document update <ID> [--title TEXT] [--content TEXT|-] [--json]
  pb document archive|unarchive <ID> [--json]`;

function selectedTarget(values: Record<string, unknown>): Record<string, unknown> {
  const targetEntries = [
    ["issueId", values.issue],
    ["projectId", values.project],
    ["teamId", values.team],
    ["initiativeId", values.initiative],
    ["cycleId", values.cycle],
  ].filter(([, value]) => typeof value === "string" && value.length > 0);
  if (targetEntries.length > 1)
    throw new UsageError("A document can have only one target.\n" + USAGE);
  return Object.fromEntries(targetEntries);
}

function outputDocument(document: any, json: boolean): void {
  if (json) return printJson(document);
  console.log(`${document.title}  (${document.id})`);
  if (document.issue) console.log(`Issue: ${document.issue.identifier}  ${document.issue.title}`);
  if (document.project) console.log(`Project: ${document.project.name}`);
  if (document.team) console.log(`Team: ${document.team.key}`);
  if (document.initiative) console.log(`Initiative: ${document.initiative.name}`);
  if (document.cycle) console.log(`Cycle: ${document.cycle.name}`);
  if (document.archivedAt) console.log(`Archived: ${document.archivedAt}`);
  if (document.content) console.log(`\n${document.content}`);
}

export async function documentCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();

  if (action === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        ...TARGET_OPTIONS,
        search: { type: "string" },
        "include-archived": { type: "boolean" },
        json: { type: "boolean" },
      },
    });
    const target = selectedTarget(values);
    if (target.teamId) target.teamId = (await resolveTeam(config, target.teamId as string)).id;
    const data = await gqlRequest(
      config,
      `query($issueId: ID, $projectId: ID, $teamId: ID, $initiativeId: ID, $cycleId: ID, $search: String, $includeArchived: Boolean) {
        documents(issueId: $issueId, projectId: $projectId, teamId: $teamId, initiativeId: $initiativeId, cycleId: $cycleId, search: $search, includeArchived: $includeArchived) {
          ${DOCUMENT_FIELDS}
        }
      }`,
      {
        ...target,
        search: values.search ?? null,
        includeArchived: Boolean(values["include-archived"]),
      },
    );
    if (values.json) return printJson(data.documents);
    for (const document of data.documents) console.log(`${document.id}  ${document.title}`);
    if (data.documents.length === 0) console.log("No documents found.");
    return;
  }

  if (action === "view") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `query($id: ID!) { document(id: $id) { ${DOCUMENT_FIELDS} } }`,
      { id },
    );
    if (!data.document) throw new ApiError(`Document not found: ${id}`, "NOT_FOUND");
    outputDocument(data.document, Boolean(values.json));
    return;
  }

  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        title: { type: "string" },
        content: { type: "string" },
        ...TARGET_OPTIONS,
        json: { type: "boolean" },
      },
    });
    if (!values.title) throw new UsageError(USAGE);
    const input: Record<string, unknown> = { title: values.title, ...selectedTarget(values) };
    if (values.team) input.teamId = (await resolveTeam(config, values.team)).id;
    if (values.content !== undefined) input.content = await readBody(values.content);
    const data = await gqlRequest(
      config,
      `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { document { ${DOCUMENT_FIELDS} } } }`,
      { input },
    );
    outputDocument(data.documentCreate.document, Boolean(values.json));
    return;
  }

  if (action === "update") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        title: { type: "string" },
        content: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const input: Record<string, unknown> = {};
    if (values.title !== undefined) input.title = values.title;
    if (values.content !== undefined) input.content = await readBody(values.content);
    if (!Object.keys(input).length) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $input: DocumentUpdateInput!) { documentUpdate(id: $id, input: $input) { document { ${DOCUMENT_FIELDS} } } }`,
      { id, input },
    );
    outputDocument(data.documentUpdate.document, Boolean(values.json));
    return;
  }

  if (action === "archive" || action === "unarchive") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const mutation = action === "archive" ? "documentArchive" : "documentUnarchive";
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { ${mutation}(id: $id) { document { ${DOCUMENT_FIELDS} } } }`,
      { id },
    );
    outputDocument(data[mutation].document, Boolean(values.json));
    return;
  }

  throw new UsageError(USAGE);
}
