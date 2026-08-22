// pb workspace list|view|use|update
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { effectiveContext, IDENTITY_QUERY } from "./auth.ts";
import { loadConfig, saveConfig, type CliConfig } from "../config.ts";
import { ApiError, UsageError } from "../errors.ts";
import { printJson } from "../format.ts";

const WORKSPACE_FIELDS = "id name urlKey createdAt";
const ACCESSIBLE_WORKSPACES = `id name urlKey role status isDefault`;
const USAGE = `Usage:
  pb workspace list [--json]
  pb workspace view [--json]
  pb workspace use <ID|URLKEY|NAME> [--json]
  pb workspace update --name TEXT [--json]`;

interface WorkspaceOption {
  id: string;
  name: string;
  urlKey: string;
  role?: string;
  status?: string;
  isDefault?: boolean;
  createdAt?: string;
}

function withoutWorkspace(config: CliConfig): CliConfig {
  const { workspaceId: _workspaceId, workspaceUrlKey: _workspaceUrlKey, ...rest } = config;
  return rest;
}

async function accessibleWorkspaces(config: CliConfig): Promise<WorkspaceOption[]> {
  // El servidor filtra por Membership y grants. El CLI nunca intenta inferir acceso desde el ID.
  let data: Record<string, any>;
  try {
    data = await gqlRequest(
      withoutWorkspace(config),
      `{ workspaces { ${ACCESSIBLE_WORKSPACES} } }`,
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      /workspaces|Workspace selector contract/i.test(error.message)
    ) {
      throw new ApiError(
        "The server does not expose the Workspace selector contract; complete PRB-478 first",
        "VALIDATION_FAILED",
      );
    }
    throw error;
  }
  if (!Array.isArray(data.workspaces)) {
    throw new ApiError(
      "The server does not expose the Workspace selector contract; complete PRB-478 first",
      "VALIDATION_FAILED",
    );
  }
  return data.workspaces;
}

export function selectWorkspace(workspaces: WorkspaceOption[], ref: string): WorkspaceOption {
  const normalized = ref.trim().toLowerCase();
  if (!normalized) throw new UsageError("Workspace reference cannot be empty");
  const matches = workspaces.filter((workspace) =>
    [workspace.id, workspace.urlKey, workspace.name].some(
      (value) => value.toLowerCase() === normalized,
    ),
  );
  if (!matches.length) {
    throw new ApiError(
      `Workspace not found or not accessible: ${ref}; use \`pb workspace list --json\``,
      "NOT_FOUND",
    );
  }
  if (matches.length > 1) {
    throw new ApiError(`Workspace reference is ambiguous: ${ref}; use its ID`, "VALIDATION_FAILED");
  }
  return matches[0]!;
}

export async function workspaceCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  const config = await loadConfig();

  if (action === "list") {
    const { values } = parseArgs({ args: argv.slice(1), options: { json: { type: "boolean" } } });
    const workspaces = await accessibleWorkspaces(config);
    if (values.json) {
      printJson(workspaces);
    } else {
      for (const workspace of workspaces) {
        console.log(
          `${workspace.name} (${workspace.urlKey})${workspace.isDefault ? " [default]" : ""}`,
        );
      }
    }
    return;
  }

  if (action === "use" || action === "select") {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: { json: { type: "boolean" } },
    });
    const ref = positionals[0];
    if (!ref || positionals.length > 1) throw new UsageError(USAGE);
    const selected = selectWorkspace(await accessibleWorkspaces(config), ref);
    // Valida el header contra el servidor antes de persistirlo. Un selector no es autoridad.
    const selectedConfig = {
      ...config,
      workspaceId: selected.id,
      workspaceUrlKey: selected.urlKey,
    };
    const data = await gqlRequest(selectedConfig, IDENTITY_QUERY);
    const context = effectiveContext(data);
    await saveConfig({ ...selectedConfig, context }, config.profile);
    if (values.json) {
      printJson(selected);
    } else {
      console.log(`Using workspace ${selected.name} (${selected.urlKey})`);
    }
    return;
  }

  if (action === "view" || action === "get") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { json: { type: "boolean" } },
    });
    const data = await gqlRequest(config, `{ workspace { ${WORKSPACE_FIELDS} } }`);
    if (values.json) return printJson(data.workspace);
    console.log(`${data.workspace.name} (${data.workspace.urlKey})`);
    return;
  }

  if (action === "update") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { name: { type: "string" }, json: { type: "boolean" } },
    });
    if (values.name === undefined || !values.name.trim()) throw new UsageError(USAGE);
    const data = await gqlRequest(
      config,
      `mutation($input: WorkspaceUpdateInput!) {
        workspaceUpdate(input: $input) { success workspace { ${WORKSPACE_FIELDS} } }
      }`,
      { input: { name: values.name } },
    );
    if (values.json) return printJson(data.workspaceUpdate.workspace);
    console.log(`Updated workspace: ${data.workspaceUpdate.workspace.name}`);
    return;
  }

  throw new UsageError(USAGE);
}
