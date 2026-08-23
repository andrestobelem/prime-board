// PRB-205: reviews — solicitar, actualizar estado y listar cola del viewer.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("reviews", () => {
  it("crea una revisión, la lista en la cola del reviewer y cambia estado", async () => {
    const reviewer = await gql(
      app,
      `mutation { actorCreate(input: { name: "reviewer-agent", type: AGENT }) { actor { id } } }`,
    );
    const reviewerId = reviewer.data!.actorCreate.actor.id;
    const keyResult = await gql(
      app,
      `mutation($actorId: ID!) {
        apiKeyCreate(input: { actorId: $actorId, name: "rev" }) { key }
      }`,
      { actorId: reviewerId },
    );
    const reviewerKey = keyResult.data!.apiKeyCreate.key;

    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Needs review" }) {
        issue { id identifier }
      } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id;
    const identifier = issue.data!.issueCreate.issue.identifier;
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    await gql(
      app,
      `mutation($teamId: ID!, $actorId: ID!) {
        teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: MEMBER }) { success }
      }`,
      { teamId: team.data!.team.id, actorId: reviewerId },
    );

    const created = await gql(
      app,
      `
      mutation($input: ReviewCreateInput!) {
        reviewCreate(input: $input) {
          success
          review {
            id
            status
            issue { identifier }
            requester { name }
            reviewer { id name }
          }
        }
      }
    `,
      {
        input: {
          issueId,
          reviewerId,
        },
      },
    );

    expect(created.errors).toBeUndefined();
    const review = created.data!.reviewCreate.review;
    expect(review).toMatchObject({
      status: "REQUESTED",
      issue: { identifier },
      requester: { name: "admin" },
      reviewer: { id: reviewerId, name: "reviewer-agent" },
    });

    const asReviewer = await gql(
      app,
      `{ reviews { nodes { id status issue { identifier } reviewer { id } } pageInfo { hasNextPage endCursor } } }`,
      {},
      reviewerKey,
    );
    expect(asReviewer.errors).toBeUndefined();
    expect(asReviewer.data!.reviews.nodes.some((r: { id: string }) => r.id === review.id)).toBe(
      true,
    );

    const approved = await gql(
      app,
      `mutation($id: ID!) {
        reviewUpdate(id: $id, input: { status: APPROVED }) {
          review { id status }
        }
      }`,
      { id: review.id },
      reviewerKey,
    );
    expect(approved.data!.reviewUpdate.review).toEqual({ id: review.id, status: "APPROVED" });
  });

  it("requiere membership del team para crear, consultar y actualizar", async () => {
    const outsider = await gql(
      app,
      `mutation { actorCreate(input: { name: "review-outsider", type: AGENT }) { actor { id } } }`,
    );
    const outsiderId = outsider.data!.actorCreate.actor.id;
    const outsiderKeyResult = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "outsider-review" }) { key } }`,
      { actorId: outsiderId },
    );
    const outsiderKey = outsiderKeyResult.data!.apiKeyCreate.key;
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Membership review" }) { issue { id } } }`,
    );

    const rejected = await gql(
      app,
      `mutation($issueId: ID!, $reviewerId: ID!) {
        reviewCreate(input: { issueId: $issueId, reviewerId: $reviewerId }) { success }
      }`,
      { issueId: issue.data!.issueCreate.issue.id, reviewerId: outsiderId },
      outsiderKey,
    );
    expect(rejected.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const member = await gql(
      app,
      `mutation { actorCreate(input: { name: "review-member", type: AGENT }) { actor { id } } }`,
    );
    const memberId = member.data!.actorCreate.actor.id;
    const memberKeyResult = await gql(
      app,
      `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "member-review" }) { key } }`,
      { actorId: memberId },
    );
    const memberKey = memberKeyResult.data!.apiKeyCreate.key;
    const team = await gql(app, `{ team(key: "PB") { id } }`);
    const membership = await gql(
      app,
      `mutation($teamId: ID!, $actorId: ID!) {
        teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: MEMBER }) {
          membership { id }
        }
      }`,
      { teamId: team.data!.team.id, actorId: memberId },
    );

    const created = await gql(
      app,
      `mutation($issueId: ID!, $reviewerId: ID!) {
        reviewCreate(input: { issueId: $issueId, reviewerId: $reviewerId }) {
          review { id status }
        }
      }`,
      { issueId: issue.data!.issueCreate.issue.id, reviewerId: memberId },
      memberKey,
    );
    expect(created.errors).toBeUndefined();
    const reviewId = created.data!.reviewCreate.review.id;

    const approved = await gql(
      app,
      `mutation($id: ID!) { reviewUpdate(id: $id, input: { status: APPROVED }) { review { status } } }`,
      { id: reviewId },
      memberKey,
    );
    expect(approved.errors).toBeUndefined();
    expect(approved.data!.reviewUpdate.review.status).toBe("APPROVED");

    const adminUpdated = await gql(
      app,
      `mutation($id: ID!) { reviewUpdate(id: $id, input: { status: REJECTED }) { review { status } } }`,
      { id: reviewId },
    );
    expect(adminUpdated.errors).toBeUndefined();
    expect(adminUpdated.data!.reviewUpdate.review.status).toBe("REJECTED");

    await gql(app, `mutation($id: ID!) { teamMembershipDelete(id: $id) { success } }`, {
      id: membership.data!.teamMembershipCreate.membership.id,
    });
    const revoked = await gql(
      app,
      `mutation($id: ID!) { reviewUpdate(id: $id, input: { status: REJECTED }) { success } }`,
      { id: reviewId },
      memberKey,
    );
    expect(revoked.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const hidden = await gql(
      app,
      `query($id: ID!) { review(id: $id) { id } }`,
      { id: reviewId },
      memberKey,
    );
    expect(hidden.data!.review).toBeNull();
  });

  it("pagina una cola de más de 50 Reviews con cursor estable", async () => {
    const reviewer = await gql(
      app,
      `mutation { actorCreate(input: { name: "review-page-agent", type: AGENT }) { actor { id } } }`,
    );
    const reviewerId = reviewer.data!.actorCreate.actor.id;
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "Review pagination target" }) { issue { id } } }`,
    );
    const issueId = issue.data!.issueCreate.issue.id;
    const requester = app.db.query("SELECT id FROM actors WHERE name = 'admin' LIMIT 1").get() as {
      id: string;
    };
    const workspace = app.db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string };
    const insert = app.db.query(
      `INSERT INTO reviews
       (id, issue_id, requester_id, reviewer_id, status, created_at, updated_at, workspace_id)
       VALUES (?1, ?2, ?3, ?4, 'requested', ?5, ?5, ?6)`,
    );
    app.db.transaction(() => {
      for (let index = 0; index < 51; index += 1) {
        const createdAt = `2030-01-01T00:${String(index).padStart(2, "0")}:00.000Z`;
        insert.run(
          `review-page-${index}`,
          issueId,
          requester.id,
          reviewerId,
          createdAt,
          workspace.id,
        );
      }
    })();

    const first = await gql(
      app,
      `query($first: Int!, $reviewerId: ID!) {
        reviews(first: $first, reviewerId: $reviewerId) {
          nodes { id createdAt }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: 50, reviewerId },
    );
    expect(first.errors).toBeUndefined();
    expect(first.data!.reviews.nodes).toHaveLength(50);
    expect(first.data!.reviews.nodes[0].id).toBe("review-page-50");
    expect(first.data!.reviews.nodes[49].id).toBe("review-page-1");
    expect(first.data!.reviews.pageInfo.hasNextPage).toBe(true);

    const second = await gql(
      app,
      `query($first: Int!, $after: String!, $reviewerId: ID!) {
        reviews(first: $first, after: $after, reviewerId: $reviewerId) {
          nodes { id createdAt }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      {
        first: 50,
        after: first.data!.reviews.pageInfo.endCursor,
        reviewerId,
      },
    );
    expect(second.errors).toBeUndefined();
    expect(second.data!.reviews.nodes.map((node: { id: string }) => node.id)).toEqual([
      "review-page-0",
    ]);
    expect(second.data!.reviews.pageInfo.hasNextPage).toBe(false);

    const changedFilter = await gql(
      app,
      `query($after: String!, $reviewerId: ID!) {
        reviews(openOnly: true, after: $after, reviewerId: $reviewerId) { nodes { id } }
      }`,
      { after: first.data!.reviews.pageInfo.endCursor, reviewerId },
    );
    expect(changedFilter.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });

  it("rechaza reviewer inexistente", async () => {
    const issue = await gql(
      app,
      `mutation { issueCreate(input: { teamKey: "PB", title: "X" }) { issue { id } } }`,
    );
    const bad = await gql(
      app,
      `mutation($issueId: ID!) {
        reviewCreate(input: { issueId: $issueId, reviewerId: "nope" }) { success }
      }`,
      { issueId: issue.data!.issueCreate.issue.id },
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});
