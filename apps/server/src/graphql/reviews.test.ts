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
      `{ reviews { id status issue { identifier } reviewer { id } } }`,
      {},
      reviewerKey,
    );
    expect(asReviewer.errors).toBeUndefined();
    expect(asReviewer.data!.reviews.some((r: { id: string }) => r.id === review.id)).toBe(true);

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
