import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import type {
  RuntimeStatus,
  RuntimeDependencies,
  ProjectCredential,
  FetchLike,
} from "./runtime.ts";
import {
  clearGitEnvironment,
  createRuntimeController,
  projectCredentialPath,
  readProjectCredential,
  saveProjectCredential,
} from "./runtime.ts";

export type NotificationLevel = "info" | "warning" | "error";

type SessionEvent = { reason?: string };

type ExtensionContext = {
  cwd: string;
  hasUI?: boolean;
  sessionManager?: { getEntries(): readonly unknown[] };
  ui: { notify(message: string, level: NotificationLevel): void };
};

type CommandContext = ExtensionContext & {
  reload?: () => Promise<void>;
};

type ToolResult = {
  content: [{ type: "text"; text: string }];
  details: RuntimeStatus;
};

type ExtensionAPI = {
  on?: (
    event: "session_start" | "session_shutdown",
    handler: (event: SessionEvent, ctx: ExtensionContext) => unknown,
  ) => void;
  /** Disponible en el runtime de Prime Agent que admite nombres persistentes. */
  setSessionName?: (name: string) => void | Promise<void>;
  /** Persiste una entrada propia de la extensión en la sesión actual. */
  appendEntry?: (customType: string, data?: unknown) => void;
  registerCommand(
    name: string,
    definition: {
      description: string;
      handler: (args: string, ctx: CommandContext) => void | Promise<void>;
    },
  ): void;
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, never>; additionalProperties: false };
    execute: (
      toolCallId: string,
      params: Record<string, never>,
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ) => Promise<ToolResult>;
  }): void;
};

export type PrimeBoardStatus = {
  projectRoot: string | null;
  url: string;
  state: "healthy" | "unavailable";
  detail: string;
};

const DEFAULT_URL = "http://localhost:3333";
const HEALTH_TIMEOUT_MS = 1_000;

/** Descubre el proyecto Git que contiene el directorio de trabajo. */
export function discoverPrimeBoardProject(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    env: clearGitEnvironment(environment),
  });
  if (result.status !== 0 || result.error) return null;
  const root = result.stdout.trim();
  return root || null;
}

/** Comprueba el servidor local configurado sin iniciarlo. */
export async function getPrimeBoardStatus(
  cwd: string,
  url = process.env.PRIME_BOARD_URL || DEFAULT_URL,
): Promise<PrimeBoardStatus> {
  const projectRoot = discoverPrimeBoardProject(cwd);
  let healthUrl: string;
  try {
    healthUrl = new URL("/health", url).toString();
  } catch {
    return { projectRoot, url, state: "unavailable", detail: "Invalid server URL" };
  }

  if (!projectRoot) {
    return {
      projectRoot,
      url,
      state: "unavailable",
      detail: "Current directory is not inside a Git project",
    };
  }

  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!response.ok) {
      return {
        projectRoot,
        url,
        state: "unavailable",
        detail: `Server returned HTTP ${response.status}`,
      };
    }
    return { projectRoot, url, state: "healthy", detail: "Server is healthy" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Health check failed";
    return { projectRoot, url, state: "unavailable", detail };
  }
}

function formatStatus(status: RuntimeStatus): string {
  const project = status.projectRoot || "Git project not found";
  const url = status.url ? ` URL: ${status.url}.` : "";
  return `prime-board ${status.state}: ${status.detail}.${url} Project: ${project}.`;
}

function commandUsage(): string {
  return "Usage: /prime-board [start|status|open|logs [lines]|stop|auth]";
}

function notifyRuntime(ctx: ExtensionContext, status: RuntimeStatus): void {
  ctx.ui.notify(
    formatStatus(status),
    status.state === "running" ? "info" : status.state === "error" ? "error" : "warning",
  );
}

type JsonObject = { [key: string]: unknown };

type ActorIdentity = {
  id: string;
  name: string;
  type: "AGENT" | "HUMAN";
};

