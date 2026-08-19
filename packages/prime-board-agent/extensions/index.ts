import { spawnSync } from "node:child_process";

/**
 * Integración mínima con Prime Agent para descubrir y comprobar prime-board.
 *
 * Esta extensión no inicia servidores ni modifica archivos del proyecto.
 * La skill prime-board-workflow sigue siendo la fuente de verdad para operar Issues.
 */

type NotificationLevel = "info" | "warning" | "error";

type ExtensionContext = {
  cwd: string;
  hasUI?: boolean;
  ui: { notify(message: string, level: NotificationLevel): void };
};

type ExtensionAPI = {
  registerCommand(
    name: string,
    definition: {
      description: string;
      handler: (args: string, ctx: ExtensionContext) => void | Promise<void>;
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
    ) => Promise<{ content: [{ type: "text"; text: string }]; details: PrimeBoardStatus }>;
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

/** Encuentra el proyecto Git que contiene el directorio de trabajo indicado. */
export function discoverPrimeBoardProject(cwd: string): string | null {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || result.error) return null;
  const root = result.stdout.trim();
  return root || null;
}

/** Comprueba el servidor local configurado sin iniciarlo ni cambiar el estado del proyecto. */
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

function formatStatus(status: PrimeBoardStatus): string {
  const project = status.projectRoot ?? "Git project not found";
  return `prime-board ${status.state} — ${status.detail} (project: ${project}; URL: ${status.url})`;
}

export default function primeBoard(pi: ExtensionAPI): void {
  const check = async (ctx: ExtensionContext): Promise<PrimeBoardStatus> =>
    getPrimeBoardStatus(ctx.cwd);

  pi.registerCommand("prime-board", {
    description: "Discover the current project and check the local prime-board server",
    async handler(_args, ctx) {
      const status = await check(ctx);
      ctx.ui.notify(formatStatus(status), status.state === "healthy" ? "info" : "warning");
    },
  });

  pi.registerTool({
    name: "prime_board_status",
    label: "prime-board status",
    description: "Discover the current Git project and report local prime-board health.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const status = await check(ctx);
      return { content: [{ type: "text", text: formatStatus(status) }], details: status };
    },
  });
}
