import { describe, expect, it } from "bun:test";
import { createSourceMap, mergeSourceMap, parseSourceMap, type SourceMap } from "./source-map.ts";
import { buildLinearIssuePlan, type LinearIssue } from "./linear-plan.ts";

describe("source map de Linear", () => {
  it("crea un mapa versionado y no guarda credenciales", () => {
    const map = createSourceMap("workspace-1");
    const merged = mergeSourceMap(map, "issues", { "linear-1": "AT-1" });

    expect(merged).toEqual({
      version: 1,
      source: "linear",
      workspaceId: "workspace-1",
      entities: { issues: { "linear-1": "AT-1" } },
    });
    expect(JSON.stringify(merged)).not.toMatch(/secret|hash|api.?key/i);
  });

  it("rechaza mapas con versión, origen o ids inválidos", () => {
    expect(() => parseSourceMap({})).toThrow(/version/);
    expect(() =>
      parseSourceMap({ version: 1, source: "other", workspaceId: "w", entities: {} }),
    ).toThrow(/source/);
    expect(() =>
      parseSourceMap({
        version: 1,
        source: "linear",
        workspaceId: "w",
        entities: { issues: { "": "AT-1" } },
      }),
    ).toThrow(/source id/);
  });
});

describe("buildLinearIssuePlan", () => {
  const issue = (overrides: Partial<LinearIssue> = {}): LinearIssue => ({
    id: "linear-1",
    identifier: "AT-1",
    title: "Issue",
    description: "body",
    ...overrides,
  });

  it("propone create y un mapa estable cuando el identificador está libre", () => {
    const plan = buildLinearIssuePlan([issue()], { existing: [], sourceMap: createSourceMap("w") });
    expect(plan.items).toEqual([
      { sourceId: "linear-1", targetIdentifier: "AT-1", action: "create" },
    ]);
    expect(plan.sourceMap.entities.issues).toEqual({ "linear-1": "AT-1" });
    expect(plan.conflicts).toEqual([]);
  });

  it("propone update para una correspondencia de origen ya conocida", () => {
    const map = mergeSourceMap(createSourceMap("w"), "issues", { "linear-1": "AT-9" });
    const plan = buildLinearIssuePlan([issue({ identifier: "AT-1" })], {
      existing: [{ identifier: "AT-9", sourceId: "linear-1", title: "Old" }],
      sourceMap: map,
    });
    expect(plan.items).toEqual([
      { sourceId: "linear-1", targetIdentifier: "AT-9", action: "update" },
    ]);
    expect(plan.conflicts).toEqual([]);
  });

  it("marca la colisión de namespace sin elegir silenciosamente", () => {
    const plan = buildLinearIssuePlan([issue()], {
      existing: [{ identifier: "AT-1", title: "Otro issue" }],
      sourceMap: createSourceMap("w"),
    });
    expect(plan.items).toEqual([
      { sourceId: "linear-1", targetIdentifier: "AT-1", action: "conflict" },
    ]);
    expect(plan.conflicts).toMatchObject([{ sourceId: "linear-1", code: "IDENTIFIER_COLLISION" }]);
  });

  it("ordena resultados y rechaza ids de origen repetidos", () => {
    const plan = buildLinearIssuePlan(
      [
        issue({ id: "b", identifier: "AT-2" }),
        issue({ id: "a", identifier: "AT-1" }),
        issue({ id: "a", identifier: "AT-3" }),
      ],
      { existing: [], sourceMap: createSourceMap("w") },
    );
    expect(plan.items.map((item) => item.sourceId)).toEqual(["a", "a", "b"]);
    expect(plan.conflicts).toContainEqual(
      expect.objectContaining({ sourceId: "a", code: "DUPLICATE_SOURCE_ID" }),
    );
  });
});
