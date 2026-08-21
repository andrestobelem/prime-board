// Cliente GraphQL de la UI. La UI consume exclusivamente /graphql (spec §9).
import { useCallback, useEffect, useRef, useState } from "react";
import { createRequestGate } from "./request-generation.ts";
import {
  clearUiStateWithoutCredential,
  prepareCredentialChange,
  setEffectiveWorkspaceContext,
  type EffectiveWorkspaceContext,
} from "./ui-context.ts";

export type ServerAuthMode = "api-key" | "local";

export async function getServerAuthMode(): Promise<ServerAuthMode> {
  try {
    const response = await fetch("/config", { cache: "no-store" });
    if (!response.ok) return "api-key";
    const payload = (await response.json()) as { authMode?: unknown };
    return payload.authMode === "local" ? "local" : "api-key";
  } catch {
    // Older or external servers do not expose /config; keep the safe default.
    return "api-key";
  }
}

export function getApiKey(): string {
  clearUiStateWithoutCredential();
  return localStorage.getItem("pb.apiKey") ?? "";
}

let credentialGeneration = 0;

export function getCredentialGeneration(): number {
  return credentialGeneration;
}

export function setApiKey(key: string): void {
  const next = key.trim();
  const previous = localStorage.getItem("pb.apiKey") ?? "";
  if (previous !== next) {
    credentialGeneration += 1;
    prepareCredentialChange(previous, next);
  }
  if (next) localStorage.setItem("pb.apiKey", next);
  else localStorage.removeItem("pb.apiKey");
  if (previous !== next) notifyDataChanged();
}

/** Stores the server-resolved Workspace + viewer identity after credential validation. */
export function setApiContext(context: EffectiveWorkspaceContext): void {
  setEffectiveWorkspaceContext(context);
}

export class GqlError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function gql<T = any>(
  query: string,
  variables: Record<string, unknown> = {},
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch("/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal: options.signal,
  });
  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  if (payload.errors?.length) {
    const first = payload.errors[0]!;
    throw new GqlError(first.message, first.extensions?.code);
  }
  const resolved = payload.data as any;
  if (resolved?.viewer?.id && resolved?.workspace?.id) {
    setApiContext({
      workspaceId: resolved.workspace.id,
      workspaceName: resolved.workspace.name,
      workspaceUrlKey: resolved.workspace.urlKey,
      actorId: resolved.viewer.id,
      actorName: resolved.viewer.name,
      actorType: resolved.viewer.type,
    });
  }
  return payload.data as T;
}

// Bus mínimo: tras cada mutación se refetchean todas las queries montadas.
const listeners = new Set<() => void>();

export function notifyDataChanged(): void {
  for (const listener of listeners) listener();
}

export interface QueryState<T> {
  data: T | null;
  error: GqlError | null;
  loading: boolean;
  refetch: () => void;
}

export function useQuery<T = any>(
  query: string,
  variables: Record<string, unknown> = {},
): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<GqlError | null>(null);
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(variables);
  const requestGate = useRef(createRequestGate());
  const authGeneration = useRef(getCredentialGeneration());
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(() => {
    const generation = requestGate.current.next();
    const requestAuthGeneration = getCredentialGeneration();
    if (requestAuthGeneration !== authGeneration.current) {
      // No deben quedar visibles issues, favoritos o Inbox obsoletos mientras carga la nueva key.
      setData(null);
      setError(null);
    }
    authGeneration.current = requestAuthGeneration;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    gql<T>(query, JSON.parse(key), { signal: controller.signal })
      .then((result) => {
        if (
          !requestGate.current.isCurrent(generation) ||
          authGeneration.current !== getCredentialGeneration() ||
          requestAuthGeneration !== getCredentialGeneration()
        )
          return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (
          !requestGate.current.isCurrent(generation) ||
          requestAuthGeneration !== getCredentialGeneration() ||
          (err as { name?: string }).name === "AbortError"
        )
          return;
        setError(err instanceof GqlError ? err : new GqlError(String(err)));
      })
      .finally(() => {
        if (
          requestGate.current.isCurrent(generation) &&
          requestAuthGeneration === getCredentialGeneration()
        )
          setLoading(false);
      });
  }, [query, key]);

  useEffect(() => {
    // Variables changing means old data belongs to a different route/filter.
    setData(null);
    setError(null);
    run();
    listeners.add(run);
    return () => {
      listeners.delete(run);
      requestGate.current.next();
      abortRef.current?.abort();
    };
  }, [run]);

  return { data, error, loading, refetch: run };
}

export async function mutate<T = any>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const result = await gql<T>(query, variables);
  notifyDataChanged();
  return result;
}
