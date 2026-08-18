// Tests de AT-27: preservar fecha y autor originales al importar.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;
let botId: string;
let regularKey: string;

beforeAll(async () => {
  app = createTestApp();
  const bot = await gql(
    app,
    `mutation { actorCreate(input: { name: "legacy-bot", type: AGENT }) { actor { id } } }`,
  );
  botId = bot.data!.actorCreate.actor.id;
  const regular = await gql(
    app,
    `mutation { actorCreate(input: { name: "regular-importer", type: AGENT }) { actor { id } } }`,
  );
  const regularId = regular.data!.actorCreate.actor.id;
  const key = await gql(
    app,
    `mutation($actorId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: "regular" }) { key } }`,
    { actorId: regularId },
  );
  regularKey = key.data!.apiKeyCreate.key;
  const team = await gql(app, `{ team(key: "PB") { id } }`);
  await gql(
    app,
    `mutation($teamId: ID!, $actorId: ID!) {
      teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: MEMBER }) { success }
    }`,
    { teamId: team.data!.team.id, actorId: regularId },
  );
});
afterAll(() => app.stop());

describe("import con fecha y autor originales", () => {
  it("conserva createdAt y creatorId en el issue y en su actividad", async () => {
    const result = await gql(
      app,
      `
      mutation($creatorId: ID!) {
        issueCreate(input: {
          teamKey: "PB", title: "Imported issue",
          createdAt: "2024-03-01T10:00:00.000Z", creatorId: $creatorId
        }) {
          issue { identifier createdAt creator { name } activity { type actor { name } createdAt } }
        }
      }
    `,
      { creatorId: botId },
    );
    const issue = result.data!.issueCreate.issue;
    expect(issue.createdAt).toBe("2024-03-01T10:00:00.000Z");
    expect(issue.creator.name).toBe("legacy-bot");
    // La actividad también queda fechada y atribuida al autor original.
    expect(issue.activity[0]).toMatchObject({
      type: "created",
      actor: { name: "legacy-bot" },
      createdAt: "2024-03-01T10:00:00.000Z",
    });
  });

  it("conserva fecha y autor en comentarios importados", async () => {
    const result = await gql(
      app,
      `
      mutation($authorId: ID!) {
        commentCreate(input: {
          issueId: "PB-1", body: "comentario viejo",
          createdAt: "2024-03-02T11:00:00.000Z", authorId: $authorId
        }) {
          comment { createdAt actor { name } }
        }
      }
    `,
      { authorId: botId },
    );
    expect(result.data!.commentCreate.comment).toEqual({
      createdAt: "2024-03-02T11:00:00.000Z",
      actor: { name: "legacy-bot" },
    });
  });

  it("rechaza overrides de identidad, número y fecha para actores regulares", async () => {
    const forgedIssue = await gql(
      app,
      `mutation($creatorId: ID!) {
        issueCreate(input: {
          teamKey: "PB", title: "forged issue", number: 9001,
          creatorId: $creatorId, createdAt: "2020-01-01T00:00:00.000Z"
        }) { success }
      }`,
      { creatorId: botId },
      regularKey,
    );
    expect(forgedIssue.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");

    const absent = await gql(app, `{ issue(id: "PB-9001") { id } }`, {}, regularKey);
    expect(absent.data!.issue).toBeNull();

    const forgedComment = await gql(
      app,
      `mutation($authorId: ID!) {
        commentCreate(input: {
          issueId: "PB-1", body: "forged comment",
          authorId: $authorId, createdAt: "2020-01-02T00:00:00.000Z"
        }) { success }
      }`,
      { authorId: botId },
      regularKey,
    );
    expect(forgedComment.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
    const comments = await gql(app, `{ issue(id: "PB-1") { comments { body } } }`);
    expect(
      comments.data!.issue.comments.some(
        (comment: { body: string }) => comment.body === "forged comment",
      ),
    ).toBe(false);
  });

  it("sin overrides usa ahora y el actor de la key", async () => {
    const result = await gql(
      app,
      `
      mutation { issueCreate(input: { teamKey: "PB", title: "Normal" }) { issue { creator { name } createdAt } } }
    `,
    );
    expect(result.data!.issueCreate.issue.creator.name).toBe("admin");
    expect(Date.parse(result.data!.issueCreate.issue.createdAt)).toBeGreaterThan(
      Date.parse("2025-01-01"),
    );
  });

  it("valida fecha y autor", async () => {
    const badDate = await gql(
      app,
      `
      mutation { issueCreate(input: { teamKey: "PB", title: "x", createdAt: "ayer" }) { success } }
    `,
    );
    expect(badDate.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const badActor = await gql(
      app,
      `
      mutation { issueCreate(input: { teamKey: "PB", title: "x", creatorId: "nope" }) { success } }
    `,
    );
    expect(badActor.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
});
