// pb issue list|view|create|update|comment
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { ApiError, UsageError } from "../errors.ts";
import { issueLine, printJson, priorityFromName } from "../format.ts";
import {
  readBody,
  resolveAssignee,
  resolveActor,
  resolveCycle,
  resolveIssue,
  resolveLabels,
  resolveMilestone,
  resolveProject,
  resolveState,
  resolveTeam,
} from "../resolve.ts";

const ISSUE_FIELDS = `identifier title description priority
  state { id name type }
  assignee { id name type }
  creator { name type }
  labels { id name }
  project { id name }
  milestone { id name }
  cycle { id number name }
  parent { identifier }
  url branchName createdAt updatedAt archivedAt`;

const USAGE = `Usage:
  pb issue list [--team KEY] [--state NAME|TYPE] [--assignee me|ID] [--creator ID|NAME]
                [--priority NAME] [--project ID|NAME] [--milestone ID|NAME] [--cycle ID|NAME]
                [--parent REF] [--label NAME ...] [--filter JSON] [--search TEXT] [--unblocked]
                [--include-archived] [--first N] [--after CURSOR]
                [--order-by CREATED_ASC|CREATED_DESC|UPDATED_ASC|UPDATED_DESC] [--json]
  pb issue view <REF> [--json]
  pb issue create --team KEY --title TEXT [--description TEXT|-] [--priority NAME]
                  [--assignee me|ID] [--parent REF] [--project ID] [--label NAME ...] [--json]
  pb issue update <REF> [--title TEXT] [--description TEXT|-|none] [--state NAME|TYPE]
                  [--priority NAME] [--assignee me|ID|none] [--parent REF|none]
                  [--project ID|none] [--milestone ID|none] [--cycle ID|NAME|none]
                  [--sort-order NUMBER] [--add-label NAME ...] [--remove-label NAME ...] [--json]
  pb issue archive <REF> [--json]
  pb issue comment <REF> [--body TEXT|-]
  pb issue link <REF> (--blocked-by REF | --blocks REF | --related REF | --duplicate-of REF)... [--json]
  pb issue unlink <REF> (--blocked-by REF | --blocks REF | --related REF | --duplicate-of REF)... [--json]`;

/** Flags de relación → tipo del enum IssueRelationType (desde la perspectiva de <REF>). */
const RELATION_FLAGS = {
  "blocked-by": "BLOCKED_BY",
  blocks: "BLOCKS",
  related: "RELATED",
  "duplicate-of": "DUPLICATE_OF",
} as const;

const RELATION_TEXT: Record<string, string> = {
  BLOCKED_BY: "blocked by",
  BLOCKS: "blocks",
  RELATED: "related to",
  DUPLICATE_OF: "duplicate of",
  DUPLICATED_BY: "duplicated by",
};

