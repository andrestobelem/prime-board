// Tests de AT-155: búsqueda por prefijo (webhook → webhooks) sin romper
// acentos, frases exactas ni caracteres especiales.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestApp, gql, type TestApp } from "../test-helpers.ts";

let app: TestApp;

beforeAll(async () => {
  app = createTestApp();
  for (const title of [
    "Configure webhooks retry policy",
    "Definición del alcance del MVP",
    "Drag & drop en el board",
    "Webhook signature docs",
  ]) {
    await gql(
      app,
      `mutation($t: String!) { issueCreate(input: { teamKey: "PB", title: $t }) { success } }`,
      { t: title },
    );
  }
});
afterAll(() => app.stop());

const search = async (term: string) => {
  const result = await gql(
    app,
    `query($s: String) { issues(filter: { search: $s }) { nodes { title } } }`,
    { s: term },
  );
  expect(result.errors).toBeUndefined();
  return result.data!.issues.nodes.map((n: any) => n.title).sort();
};

describe("full-text con prefijos", () => {
  it("encuentra plurales y derivados desde el prefijo", async () => {
    expect(await search("webhook")).toEqual([
      "Configure webhooks retry policy",
      "Webhook signature docs",
    ]);
  });

  it("sigue matcheando prefijos parciales", async () => {
    expect(await search("defin")).toEqual(["Definición del alcance del MVP"]);
  });

  it("respeta acentos y mayúsculas", async () => {
    expect(await search("DEFINICIÓN")).toEqual(["Definición del alcance del MVP"]);
    expect(await search("definicion")).toEqual(["Definición del alcance del MVP"]);
  });

  it("trata las comillas del usuario como frase exacta (sin prefijo)", async () => {
    expect(await search('"webhooks retry"')).toEqual(["Configure webhooks retry policy"]);
    // La frase exacta no matchea por prefijo: "webhook retry" no existe literal.
    expect(await search('"webhook retry"')).toEqual([]);
  });

  it("no rompe con caracteres especiales", async () => {
    expect(await search("drag & drop")).toEqual(["Drag & drop en el board"]);
  });

  it("trata entradas FTS vacías o malformadas sin filtrar errores internos", async () => {
    const all = [
      "Configure webhooks retry policy",
      "Definición del alcance del MVP",
      "Drag & drop en el board",
      "Webhook signature docs",
    ].sort();
    expect(await search('""')).toEqual(all);
    expect(await search('"unclosed')).toEqual([]);
    expect(await search("*")).toEqual([]);

    const nested = await gql(
      app,
      `query($s: String) {
        issues(first: 1, filter: { and: [{ search: $s }] }) { nodes { title } }
      }`,
      { s: '""' },
    );
    expect(nested.errors).toBeUndefined();
    expect(nested.data!.issues.nodes).toHaveLength(1);
  });
});
