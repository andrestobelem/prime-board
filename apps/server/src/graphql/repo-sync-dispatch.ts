// Punto único de despacho de sync para las mutations (AT-191, candidato B del
// architecture review de AT-181/AT-182..190).
//
// Antes de esto, 22 de las 26 mutations del schema llamaban a mano
// `context.repo?.sync()` o `syncIssue(id)` al final de su resolver, repetido
// en tres archivos (resolvers.ts, issue-resolvers.ts, project-resolvers.ts).
// La garantía de ADR-0004 ("el repo queda al día") dependía de que nadie se
// olvidara la línea — nada avisaba si una mutation nueva lo hacía.
//
// withRepoSyncDispatch envuelve el resolver map de Mutation: si el resolver
// no sincronizó nada por su cuenta durante su ejecución, dispara un sync()
// completo de respaldo al terminar — salvo que la mutation esté en la lista
// explícita de exclusión (los secretos, que ADR-0004 dice que nunca van al
// repo). Convive con las llamadas manuales sin duplicar trabajo: si el
// resolver ya sincronizó (sync() o syncIssue(), completo o dirigido), el
// despacho no hace nada más.
import type { RepoSync } from "../export/repo-sync.ts";

/** Mutations que a propósito nunca tocan el repo — son secretos (ADR-0004). */
export const SYNC_EXCLUDED_MUTATIONS: ReadonlySet<string> = new Set([
  "apiKeyCreate",
  "apiKeyDelete",
  "webhookCreate",
  "webhookDelete",
]);

export interface TrackedRepoSync extends RepoSync {
  /** ¿Se llamó a sync()/syncIssue() desde que se reseteó el rastreo? */
  wasCalled(): boolean;
  /** Reinicia el rastreo — se llama antes de cada mutation top-level. */
  reset(): void;
}

/**
 * Envuelve un RepoSync para rastrear si se lo usó — delega en el repo real,
 * así que el comportamiento de escritura no cambia un bit. Se crea una
 * instancia por contexto de request (ver context.ts/server.ts): dos mutations
 * en el mismo documento no se pisan el rastreo porque GraphQL las ejecuta en
 * serie, no en paralelo (spec de Mutation).
 */
export function trackedRepoSync(repo: RepoSync): TrackedRepoSync {
  let called = false;
  return {
    root: repo.root,
    sync() {
      called = true;
      repo.sync();
    },
    syncIssue(issueId: string) {
      called = true;
      repo.syncIssue(issueId);
    },
    wasCalled: () => called,
    reset: () => {
      called = false;
    },
  };
}

// Firma laxa a propósito: cada resolver de Mutation tiene su propio tipo de
// `args` (issueCreate, teamUpdate, etc no comparten forma) — el wrapper no
// necesita conocerla, solo reenviar los argumentos tal cual llegaron.
type AnyResolver = (...args: any[]) => unknown;

/**
 * Envuelve cada resolver del Mutation map: antes de llamarlo resetea el
 * rastreo, y al terminar (sync u async) dispara un sync() de respaldo si el
 * resolver no sincronizó nada y la mutation no está excluida. El segundo
 * argumento posicional de un resolver GraphQL es siempre `context` (índice 2).
 */
/**
 * Marca no enumerable en el objeto que devuelve withRepoSyncDispatch — así un
 * test puede verificar que el Mutation map que de verdad usa el server pasó
 * por acá, sin depender de leer el código fuente (AT-195).
 */
export const DISPATCHED = Symbol("repoSyncDispatched");

export function withRepoSyncDispatch<T extends Record<string, AnyResolver>>(mutations: T): T {
  const wrapped: Record<string, AnyResolver> = {};
  for (const [name, resolver] of Object.entries(mutations)) {
    wrapped[name] = (...callArgs: unknown[]) => {
      const context = callArgs[2] as { repo: TrackedRepoSync | null } | undefined;
      const tracker = context?.repo;
      if (!tracker || SYNC_EXCLUDED_MUTATIONS.has(name)) {
        return resolver(...callArgs);
      }
      tracker.reset();
      const finish = () => {
        if (!tracker.wasCalled()) tracker.sync();
      };
      const result = resolver(...callArgs);
      if (result && typeof (result as Promise<unknown>)?.then === "function") {
        return (result as Promise<unknown>).then((value) => {
          finish();
          return value;
        });
      }
      finish();
      return result;
    };
  }
  Object.defineProperty(wrapped, DISPATCHED, { value: true, enumerable: false });
  return wrapped as T;
}
