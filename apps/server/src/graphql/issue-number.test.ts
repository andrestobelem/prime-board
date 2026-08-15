// Tests de AT-32 (dogfood): número explícito en issueCreate para imports.
import { afterAll, describe, expect, it } from "bun:test";
import { createTestApp, gql } from "../test-helpers.ts";

const app = createTestApp();
afterAll(() => app.stop());

describe("issueCreate con number explícito", () => {
  it("conserva el identificador pedido y ajusta la numeración siguiente", async () => {
    const imported = await gql(app, `
      mutation { issueCreate(input: { teamKey: "PB", title: "Imported", number: 126 }) { issue { identifier } } }
    `);
    expect(imported.data!.issueCreate.issue.identifier).toBe("PB-126");

    // la numeración automática continúa después del número fijado
    const next = await gql(app, `
      mutation { issueCreate(input: { teamKey: "PB", title: "Auto" }) { issue { identifier } } }
    `);
    expect(next.data!.issueCreate.issue.identifier).toBe("PB-127");
  });

  it("permite rellenar números menores sin romper la secuencia", async () => {
    const gap = await gql(app, `
      mutation { issueCreate(input: { teamKey: "PB", title: "Backfill", number: 5 }) { issue { identifier } } }
    `);
    expect(gap.data!.issueCreate.issue.identifier).toBe("PB-5");
    const auto = await gql(app, `
      mutation { issueCreate(input: { teamKey: "PB", title: "Auto 2" }) { issue { identifier } } }
    `);
    expect(auto.data!.issueCreate.issue.identifier).toBe("PB-128");
  });

  it("rechaza números tomados o inválidos", async () => {
    const dup = await gql(app, `
      mutation { issueCreate(input: { teamKey: "PB", title: "Dup", number: 126 }) { success } }
    `);
    expect(dup.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
    const bad = await gql(app, `
      mutation { issueCreate(input: { teamKey: "PB", title: "Bad", number: 0 }) { success } }
    `);
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION_FAILED");
  });
});
