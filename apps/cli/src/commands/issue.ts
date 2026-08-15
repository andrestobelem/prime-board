// pb issue list|view|create|update|comment
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { issueLine, printJson, priorityFromName } from "../format.ts";
import {
  readBody, resolveAssignee, resolveIssue, resolveLabels, resolveState, resolveTeam,
} from "../resolve.ts";

const ISSUE_FIELDS = `identifier title description priority
  state { id name type }
  assignee { id name type }
  creator { name type }
  labels { name }
  project { id name }
  parent { identifier }
  url branchName createdAt updatedAt`;

const USAGE = `Usage:
  pb issue list [--team KEY] [--state NAME|TYPE] [--assignee me|ID] [--priority NAME]
                [--project ID] [--search TEXT] [--first N] [--json]
  pb issue view <REF> [--json]
  pb issue create --team KEY --title TEXT [--description TEXT|-] [--priority NAME]
                  [--assignee me|ID] [--parent REF] [--project ID] [--label NAME ...] [--json]
  pb issue update <REF> [--title TEXT] [--description TEXT|-] [--state NAME|TYPE]
                  [--priority NAME] [--assignee me|ID|none] [--parent REF|none]
                  [--project ID|none] [--add-label NAME ...] [--remove-label NAME ...] [--json]
  pb issue comment <REF> [--body TEXT|-]`;

