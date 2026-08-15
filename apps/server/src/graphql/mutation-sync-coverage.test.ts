// Cierre del despacho de sync (AT-195): tres invariantes que evitan que el
// problema de B (el "olvido silencioso") vuelva a aparecer.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { typeDefs } from "@prime-board/schema";
import { resolvers } from "./resolvers.ts";
import { DISPATCHED, SYNC_EXCLUDED_MUTATIONS } from "./repo-sync-dispatch.ts";

/** Nombres de mutation declarados en el SDL — mismo parseo que usa el resto del repo. */
function mutationNamesFromSchema(): string[] {
  const start = typeDefs.indexOf("type Mutation");
  const block = typeDefs.slice(start, typeDefs.indexOf("`;", start));
  return [...block.matchAll(/^\s{4}(\w+)\(/gm)].map((m) => m[1]!);
}

describe("cobertura del despacho de sync (AT-195)", () => {
  it("el Mutation map que exporta resolvers.ts pasó por withRepoSyncDispatch", () => {
    // Esto es lo que de verdad importa: no que EXISTA el wrapper en algún
    // lado, sino que el objeto que el server realmente usa (resolvers.Mutation,
    // el que arma createSchema) sea su resultado. Si alguien agrega un cuarto
    // archivo de resolvers y lo mergea sin pasar por acá, esta marca desaparece
    // y el test lo detecta — sin tener que enumerar mutations una por una.
    expect((resolvers.Mutation as Record<PropertyKey, unknown>)[DISPATCHED]).toBe(true);
  });

  it("toda mutation del schema tiene un resolver real (ninguna quedó sin implementar)", () => {
    const declared = mutationNamesFromSchema();
    expect(declared.length).toBeGreaterThan(0); // si esto da 0, el parseo se rompió, no el schema
    for (const name of declared) {
      expect(Object.keys(resolvers.Mutation)).toContain(name);
    }
  });

  it("SYNC_EXCLUDED_MUTATIONS son nombres reales del schema (nada de typos ni entradas stale)", () => {
    const declared = new Set(mutationNamesFromSchema());
    for (const excluded of SYNC_EXCLUDED_MUTATIONS) {
      expect(declared.has(excluded)).toBe(true);
    }
  });

  it("ningún resolver de mutation llama a mano a repo?.sync ni a repo?.syncIssue", () => {
    // Guardia estático: el problema original de B era exactamente esto —
    // líneas repetidas a mano en cada resolver. Si alguien las reintroduce
    // por costumbre (en vez de confiar en el despacho), este test lo agarra
    // sin depender de ejecutar la mutation.
    const files = ["resolvers.ts", "issue-resolvers.ts", "project-resolvers.ts"];
    for (const file of files) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect(source).not.toMatch(/context\.repo\?\.\s*(sync|syncIssue)\s*\(/);
    }
  });
});
