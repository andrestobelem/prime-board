// Tests de AT-132: endpoint GraphQL con auth por API key y códigos de error.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "./test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("http", () => {
  it("expone la raíz y /health", async () => {
    const root = await (await fetch(`${app.url}/`)).json();
    expect(root).toMatchObject({ name: "prime-board", graphql: "/graphql" });
    const health = await (await fetch(`${app.url}/health`)).json();
    expect(health).toEqual({ status: "ok" });
  });
});

describe("graphql auth", () => {
  it("resuelve viewer con una key válida", async () => {
    const result = await gql(app, "{ viewer { name type } workspace { name urlKey } }");
    expect(result.errors).toBeUndefined();
    expect(result.data!.viewer).toEqual({ name: "admin", type: "HUMAN" });
    expect(result.data!.workspace).toEqual({ name: "Prime Board", urlKey: "prime-board" });
  });

  it("rechaza requests sin key con UNAUTHORIZED", async () => {
    const result = await gql(app, "{ viewer { id } }", {}, null);
    expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });

  it("rechaza keys inválidas con UNAUTHORIZED", async () => {
    const result = await gql(app, "{ viewer { id } }", {}, "pb_invalid");
    expect(result.errors?.[0]?.extensions?.code).toBe("UNAUTHORIZED");
  });

  it("sirve GraphiQL en dev", async () => {
    const response = await fetch(`${app.url}/graphql`, {
      headers: { accept: "text/html" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("graphiql");
  });
});