export async function issueCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();

  if (action === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        team: { type: "string" },
        state: { type: "string" },
        assignee: { type: "string" },
        creator: { type: "string" },
        priority: { type: "string" },
        project: { type: "string" },
        milestone: { type: "string" },
        cycle: { type: "string" },
        parent: { type: "string" },
        label: { type: "string", multiple: true },
        filter: { type: "string" },
        search: { type: "string" },
        first: { type: "string" },
        after: { type: "string" },
        "order-by": { type: "string" },
        "include-archived": { type: "boolean" },
        json: { type: "boolean" },
        unblocked: { type: "boolean" },
      },
    });
    let filter: Record<string, unknown> = {};
    if (values.filter) {
      try {
        const parsed = JSON.parse(values.filter);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        filter = parsed as Record<string, unknown>;
      } catch {
        throw new UsageError("--filter must be a JSON object");
      }
    }
    let states = null;
    let teamId: string | undefined;
    if (values.team) {
      const team = await resolveTeam(config, values.team);
      teamId = team.id;
      filter.team = { eq: team.id };
      states = team.states;
    }
    if (values.state) {
      const resolved = resolveState(states, values.state);
      if (resolved.stateId) filter.state = { eq: resolved.stateId };
      if (resolved.stateType) filter.stateType = { eq: resolved.stateType };
    }
    if (values.assignee) filter.assignee = { eq: await resolveAssignee(config, values.assignee) };
    if (values.creator) filter.creator = { eq: await resolveActor(config, values.creator) };
    if (values.priority) filter.priority = { eq: priorityFromName(values.priority) };
    let projectId: string | undefined;
    if (values.project) {
      projectId = await resolveProject(config, values.project);
      filter.project = { eq: projectId };
    }
    if (values.milestone)
      filter.milestone = { eq: await resolveMilestone(config, values.milestone, projectId) };
    if (values.cycle) filter.cycle = { eq: await resolveCycle(config, values.cycle, teamId) };
    if (values.parent) filter.parent = { eq: (await resolveIssue(config, values.parent)).id };
    if (values.label?.length) {
      if (!teamId && values.label.some((name) => !/^[0-9a-f-]{36}$/i.test(name))) {
        throw new UsageError("--team is required to resolve labels by name");
      }
      const ids = teamId ? await resolveLabels(config, teamId, values.label) : values.label;
      filter.labels = { includesAll: ids };
    }
    if (values.search) filter.search = values.search;
    if (values.unblocked !== undefined) filter.unblocked = values.unblocked;
    if (values["include-archived"]) filter.includeArchived = true;

    const first = values.first ? Number(values.first) : 50;
    if (!Number.isInteger(first) || first < 1 || first > 250) {
      throw new UsageError("--first must be an integer between 1 and 250");
    }
    const orderBy = values["order-by"]?.toUpperCase();
    const validOrders = ["CREATED_ASC", "CREATED_DESC", "UPDATED_ASC", "UPDATED_DESC"];
    if (orderBy && !validOrders.includes(orderBy)) {
      throw new UsageError(`Invalid --order-by: ${values["order-by"]}`);
    }
    const data = await gqlRequest(
      config,
      `query($filter: IssueFilter, $first: Int, $after: String, $orderBy: IssueOrder) {
      issues(filter: $filter, first: $first, after: $after, orderBy: $orderBy) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }`,
      { filter, first, after: values.after ?? null, orderBy: orderBy ?? null },
    );
    if (values.json) return printJson(data.issues);
    for (const issue of data.issues.nodes) console.log(issueLine(issue));
    if (data.issues.nodes.length === 0) console.log("No issues found.");
    return;
  }

  if (action === "view") {
    const ref = argv[1];
    if (!ref) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `query($id: ID!) {
      issue(id: $id) {
        ${ISSUE_FIELDS}
        children { identifier title state { name } }
        relations { id type relatedIssue { identifier title } }
        comments { body actor { name type } createdAt }
        activity { type actor { name } payload createdAt }
      }
    }`,
      { id: ref },
    );
    if (!data.issue) throw new ApiError(`Issue not found: ${ref}`, "NOT_FOUND");
    if (values.json) return printJson(data.issue);
    const issue = data.issue;
    console.log(issueLine(issue));
    if (issue.creator?.name) console.log(`Created by ${issue.creator.name}`);
    if (issue.description) console.log(`\n${issue.description}`);
    if (issue.children.length > 0) {
      console.log("\nSub-issues:");
      for (const child of issue.children) {
        console.log(`  ${child.identifier}  ${child.state.name}  ${child.title}`);
      }
    }
    if (issue.relations.length > 0) {
      console.log("\nRelations:");
      for (const relation of issue.relations) {
        console.log(
          `  ${RELATION_TEXT[relation.type] ?? relation.type} ${relation.relatedIssue.identifier}  ${relation.relatedIssue.title}`,
        );
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
        team: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string" },
        assignee: { type: "string" },
        parent: { type: "string" },
        project: { type: "string" },
        label: { type: "string", multiple: true },
        number: { type: "string" },
        json: { type: "boolean" },
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

    const data = await gqlRequest(
      config,
      `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { issue { id ${ISSUE_FIELDS} } }
    }`,
      { input },
    );
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
        title: { type: "string" },
        description: { type: "string" },
        state: { type: "string" },
        priority: { type: "string" },
        assignee: { type: "string" },
        parent: { type: "string" },
        project: { type: "string" },
        milestone: { type: "string" },
        cycle: { type: "string" },
        "sort-order": { type: "string" },
        "add-label": { type: "string", multiple: true },
        "remove-label": { type: "string", multiple: true },
        json: { type: "boolean" },
      },
    });
    const issue = await resolveIssue(config, ref);
    const input: Record<string, unknown> = {};
    if (values.title) input.title = values.title;
    if (values.description !== undefined) {
      input.description = values.description === "none" ? null : await readBody(values.description);
    }
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
      input.parentId =
        values.parent === "none" ? null : (await resolveIssue(config, values.parent)).id;
    }
    let projectId: string | undefined;
    if (values.project) {
      projectId =
        values.project === "none" ? undefined : await resolveProject(config, values.project);
      input.projectId = values.project === "none" ? null : projectId;
    }
    if (values.milestone) {
      input.milestoneId =
        values.milestone === "none"
          ? null
          : await resolveMilestone(config, values.milestone, projectId ?? issue.project?.id);
    }
    if (values.cycle) {
      input.cycleId =
        values.cycle === "none" ? null : await resolveCycle(config, values.cycle, issue.team.id);
    }
    if (values["sort-order"] !== undefined) {
      const sortOrder = Number(values["sort-order"]);
      if (!Number.isFinite(sortOrder)) throw new UsageError("--sort-order must be a finite number");
      input.sortOrder = sortOrder;
    }
    if (values["add-label"]?.length) {
      input.addLabelIds = await resolveLabels(config, issue.team.id, values["add-label"]);
    }
    if (values["remove-label"]?.length) {
      input.removeLabelIds = await resolveLabels(config, issue.team.id, values["remove-label"]);
    }
    if (Object.keys(input).length === 0) throw new UsageError("Nothing to update.\n" + USAGE);

    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } }
    }`,
      { id: issue.id, input },
    );
    if (values.json) return printJson(data.issueUpdate.issue);
    console.log(`Updated ${data.issueUpdate.issue.identifier}`);
    console.log(issueLine(data.issueUpdate.issue));
    return;
  }

  if (action === "archive") {
    const ref = argv[1];
    if (!ref) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const issue = await resolveIssue(config, ref);
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { issueArchive(id: $id) { issue { id ${ISSUE_FIELDS} } } }`,
      { id: issue.id },
    );
    if (values.json) return printJson(data.issueArchive.issue);
    console.log(`Archived ${data.issueArchive.issue.identifier}`);
    return;
  }

  if (action === "link" || action === "unlink") {
    const ref = argv[1];
    if (!ref) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        "blocked-by": { type: "string", multiple: true },
        blocks: { type: "string", multiple: true },
        related: { type: "string", multiple: true },
        "duplicate-of": { type: "string", multiple: true },
        json: { type: "boolean" },
      },
    });
    const requests: Array<{ type: string; other: string }> = [];
    for (const [flag, type] of Object.entries(RELATION_FLAGS)) {
      for (const other of (values[flag as keyof typeof RELATION_FLAGS] ?? []) as string[]) {
        requests.push({ type, other });
      }
    }
    if (requests.length === 0) throw new UsageError("Nothing to link.\n" + USAGE);
    const issue = await resolveIssue(config, ref);

    if (action === "link") {
      for (const request of requests) {
        await gqlRequest(
          config,
          `mutation($input: IssueRelationCreateInput!) {
          issueRelationCreate(input: $input) { success }
        }`,
          { input: { issueId: issue.id, relatedIssueId: request.other, type: request.type } },
        );
      }
    } else {
      const current = await gqlRequest(
        config,
        `query($id: ID!) {
        issue(id: $id) { relations { id type relatedIssue { identifier } } }
      }`,
        { id: issue.id },
      );
      for (const request of requests) {
        const other = await resolveIssue(config, request.other);
        const relation = current.issue.relations.find(
          (candidate: any) =>
            (candidate.type === request.type ||
              (request.type === "DUPLICATE_OF" && candidate.type === "DUPLICATED_BY")) &&
            candidate.relatedIssue.identifier === other.identifier,
        );
        if (!relation) {
          throw new ApiError(
            `No ${RELATION_TEXT[request.type]} relation between ${issue.identifier} and ${other.identifier}`,
            "NOT_FOUND",
          );
        }
        await gqlRequest(
          config,
          `mutation($id: ID!) { issueRelationDelete(id: $id) { success } }`,
          { id: relation.id },
        );
      }
    }

    // Salida: el set de relaciones resultante, desde la perspectiva del issue.
    const data = await gqlRequest(
      config,
      `query($id: ID!) {
      issue(id: $id) { identifier relations { id type relatedIssue { identifier title } } }
    }`,
      { id: issue.id },
    );
    if (values.json) return printJson(data.issue.relations);
    console.log(`${action === "link" ? "Linked" : "Unlinked"} ${issue.identifier}`);
    for (const relation of data.issue.relations) {
      console.log(
        `  ${RELATION_TEXT[relation.type] ?? relation.type} ${relation.relatedIssue.identifier}  ${relation.relatedIssue.title}`,
      );
    }
    if (data.issue.relations.length === 0) console.log("  (no relations)");
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
    const data = await gqlRequest(
      config,
      `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        comment { id body actor { name type } issue { identifier } createdAt }
      }
    }`,
      { input: { issueId: ref, body } },
    );
    if (values.json) return printJson(data.commentCreate.comment);
    console.log(`Commented on ${data.commentCreate.comment.issue.identifier}`);
    return;
  }

  throw new UsageError(USAGE);
}
