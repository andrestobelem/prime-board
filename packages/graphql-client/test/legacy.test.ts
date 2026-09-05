import { describe, expect, it } from "bun:test";
import { buildSchema, parse, validate } from "graphql";
import { withoutWorkspaceFields } from "../src/index.ts";

const schema = buildSchema(`
  type Query {
    viewer: Viewer!
    thing(workspaceId: ID, workspaceIdentifier: ID, keep: String, label: String): Thing!
  }
  type Viewer { id: ID! workspaceId: ID workspaceIdentifier: ID }
  type Thing { id: ID! }
  type Subscription { events: Event! }
  type Event { id: ID! workspaceId: ID }
`);

describe("legacy GraphQL document transformation", () => {
  it("removes scoped selections, arguments, and unused variables as a valid AST transform", () => {
    const query = `query Legacy(
      $workspaceId: ID!
      $argumentWorkspaceId: ID!
      $include: Boolean!
      $keep: String!
      $workspaceIdentifier: ID!
    ) {
      viewer {
        id
        selected: workspaceId
        workspaceIdentifier
      }
      thing(
        workspaceId: $argumentWorkspaceId
        keep: $keep
        label: "workspaceId"
      ) @include(if: $include) { id }
      other: thing(workspaceIdentifier: $workspaceIdentifier) { id }
    }`;

    const transformed = withoutWorkspaceFields(query);
    const document = parse(transformed);
    expect(validate(schema, document)).toEqual([]);
    expect(transformed).not.toContain("selected: workspaceId");
    expect(transformed).not.toContain("workspaceId: $argumentWorkspaceId");
    expect(transformed).toContain("workspaceIdentifier");
    expect(transformed).toContain('label: "workspaceId"');
    expect(transformed).toContain("@include(if: $include)");
    expect(transformed).not.toContain("$argumentWorkspaceId");
    expect(transformed).not.toMatch(/\$workspaceId\b/);
  });

  it("prunes empty and unreachable fragments while retaining variables in reachable directives", () => {
    const transformed = withoutWorkspaceFields(`
      query Legacy($workspaceId: ID!, $include: Boolean!, $unused: ID!) {
        viewer { ...ViewerFields @include(if: $include) }
      }
      fragment ViewerFields on Viewer {
        id
        selected: workspaceId
      }
      fragment EmptyFields on Viewer { workspaceId }
      fragment UnusedFields on Viewer { workspaceId }
    `);
    const document = parse(transformed);
    expect(validate(schema, document)).toEqual([]);
    expect(transformed).toContain("fragment ViewerFields");
    expect(transformed).toContain("@include(if: $include)");
    expect(transformed).not.toContain("EmptyFields");
    expect(transformed).not.toContain("UnusedFields");
    expect(transformed).not.toMatch(/\$workspaceId\b/);
    expect(transformed).not.toMatch(/\$unused\b/);
  });

  it("keeps nested fragment chains valid when their leaf is removed", () => {
    const transformed = withoutWorkspaceFields(`
      query Legacy { viewer { ...ViewerFields } }
      fragment ViewerFields on Viewer { ...WorkspaceFields }
      fragment WorkspaceFields on Viewer { workspaceId }
    `);
    expect(validate(schema, parse(transformed))).toEqual([]);
  });

  it("rejects subscriptions with no compatible legacy root field", () => {
    expect(() =>
      withoutWorkspaceFields("subscription S($workspaceId: ID!) { workspaceId }"),
    ).toThrow("Legacy subscription has no compatible root fields");
    expect(() => withoutWorkspaceFields("subscription S { events { workspaceId } }")).toThrow(
      "Legacy subscription has no compatible root fields",
    );

    const transformed = withoutWorkspaceFields("subscription S { events { id workspaceId } }");
    expect(validate(schema, parse(transformed))).toEqual([]);
  });

  it("keeps a valid operation when the only root field is workspaceId", () => {
    const transformed = withoutWorkspaceFields("query Legacy($workspaceId: ID!) { workspaceId }");
    expect(validate(schema, parse(transformed))).toEqual([]);
    expect(transformed).toContain("__typename");
    expect(transformed).not.toMatch(/\$workspaceId\b/);
  });
});
