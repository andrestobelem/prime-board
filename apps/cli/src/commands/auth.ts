// pb auth login|status|profiles|use
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import {
  CONFIG_PATH,
  currentProfile,
  listProfiles,
  loadConfig,
  saveConfig,
  type EffectiveWorkspaceContext,
} from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";

const IDENTITY_QUERY = `{
  viewer { id name type }
  workspace { id name urlKey }
}`;

function effectiveContext(data: any): EffectiveWorkspaceContext {
  if (!data.viewer?.id || !data.workspace?.id) {
    throw new Error("The server did not return an effective Workspace context");
  }
  return {
    workspaceId: data.workspace.id,
    workspaceName: data.workspace.name,
    workspaceUrlKey: data.workspace.urlKey,
    actorId: data.viewer.id,
    actorName: data.viewer.name,
    actorType: data.viewer.type,
  };
}

export async function authCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  if (action === "login") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        url: { type: "string" },
        key: { type: "string" },
        profile: { type: "string" },
      },
    });
    if (!values.url || !values.key) {
      throw new UsageError("Usage: pb auth login --url <url> --key <api-key> [--profile NAME]");
    }
    const config = { url: values.url, apiKey: values.key };
    // Valida las credenciales y fija el contexto que el endpoint resolvió antes de guardarlas.
    const data = await gqlRequest(config, IDENTITY_QUERY);
    const context = effectiveContext(data);
    await saveConfig({ ...config, context }, values.profile);
    console.log(`Logged in as ${data.viewer.name} (${data.viewer.type.toLowerCase()})`);
    console.log(`Workspace: ${data.workspace.name} (${data.workspace.urlKey})`);
    console.log(`Config saved to ${CONFIG_PATH}`);
    return;
  }
  if (action === "status" || action === "current") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { profile: { type: "string" }, json: { type: "boolean" } },
    });
    const config = await loadConfig(values.profile);
    const data = await gqlRequest(config, IDENTITY_QUERY);
    const context = effectiveContext(data);
    const result = {
      profile: config.profile,
      url: config.url,
      viewer: data.viewer,
      workspace: data.workspace,
      context,
    };
    if (values.json === false) {
      console.log(
        `${data.viewer.name} (${data.viewer.type.toLowerCase()}) @ ${data.workspace.name}`,
      );
    } else {
      printJson(result);
    }
    return;
  }
  if (action === "profiles" || action === "list") {
    const profiles = await listProfiles();
    printJson({ current: await currentProfile(), profiles });
    return;
  }
  if (action === "use" || action === "select") {
    const profile = argv[1];
    if (!profile) throw new UsageError("Usage: pb auth use <profile>");
    const config = await loadConfig(profile);
    const data = await gqlRequest(config, IDENTITY_QUERY);
    const context = effectiveContext(data);
    // Solo activa el perfil después de validar su credencial y contexto efectivos.
    await saveConfig({ ...config, context }, profile);
    console.log(`Using profile ${profile}: ${data.viewer.name} @ ${data.workspace.name}`);
    return;
  }
  throw new UsageError("Usage: pb auth <login|status|profiles|use>");
}