export async function issueCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();

  if (action === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        team: { type: "string" }, state: { type: "string" }, assignee: { type: "string" },
        priority: { type: "string" }, project: { type: "string" }, search: { type: "string" },
        first: { type: "string" }, json: { type: "boolean" },
      },
    });
    const filter: Record<string, unknown> = {};
    let states = null;
    if (values.team) {
      const team = await resolveTeam(config, values.team);
      filter.team = { eq: team.id };
      states = team.states;
    }
    if (values.state) {
      const resolved = resolveState(states, values.state);
      if (resolved.stateId) filter.state = { eq: resolved.stateId };
      if (resolved.stateType) filter.stateType = { eq: resolved.stateType };
    }
    if (values.assignee) filter.assignee = { eq: await resolveAssignee(config, values.assignee) };
    if (values.priority) filter.priority = { eq: priorityFromName(values.priority) };
    if (values.project) filter.project = { eq: values.project };
    if (values.search) filter.search = values.search;

    const data = await gqlRequest(config, `query($filter: IssueFilter, $first: Int) {
      issues(filter: $filter, first: $first) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }`, { filter, first: values.first ? Number(values.first) : 50 });
    if (values.json) return printJson(data.issues);
    for (const issue of data.issues.nodes) console.log(issueLine(issue));
    if (data.issues.nodes.length === 0) console.log("No issues found.");
    return;
  }

  if (action === "view") {
    const ref = argv[1];
    if (!ref) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(config, `query($id: ID!) {
      issue(id: $id) {
        ${ISSUE_FIELDS}
        children { identifier title state { name } }
        comments { body actor { name type } createdAt }
        activity { type actor { name } payload createdAt }
      }
    }`, { id: ref });
    if (!data.issue) throw new UsageError(`Issue not found: ${ref}`);
    if (values.json) return printJson(data.issue);
    const issue = data.issue;
    console.log(issueLine(issue));
    if (issue.description) console.log(`\n${issue.description}`);
    if (issue.children.length > 0) {
      console.log("\nSub-issues:");
      for (const child of issue.children) {
        console.log(`  ${child.identifier}  ${child.state.name}  ${child.title}`);
      }
    }
    if (issue.comments.length > 0) {
      console.log("\nComments:");
      for (const comment of issue.comments) {
        console.log(`  [${comment.createdAt}] ${comment.actor.name}: ${comment.body}`);
      }
    }
    return;
  }

  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        team: { type: "string" }, title: { type: "string" }, description: { type: "string" },
        priority: { type: "string" }, assignee: { type: "string" }, parent: { type: "string" },
        project: { type: "string" }, label: { type: "string", multiple: true },
        number: { type: "string" }, json: { type: "boolean" },
      },
    });
    if (!values.team || !values.title) throw new UsageError(USAGE);
    const team = await resolveTeam(config, values.team);
    const input: Record<string, unknown> = { teamId: team.id, title: values.title };
    if (values.number) input.number = Number(values.number);
    if (values.description) input.description = await readBody(values.description);
    if (values.priority) input.priority = priorityFromName(values.priority);
    if (values.assignee) input.assigneeId = await resolveAssignee(config, values.assignee);
    if (values.parent) input.parentId = (await resolveIssue(config, values.parent)).id;
    if (values.project) input.projectId = values.project;
    if (values.label?.length) {
      input.labelIds = await resolveLabels(config, team.id, values.label);
    }

    const data = await gqlRequest(config, `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { issue { id ${ISSUE_FIELDS} } }
    }`, { input });
    const issue = data.issueCreate.issue;
    if (values.json) return printJson(issue);
    console.log(`Created ${issue.identifier}: ${issue.title}`);
    console.log(issue.url);
    return;
  }

  if (action === "update") {
    const ref = argv[1];
    if (!ref) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        title: { type: "string" }, description: { type: "string" }, state: { type: "string" },
        priority: { type: "string" }, assignee: { type: "string" }, parent: { type: "string" },
        project: { type: "string" }, milestone: { type: "string" },
        "add-label": { type: "string", multiple: true },
        "remove-label": { type: "string", multiple: true },
        json: { type: "boolean" },
      },
    });
    const issue = await resolveIssue(config, ref);
    const input: Record<string, unknown> = {};
    if (values.title) input.title = values.title;
    if (values.description) input.description = await readBody(values.description);
    if (values.state) {
      const resolved = resolveState(issue.team.states, values.state);
      if (resolved.stateType) {
        // Un tipo semántico refiere al primer estado de ese tipo en el team.
        const byType = issue.team.states.find(
          (state: any) => state.type.toLowerCase() === values.state!.toLowerCase(),
        );
        if (!byType) throw new UsageError(`Team has no state of type ${values.state}`);
        input.stateId = byType.id;
      } else {
        input.stateId = resolved.stateId;
      }
    }
    if (values.priority) input.priority = priorityFromName(values.priority);
    if (values.assignee) input.assigneeId = await resolveAssignee(config, values.assignee);
    if (values.parent) {
      input.parentId = values.parent === "none" ? null : (await resolveIssue(config, values.parent)).id;
    }
    if (values.project) input.projectId = values.project === "none" ? null : values.project;
    if (values.milestone) input.milestoneId = values.milestone === "none" ? null : values.milestone;
    if (values["add-label"]?.length) {
      input.addLabelIds = await resolveLabels(config, issue.team.id, values["add-label"]);
    }
    if (values["remove-label"]?.length) {
      input.removeLabelIds = await resolveLabels(config, issue.team.id, values["remove-label"]);
    }
    if (Object.keys(input).length === 0) throw new UsageError("Nothing to update.\n" + USAGE);

    const data = await gqlRequest(config, `mutation($id: ID!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } }
    }`, { id: issue.id, input });
    if (values.json) return printJson(data.issueUpdate.issue);
    console.log(`Updated ${data.issueUpdate.issue.identifier}`);
    console.log(issueLine(data.issueUpdate.issue));
    return;
  }

  if (action === "comment") {
    const ref = argv[1];
    if (!ref) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: { body: { type: "string" }, json: { type: "boolean" } },
    });
    const body = await readBody(values.body);
    const data = await gqlRequest(config, `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        comment { id body actor { name type } issue { identifier } createdAt }
      }
    }`, { input: { issueId: ref, body } });
    if (values.json) return printJson(data.commentCreate.comment);
    console.log(`Commented on ${data.commentCreate.comment.issue.identifier}`);
    return;
  }

  throw new UsageError(USAGE);
}
