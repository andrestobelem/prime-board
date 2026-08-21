// Tests de AT-132: endpoint GraphQL con auth por API key y códigos de error.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "./test-helpers.ts";

const app = createTestApp();
const localApp = createTestApp(undefined, "local");
afterAll(() => {
  app.stop();
  localApp.stop();
});

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

  it("resuelve el viewer sin key en modo local", async () => {
    const result = await gql(localApp, "{ viewer { name type } }", {}, null);
    expect(result.errors).toBeUndefined();
    expect(result.data!.viewer).toEqual({ name: "admin", type: "HUMAN" });

    const updated = await gql(
      localApp,
      `mutation { workspaceUpdate(input: { name: "Local Workspace" }) { success } }`,
      {},
      null,
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data!.workspaceUpdate.success).toBe(true);
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

  it("publica el modo de autenticación para la UI", async () => {
    const response = await fetch(`${localApp.url}/config`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authMode: "local" });
  });
});
