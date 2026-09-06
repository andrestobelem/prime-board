// Punto único de despacho de sync para las mutations (AT-191, candidato B del
// architecture review de AT-181/AT-182..190).
//
// El despacho reserva el lock del Repository Source antes del resolver. La
// reserva vive hasta que terminan resolver, append, commit y export; solo
// entonces retira una captura histórica de Documents. Si el resolver falla,
// aborta la reserva y conserva la captura.
import type { RepoSync, RepoSyncLease } from "../export/repo-sync.ts";

/**
 * Mutations que a propósito nunca tocan el repo: secretos o estado personal
 * excluido de la réplica (ADR-0004).
 */
export const SYNC_EXCLUDED_MUTATIONS: ReadonlySet<string> = new Set([
  "apiKeyCreate",
  "apiKeyDelete",
  "webhookCreate",
  "webhookDelete",
  "inboxMarkRead",
  "inboxArchive",
]);

export interface TrackedRepoSync extends RepoSync {
  /** Verifica y reserva fuentes retiradas antes del resolver. */
  preflight(): void;
  /** ¿Se llamó a sync()/syncIssue() desde que se reseteó el rastreo? */
  wasCalled(): boolean;
  /** Completa la reserva después de que resolver y sync terminaron bien. */
  complete(): void;
  /** Libera la reserva sin retirar una captura. */
  abort(): void;
  /** Reinicia el rastreo — se llama antes de cada mutation top-level. */
  reset(): void;
}

function isRepoSyncLease(value: RepoSyncLease | void): value is RepoSyncLease {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.complete === "function" &&
    typeof value.abort === "function",
  );
}

/**
 * Envuelve un RepoSync para rastrear si se lo usó y conservar su reserva por
 * request. Las implementaciones antiguas que devuelven `void` desde preflight
 * siguen funcionando; el RepoSync real devuelve un lease.
 */
export function trackedRepoSync(repo: RepoSync): TrackedRepoSync {
  let called = false;
  let lease: RepoSyncLease | undefined;
  const abortLease = () => {
    const current = lease;
    lease = undefined;
    current?.abort();
  };
  return {
    root: repo.root,
    preflight() {
      abortLease();
      const candidate = repo.preflight();
      lease = isRepoSyncLease(candidate) ? candidate : undefined;
    },
    sync() {
      called = true;
      repo.sync(lease);
    },
    syncIssue(issueId: string) {
      called = true;
      repo.syncIssue(issueId, lease);
    },
    complete() {
      const current = lease;
      if (!current) return;
      try {
        current.complete();
        lease = undefined;
      } catch (error) {
        lease = undefined;
        current.abort();
        throw error;
      }
    },
    abort: abortLease,
    wasCalled: () => called,
    reset: () => {
      called = false;
      abortLease();
    },
  };
}

// Firma laxa a propósito: cada resolver de Mutation tiene su propio tipo de
// `args` (issueCreate, teamUpdate, etc no comparten forma) — el wrapper no
// necesita conocerla, solo reenviar los argumentos tal cual llegaron.
type AnyResolver = (...args: any[]) => unknown;

/**
 * Envuelve cada resolver del Mutation map. El resolver corre dentro de la
 * reserva del Repository Source. Al terminar, dispara un sync() de respaldo
 * si el resolver no sincronizó nada y completa la reserva. Un rechazo siempre
 * aborta antes de devolver el error a GraphQL.
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
      try {
        // La reserva se toma antes de que el resolver pueda escribir SQLite o
        // emitir Activity/eventos canónicos.
        tracker.preflight();
      } catch (error) {
        tracker.abort();
        throw error;
      }
      const finish = () => {
        if (!tracker.wasCalled()) tracker.sync();
        tracker.complete();
      };
      const fail = (error: unknown): never => {
        tracker.abort();
        throw error;
      };
      let result: unknown;
      try {
        result = resolver(...callArgs);
      } catch (error) {
        return fail(error);
      }
      if (result && typeof (result as Promise<unknown>)?.then === "function") {
        return (result as Promise<unknown>).then(
          (value) => {
            try {
              finish();
              return value;
            } catch (error) {
              return fail(error);
            }
          },
          (error) => fail(error),
        );
      }
      try {
        finish();
        return result;
      } catch (error) {
        return fail(error);
      }
    };
  }
  Object.defineProperty(wrapped, DISPATCHED, { value: true, enumerable: false });
  return wrapped as T;
}
