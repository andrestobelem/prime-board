// pb auth login|status
import { parseArgs } from "node:util";
import { gqlRequest } from "../api.ts";
import { CONFIG_PATH, loadConfig, saveConfig } from "../config.ts";
import { UsageError } from "../errors.ts";
import { printJson } from "../format.ts";

export async function authCommand(argv: string[]): Promise<void> {
  const action = argv[0];
  if (action === "login") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { url: { type: "string" }, key: { type: "string" } },
    });
    if (!values.url || !values.key) {
      throw new UsageError("Usage: pb auth login --url <url> --key <api-key>");
    }
    const config = { url: values.url, apiKey: values.key };
    // Valida las credenciales antes de guardarlas.
    const data = await gqlRequest(config, "{ viewer { name type } }");
    await saveConfig(config);
    console.log(`Logged in as ${data.viewer.name} (${data.viewer.type.toLowerCase()})`);
    console.log(`Config saved to ${CONFIG_PATH}`);
    return;
  }
  if (action === "status") {
    const config = await loadConfig();
    const data = await gqlRequest(config, "{ viewer { id name type } workspace { name } }");
    printJson({ url: config.url, viewer: data.viewer, workspace: data.workspace });
    return;
  }
  throw new UsageError("Usage: pb auth <login|status>");
}
