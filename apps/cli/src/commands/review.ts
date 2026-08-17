// pb review list|view|create|update|delete
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { loadConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";
import { resolveAssignee, resolveTeam } from "../resolve.ts";

const REVIEW_FIELDS = `id status createdAt updatedAt
  issue { id identifier title }
  requester { id name type } reviewer { id name type }`;
const USAGE = `Usage:
  pb review list [--open-only] [--team KEY] [--project ID] [--reviewer ID|me]
                  [--older-than-days N] [--first N] [--json]
  pb review view <ID> [--json]
  pb review create --issue ID --reviewer ID|me [--json]
  pb review update <ID> [--status STATUS] [--reviewer ID|me] [--json]
  pb review delete <ID> [--json]`;

function numberOrUsage(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`Invalid ${label}: ${value}`);
  return parsed;
}

export async function reviewCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();
  if (action === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        "open-only": { type: "boolean" },
        team: { type: "string" },
        project: { type: "string" },
        reviewer: { type: "string" },
        "older-than-days": { type: "string" },
        first: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const variables: Record<string, unknown> = {
      openOnly: Boolean(values["open-only"]),
      first: values.first ? numberOrUsage(values.first, "first") : 50,
      teamId: values.team ? (await resolveTeam(config, values.team)).id : null,
      projectId: values.project ?? null,
      reviewerId: values.reviewer ? await resolveAssignee(config, values.reviewer) : null,
      olderThanDays: values["older-than-days"]
        ? numberOrUsage(values["older-than-days"], "older-than-days")
        : null,
    };
    const data = await gqlRequest(
      config,
      `query($openOnly: Boolean, $first: Int, $teamId: ID, $projectId: ID, $reviewerId: ID, $olderThanDays: Int) {
      reviews(openOnly: $openOnly, first: $first, teamId: $teamId, projectId: $projectId, reviewerId: $reviewerId, olderThanDays: $olderThanDays) { ${REVIEW_FIELDS} }
    }`,
      variables,
    );
    if (values.json) return printJson(data.reviews);
    for (const review of data.reviews)
      console.log(`${review.id}  [${review.status.toLowerCase()}]  ${review.issue.identifier}`);
    if (data.reviews.length === 0) console.log("No reviews found.");
    return;
  }
  if (action === "view") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `query($id: ID!) { review(id: $id) { ${REVIEW_FIELDS} } }`,
      { id },
    );
    if (!data.review) throw new UsageError(`Review not found: ${id}`);
    if (values.json) return printJson(data.review);
    console.log(`${data.review.issue.identifier}  [${data.review.status.toLowerCase()}]`);
    return;
  }
  if (action === "create") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        issue: { type: "string" },
        reviewer: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (!values.issue || !values.reviewer) throw new UsageError(USAGE);
    const reviewerId = await resolveAssignee(config, values.reviewer);
    if (!reviewerId) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($input: ReviewCreateInput!) {
      reviewCreate(input: $input) { review { ${REVIEW_FIELDS} } }
    }`,
      { input: { issueId: values.issue, reviewerId } },
    );
    if (values.json) return printJson(data.reviewCreate.review);
    console.log(`Created review ${data.reviewCreate.review.id}`);
    return;
  }
  if (action === "update") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        status: { type: "string" },
        reviewer: { type: "string" },
        json: { type: "boolean" },
      },
    });
    const input: Record<string, unknown> = {};
    if (values.status !== undefined) input.status = values.status.toUpperCase();
    if (values.reviewer !== undefined) {
      const reviewerId = await resolveAssignee(config, values.reviewer);
      if (!reviewerId) throw new UsageError(USAGE);
      input.reviewerId = reviewerId;
    }
    if (!Object.keys(input).length) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($id: ID!, $input: ReviewUpdateInput!) {
      reviewUpdate(id: $id, input: $input) { review { ${REVIEW_FIELDS} } }
    }`,
      { id, input },
    );
    if (values.json) return printJson(data.reviewUpdate.review);
    console.log(`Updated review ${id}`);
    return;
  }
  if (action === "delete") {
    const id = argv[1];
    if (!id) throw new UsageError(USAGE);
    const { values } = parseArgs({ args: argv.slice(2), options: { json: { type: "boolean" } } });
    const data = await gqlRequest(
      config,
      `mutation($id: ID!) { reviewDelete(id: $id) { success } }`,
      { id },
    );
    if (values.json) return printJson(data.reviewDelete);
    console.log(`Deleted review ${id}`);
    return;
  }
  throw new UsageError(USAGE);
}
