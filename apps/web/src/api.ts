// Cliente GraphQL de la UI. La UI consume exclusivamente /graphql (spec §9).
import { useCallback, useEffect, useRef, useState } from "react";
import { createRequestGate } from "./request-generation.ts";

export function getApiKey(): string {
  return localStorage.getItem("pb.apiKey") ?? "";
}

export function setApiKey(key: string): void {
  localStorage.setItem("pb.apiKey", key);
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
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(() => {
    const generation = requestGate.current.next();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    gql<T>(query, JSON.parse(key), { signal: controller.signal })
      .then((result) => {
        if (!requestGate.current.isCurrent(generation)) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (
          !requestGate.current.isCurrent(generation) ||
          (err as { name?: string }).name === "AbortError"
        )
          return;
        setError(err instanceof GqlError ? err : new GqlError(String(err)));
      })
      .finally(() => {
        if (requestGate.current.isCurrent(generation)) setLoading(false);
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
