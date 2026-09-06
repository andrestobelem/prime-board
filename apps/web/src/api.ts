// Cliente GraphQL de la UI. La UI consume exclusivamente /graphql (spec §9).
import { withoutWorkspaceFields } from "@prime-board/graphql-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRequestGate } from "./request-generation.ts";
import {
  clearEffectiveWorkspaceContext,
  clearUiStateWithoutCredential,
  credentialNamespace,
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

function getSelectedWorkspaceIdForRequest(): string | null {
  const key = localStorage.getItem("pb.apiKey")?.trim();
  return localStorage.getItem(`pb.workspace.selection.${key ? credentialNamespace(key) : "local"}`);
}

let workspaceGeneration = 0;

// El gate de Workspace se consulta antes de montar el resto de la UI. Unifica
// el adaptador de requests para que ningún schema legacy valide campos nuevos.
type WorkspaceContractCacheKey = string;
const workspaceContractSupported = new Map<WorkspaceContractCacheKey, boolean>();

export function getWorkspaceContractKey(): WorkspaceContractCacheKey {
  return JSON.stringify(["/graphql", localStorage.getItem("pb.apiKey") ?? ""]);
}

export function setWorkspaceContractSupported(
  supported: boolean,
  key: WorkspaceContractCacheKey = getWorkspaceContractKey(),
): void {
  workspaceContractSupported.set(key, supported);
}

export function getWorkspaceContractSupported(
  key: WorkspaceContractCacheKey = getWorkspaceContractKey(),
): boolean | null {
  return workspaceContractSupported.get(key) ?? null;
}

/** Invalidates in-flight UI work before changing the effective Workspace. */
export function invalidateWorkspaceContext(): void {
  workspaceGeneration += 1;
  clearEffectiveWorkspaceContext();
  notifyDataChanged();
}

export function getWorkspaceGeneration(): number {
  return workspaceGeneration;
}

export async function gql<T = any>(
  query: string,
  variables: Record<string, unknown> = {},
  options: { signal?: AbortSignal; workspaceHeader?: boolean } = {},
): Promise<T> {
  const contractSupported = getWorkspaceContractSupported();
  const workspaceId =
    options.workspaceHeader === false || contractSupported === false
      ? null
      : getSelectedWorkspaceIdForRequest();
  const requestQuery = contractSupported === false ? withoutWorkspaceFields(query) : query;
  const requestCredentialGeneration = getCredentialGeneration();
  const requestWorkspaceGeneration = getWorkspaceGeneration();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${getApiKey()}`,
  };
  if (workspaceId) headers["x-workspace-id"] = workspaceId;
  const response = await fetch("/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query: requestQuery, variables }),
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
  if (
    resolved?.viewer?.id &&
    resolved?.workspace?.id &&
    requestCredentialGeneration === getCredentialGeneration() &&
    requestWorkspaceGeneration === getWorkspaceGeneration() &&
    workspaceId === getSelectedWorkspaceIdForRequest()
  ) {
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
  refetch: () => Promise<void>;
}

export function useQuery<T = any>(
  query: string,
  variables: Record<string, unknown> = {},
  options: { enabled?: boolean } = {},
): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<GqlError | null>(null);
  const [loading, setLoading] = useState(true);
  const key = JSON.stringify(variables);
  const enabled = options.enabled !== false;
  const requestGate = useRef(createRequestGate());
  const authGeneration = useRef(getCredentialGeneration());
  const workspaceGenerationRef = useRef(getWorkspaceGeneration());
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback((): Promise<void> => {
    if (!enabled) return Promise.resolve();
    const generation = requestGate.current.next();
    const requestAuthGeneration = getCredentialGeneration();
    const requestWorkspaceGeneration = getWorkspaceGeneration();
    if (requestAuthGeneration !== authGeneration.current) {
      setData(null);
      setError(null);
    }
    if (requestWorkspaceGeneration !== workspaceGenerationRef.current) {
      // Nunca mostrar resultados del Workspace anterior mientras se resuelve el nuevo.
      setData(null);
      setError(null);
    }
    authGeneration.current = requestAuthGeneration;
    workspaceGenerationRef.current = requestWorkspaceGeneration;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    return gql<T>(query, JSON.parse(key), { signal: controller.signal })
      .then((result) => {
        if (
          !requestGate.current.isCurrent(generation) ||
          authGeneration.current !== getCredentialGeneration() ||
          requestAuthGeneration !== getCredentialGeneration() ||
          requestWorkspaceGeneration !== getWorkspaceGeneration()
        )
          return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (
          !requestGate.current.isCurrent(generation) ||
          requestAuthGeneration !== getCredentialGeneration() ||
          requestWorkspaceGeneration !== getWorkspaceGeneration() ||
          (err as { name?: string }).name === "AbortError"
        )
          return;
        const queryError = err instanceof GqlError ? err : new GqlError(String(err));
        setError(queryError);
        throw queryError;
      })
      .finally(() => {
        if (
          requestGate.current.isCurrent(generation) &&
          requestAuthGeneration === getCredentialGeneration() &&
          requestWorkspaceGeneration === getWorkspaceGeneration()
        )
          setLoading(false);
      });
  }, [enabled, query, key]);

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setError(null);
    void run().catch(() => undefined);
    const refresh = () => {
      void run().catch(() => undefined);
    };
    listeners.add(refresh);
    return () => {
      listeners.delete(refresh);
      requestGate.current.next();
      abortRef.current?.abort();
    };
  }, [enabled, run]);

  return { data, error, loading, refetch: run };
}

/** Permite omitir la invalidación global cuando la vista hará un refresco dirigido. */
export interface MutateOptions {
  notify?: boolean;
}

export async function mutate<T = any>(
  query: string,
  variables: Record<string, unknown> = {},
  options: MutateOptions = {},
): Promise<T> {
  const result = await gql<T>(query, variables);
  if (options.notify !== false) notifyDataChanged();
  return result;
}
