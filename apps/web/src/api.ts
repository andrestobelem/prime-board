// Cliente GraphQL de la UI. La UI consume exclusivamente /graphql (spec §9).
import { useCallback, useEffect, useState } from "react";

export function getApiKey(): string {
  return localStorage.getItem("pb.apiKey") ?? "";
}

export function setApiKey(key: string): void {
  localStorage.setItem("pb.apiKey", key);
}

export class GqlError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export async function gql<T = any>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch("/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({ query, variables }),
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

  const run = useCallback(() => {
    gql<T>(query, JSON.parse(key))
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err: GqlError) => setError(err))
      .finally(() => setLoading(false));
  }, [query, key]);

  useEffect(() => {
    setLoading(true);
    run();
    listeners.add(run);
    return () => {
      listeners.delete(run);
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