type ActorBinding = Pick<ActorIdentity, "id" | "name">;

type ProjectCredentialSource = "environment" | "stored";

const ACTOR_BINDING_ENTRY = "prime-board-actor-binding";

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function projectAgentName(projectRoot: string): string {
  const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  const project =
    basename(projectRoot)
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .slice(0, 40) || "project";
  return `prime-agent-${project}-${hash}`;
}

async function graphqlData(
  url: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: FetchLike,
): Promise<JsonObject> {
  let response: Response;
  try {
    response = await fetchImpl(`${url.replace(/\/$/, "")}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error("Cannot reach the prime-board GraphQL endpoint.");
  }
  const payload: unknown = await response.json().catch(() => null);
  const object = asObject(payload);
  const errors = object?.errors;
  if (!response.ok || (Array.isArray(errors) && errors.length > 0)) {
    throw new Error("The prime-board credential was rejected by GraphQL.");
  }
  const data = asObject(object?.data);
  if (!data) throw new Error("The prime-board GraphQL response has no data.");
  return data;
}

function actorType(value: unknown): ActorIdentity["type"] | null {
  const type = asString(value)?.toUpperCase();
  return type === "AGENT" || type === "HUMAN" ? type : null;
}

function actorIdentityFromData(data: JsonObject): ActorIdentity | null {
  const viewer = asObject(data.viewer);
  const id = asString(viewer?.id);
  const name = asString(viewer?.name);
  const type = actorType(viewer?.type);
  return id && name && type ? { id, name, type } : null;
}

async function viewerType(
  url: string,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<"AGENT" | "HUMAN" | null> {
  const data = await graphqlData(url, apiKey, "query { viewer { type } }", {}, fetchImpl);
  return actorType(asObject(data.viewer)?.type);
}

async function viewerIdentity(
  url: string,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<ActorIdentity | null> {
  const data = await graphqlData(url, apiKey, "query { viewer { id name type } }", {}, fetchImpl);
  return actorIdentityFromData(data);
}

function sessionActorBinding(ctx: ExtensionContext): ActorBinding | null {
  const entries = ctx.sessionManager?.getEntries();
  if (!entries) return null;
  for (const entry of [...entries].reverse()) {
    const object = asObject(entry);
    if (object?.customType !== ACTOR_BINDING_ENTRY) continue;
    const data = asObject(object.data);
    const id = asString(data?.actorId);
    const name = asString(data?.actorName);
    if (id && name) return { id, name };
  }
  return null;
}

function sessionHasAssistant(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager?.getEntries();
  if (!entries) return true;
  return entries.some((entry) => {
    const object = asObject(entry);
    const message = asObject(object?.message);
    return object?.type === "message" && message?.role === "assistant";
  });
}

async function bindSessionToActor(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  authenticated: ActorIdentity,
): Promise<void> {
  if (authenticated.type !== "AGENT") {
    throw new Error("The authenticated prime-board Actor has no stable AGENT identity.");
  }
  const previous = sessionActorBinding(ctx);
  if (previous && previous.id !== authenticated.id) {
    throw new Error(
      `The session is bound to Actor ${previous.id}, not authenticated Actor ${authenticated.id}.`,
    );
  }
  if (!ctx.sessionManager || !pi.setSessionName || !pi.appendEntry) {
    throw new Error(
      "The installed Prime Agent runtime must expose pi.setSessionName, pi.appendEntry, and ctx.sessionManager.getEntries() to bind a session to its authenticated Actor.",
    );
  }
  const needsBinding = !previous || previous.name !== authenticated.name;
  await pi.setSessionName(authenticated.name);
  if (needsBinding) {
    pi.appendEntry(ACTOR_BINDING_ENTRY, {
      actorId: authenticated.id,
      actorName: authenticated.name,
    });
    // SessionManager difiere las entradas arbitrarias de la extensión hasta el
    // primer mensaje del asistente. Un segundo session_info guarda el binding
    // de una sesión nueva sin cambiar el nombre visible.
    if (!sessionHasAssistant(ctx)) await pi.setSessionName(authenticated.name);
  }
}

function actorIdFromActors(data: JsonObject, name: string): string | null {
  if (!Array.isArray(data.actors)) return null;
  for (const value of data.actors) {
    const actor = asObject(value);
    if (asString(actor?.name) === name && asString(actor?.type)?.toUpperCase() === "AGENT") {
      return asString(actor?.id);
    }
  }
  return null;
}

async function createProjectAgent(
  projectRoot: string,
  url: string,
  adminKey: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const name = projectAgentName(projectRoot);
  const existing = await graphqlData(
    url,
    adminKey,
    "query { actors(type: AGENT) { id name type } teams { id memberships { actor { id } } } }",
    {},
    fetchImpl,
  );
  let actorId = actorIdFromActors(existing, name);
  if (!actorId) {
    const created = await graphqlData(
      url,
      adminKey,
      "mutation($name: String!) { actorCreate(input: { name: $name, type: AGENT }) { actor { id type } } }",
      { name },
      fetchImpl,
    );
    actorId = asString(asObject(asObject(created.actorCreate)?.actor)?.id);
  }
  if (!actorId) throw new Error("The project Actor AGENT could not be created.");

  const teams = Array.isArray(existing.teams) ? existing.teams : [];
  const team = asObject(teams[0]);
  const teamId = asString(team?.id);
  const memberships = Array.isArray(team?.memberships) ? team.memberships : [];
  const hasMembership = memberships.some((value) => {
    const membership = asObject(value);
    return asString(asObject(membership?.actor)?.id) === actorId;
  });
  if (teamId && !hasMembership) {
    await graphqlData(
      url,
      adminKey,
      "mutation($teamId: ID!, $actorId: ID!) { teamMembershipCreate(input: { teamId: $teamId, actorId: $actorId, role: MEMBER }) { success } }",
      { teamId, actorId },
      fetchImpl,
    );
  }
  const keyData = await graphqlData(
    url,
    adminKey,
    teamId
      ? "mutation($actorId: ID!, $name: String!, $teamId: ID!) { apiKeyCreate(input: { actorId: $actorId, name: $name, scopes: [READ, WRITE], teamIds: [$teamId] }) { key } }"
      : "mutation($actorId: ID!, $name: String!) { apiKeyCreate(input: { actorId: $actorId, name: $name, scopes: [READ, WRITE] }) { key } }",
    teamId ? { actorId, name: `${name}-key`, teamId } : { actorId, name: `${name}-key` },
    fetchImpl,
  );
  const key = asString(asObject(keyData.apiKeyCreate)?.key);
  if (!key) throw new Error("The project Actor AGENT API key was not returned.");
  if ((await viewerType(url, key, fetchImpl)) !== "AGENT") {
    throw new Error("The generated project credential is not an Actor AGENT key.");
  }
  return key;
}

async function projectCredential(
  projectRoot: string,
  url: string,
  environment: NodeJS.ProcessEnv,
  stored: ProjectCredential | null,
  fetchImpl: FetchLike,
): Promise<ProjectCredential | null> {
  const environmentKey = environment.PRIME_BOARD_API_KEY?.trim();
  const storedKey = stored?.apiKey.trim();
  let key: string | null = environmentKey || storedKey || null;
  let source: ProjectCredentialSource | null = environmentKey
    ? "environment"
    : storedKey
      ? "stored"
      : null;
  if (!key || !source) return null;

  const type = await viewerType(url, key, fetchImpl);
  if (type !== "AGENT" && source === "environment" && storedKey) {
    // Una API key humana de bootstrap no se guarda. Reutiliza solo una key AGENT
    // ya verificada del proyecto para evitar crear una identidad en cada sesión.
    const storedType = await viewerType(url, storedKey, fetchImpl);
    if (storedType === "AGENT") {
      key = storedKey;
      source = "stored";
    }
  }
  if (
    type === "AGENT" ||
    (source === "stored" && (await viewerType(url, key, fetchImpl)) === "AGENT")
  ) {
    return {
      apiKey: key,
      url,
      ...((environment.PRIME_BOARD_MCP_URL ?? stored?.mcpUrl)
        ? { mcpUrl: environment.PRIME_BOARD_MCP_URL ?? stored?.mcpUrl }
        : {}),
    };
  }
  // El primer bootstrap del servidor guarda una key admin HUMAN fuera del proyecto.
  // Reclámala una vez para crear la credencial AGENT del proyecto y persiste
  // solo la key AGENT mediante el caller.
  if (source !== "environment" && type !== "HUMAN") {
    throw new Error("The project credential must belong to an Actor AGENT.");
  }
  const agentKey = await createProjectAgent(projectRoot, url, key, fetchImpl);
  return {
    apiKey: agentKey,
    url,
    ...((environment.PRIME_BOARD_MCP_URL ?? stored?.mcpUrl)
      ? { mcpUrl: environment.PRIME_BOARD_MCP_URL ?? stored?.mcpUrl }
      : {}),
  };
}

export interface PrimeBoardExtensionOptions {
  runtimeDependencies?: RuntimeDependencies;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Extensión de Prime Agent para el runtime de prime-board por proyecto.
 *
 * La extensión gestiona lifecycle y diagnóstico. Las operaciones de Issues quedan
 * en el catálogo MCP autenticado respaldado por GraphQL.
 */
export function createPrimeBoardExtension(options: PrimeBoardExtensionOptions = {}) {
  const runtime = createRuntimeController(
    options.runtimeDependencies,
    options.env ?? process.env,
    options.home,
  );
  let current: RuntimeStatus | null = null;
  const sessionReferences = new Map<string, number>();
  const credentialPending = new Map<string, Promise<ProjectCredential | null>>();
  const fetchImpl = options.runtimeDependencies?.fetch ?? globalThis.fetch;
  const environment = clearGitEnvironment(options.env ?? process.env);

  const authenticate = (projectRoot: string, url: string): Promise<ProjectCredential | null> => {
    const pending = credentialPending.get(projectRoot);
    if (pending) return pending;
    const operation = (async () => {
      const stored = readProjectCredential(projectRoot, options.home);
      const credential = await projectCredential(projectRoot, url, environment, stored, fetchImpl);
      if (credential) saveProjectCredential(projectRoot, credential, options.home);
      return credential;
    })();
    credentialPending.set(projectRoot, operation);
    return operation.finally(() => credentialPending.delete(projectRoot));
  };

  const retainSession = (projectRoot: string): void => {
    sessionReferences.set(projectRoot, (sessionReferences.get(projectRoot) ?? 0) + 1);
  };

  const releaseSession = (projectRoot: string): void => {
    const references = sessionReferences.get(projectRoot) ?? 0;
    if (references <= 1) {
      sessionReferences.delete(projectRoot);
      runtime.release(projectRoot);
      return;
    }
    sessionReferences.set(projectRoot, references - 1);
  };

  return (pi: ExtensionAPI): void => {
    const start = async (ctx: ExtensionContext): Promise<RuntimeStatus> => {
      const projectRoot = discoverPrimeBoardProject(ctx.cwd, environment);
      if (!projectRoot) {
        const status: RuntimeStatus = {
          projectRoot: ctx.cwd,
          url: null,
          state: "error",
          detail: "The current directory is not inside a Git project",
          logPath: "",
          credentialPath: "",
        };
        current = status;
        return status;
      }
      current = await runtime.ensure(projectRoot);
      if (current.url) {
        const credential = await authenticate(projectRoot, current.url);
        if (credential) {
          const identity = await viewerIdentity(current.url, credential.apiKey, fetchImpl);
          if (!identity) {
            throw new Error("The authenticated prime-board Actor has no stable id and name.");
          }
          await bindSessionToActor(pi, ctx, identity);
        }
      }
      return current;
    };

    const readStatus = (ctx: ExtensionContext): RuntimeStatus => {
      const projectRoot = discoverPrimeBoardProject(ctx.cwd, environment);
      if (!projectRoot) {
        return {
          projectRoot: ctx.cwd,
          url: null,
          state: "error",
          detail: "The current directory is not inside a Git project",
          logPath: "",
          credentialPath: "",
        };
      }
      current = runtime.status(projectRoot);
      return current;
    };

    pi.registerCommand("prime-board", {
      description: "Start, inspect, open, stop, or authenticate the project prime-board runtime",
      async handler(rawArgs, ctx) {
        const [action = "status", linesArg] = rawArgs.trim().split(/\s+/);
        try {
          if (action === "start") {
            notifyRuntime(ctx, await start(ctx));
            return;
          }
          if (action === "status") {
            notifyRuntime(ctx, readStatus(ctx));
            return;
          }
          const projectRoot = discoverPrimeBoardProject(ctx.cwd, environment);
          if (!projectRoot) {
            ctx.ui.notify("The current directory is not inside a Git project.", "error");
            return;
          }
          if (action === "open") {
            notifyRuntime(ctx, runtime.open(projectRoot));
            return;
          }
          if (action === "logs") {
            const lines = linesArg === undefined ? 80 : Number(linesArg);
            if (!Number.isInteger(lines) || lines < 1 || lines > 500) {
              ctx.ui.notify("The log line count must be an integer from 1 to 500.", "error");
              return;
            }
            ctx.ui.notify(
              runtime.logs(projectRoot, lines) || "No runtime log is available.",
              "info",
            );
            return;
          }
          if (action === "stop") {
            notifyRuntime(ctx, await runtime.stop(projectRoot));
            current = null;
            return;
          }
          if (action === "auth") {
            const status =
              current?.projectRoot === projectRoot ? current : runtime.status(projectRoot);
            const url = environment.PRIME_BOARD_URL ?? status.url;
            if (!url) {
              ctx.ui.notify(
                "Set PRIME_BOARD_URL or start the project runtime before /prime-board auth.",
                "warning",
              );
              return;
            }
            const credential = await authenticate(projectRoot, url);
            if (!credential) {
              ctx.ui.notify(
                "Set PRIME_BOARD_API_KEY or start with an existing project Actor AGENT credential.",
                "warning",
              );
              return;
            }
            ctx.ui.notify(
              `Saved the verified Actor AGENT credential with mode 0600 at ${projectCredentialPath(projectRoot, options.home)}.`,
              "info",
            );
            return;
          }
          ctx.ui.notify(commandUsage(), "warning");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });

    pi.registerTool({
      name: "prime_board_status",
      label: "prime-board status",
      description: "Discover the current Git project and report local prime-board runtime health.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const status = await start(ctx);
        return { content: [{ type: "text", text: formatStatus(status) }], details: status };
      },
    });

    if (pi.on) {
      pi.on("session_start", async (_event, ctx) => {
        try {
          const status = await start(ctx);
          if (status.state !== "error") retainSession(status.projectRoot);
          notifyRuntime(ctx, status);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      });
      pi.on("session_shutdown", async (_event, ctx) => {
        const projectRoot = discoverPrimeBoardProject(ctx.cwd, environment);
        if (!projectRoot) return;
        releaseSession(projectRoot);
        if (current?.projectRoot === projectRoot && !sessionReferences.has(projectRoot)) {
          current = null;
        }
        // No detener el proceso: otra sesión de Prime Agent puede usarlo.
      });
    }
  };
}

export default createPrimeBoardExtension();
