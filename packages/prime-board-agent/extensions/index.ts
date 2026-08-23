import { spawnSync } from "node:child_process";
import type { RuntimeStatus, RuntimeDependencies } from "./runtime.ts";
import {
  createRuntimeController,
  readProjectCredential,
  saveProjectCredential,
} from "./runtime.ts";

export type NotificationLevel = "info" | "warning" | "error";

type SessionEvent = { reason?: string };

type ExtensionContext = {
  cwd: string;
  hasUI?: boolean;
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

/** Finds the Git project that contains the supplied working directory. */
export function discoverPrimeBoardProject(cwd: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || result.error) return null;
  const root = result.stdout.trim();
  return root || null;
}

/** Checks the configured local server without starting it. */
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

export interface PrimeBoardExtensionOptions {
  runtimeDependencies?: RuntimeDependencies;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Prime Agent extension for the per-project prime-board runtime.
 *
 * The extension only owns lifecycle and diagnostics. Issue operations remain in
 * the authenticated GraphQL-backed MCP catalog.
 */
export function createPrimeBoardExtension(options: PrimeBoardExtensionOptions = {}) {
  const runtime = createRuntimeController(
    options.runtimeDependencies,
    options.env ?? process.env,
    options.home,
  );
  let current: RuntimeStatus | null = null;

  return (pi: ExtensionAPI): void => {
    const start = async (ctx: ExtensionContext): Promise<RuntimeStatus> => {
      const projectRoot = discoverPrimeBoardProject(ctx.cwd);
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
      const environment = options.env ?? process.env;
      const stored = readProjectCredential(projectRoot, options.home);
      const apiKey = environment.PRIME_BOARD_API_KEY ?? stored?.apiKey;
      if (apiKey && current.url) {
        saveProjectCredential(
          projectRoot,
          {
            apiKey,
            url: current.url,
            ...((environment.PRIME_BOARD_MCP_URL ?? stored?.mcpUrl)
              ? { mcpUrl: environment.PRIME_BOARD_MCP_URL ?? stored?.mcpUrl }
              : {}),
          },
          options.home,
        );
      }
      return current;
    };

    const readStatus = (ctx: ExtensionContext): RuntimeStatus => {
      const projectRoot = discoverPrimeBoardProject(ctx.cwd);
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
          const projectRoot = discoverPrimeBoardProject(ctx.cwd);
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
            const apiKey = (options.env ?? process.env).PRIME_BOARD_API_KEY;
            if (!apiKey) {
              ctx.ui.notify(
                "Set PRIME_BOARD_API_KEY in the process environment before /prime-board auth.",
                "warning",
              );
              return;
            }
            const environment = options.env ?? process.env;
            const url = environment.PRIME_BOARD_URL;
            const mcpUrl = environment.PRIME_BOARD_MCP_URL;
            const path = saveProjectCredential(
              projectRoot,
              { apiKey, ...(url ? { url } : {}), ...(mcpUrl ? { mcpUrl } : {}) },
              options.home,
            );
            ctx.ui.notify(`Saved the project credential with mode 0600 at ${path}.`, "info");
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
          notifyRuntime(ctx, status);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      });
      pi.on("session_shutdown", async (_event, ctx) => {
        const projectRoot = discoverPrimeBoardProject(ctx.cwd);
        if (projectRoot) {
          current = null;
          // Do not stop the process: another Prime Agent session can use it.
          void ctx;
        }
      });
    }
  };
}

export default createPrimeBoardExtension();
