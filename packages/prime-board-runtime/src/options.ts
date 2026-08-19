import { resolve } from "node:path";

export interface RuntimeOptions {
  dbPath?: string;
  repoRoot?: string;
  port?: number;
  webDist?: string;
  help: boolean;
}

export function parseRuntimeArgs(args: string[]): RuntimeOptions {
  const options: RuntimeOptions = { help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!argument?.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument ?? ""}`);
    }
    const [name, inlineValue] = argument.slice(2).split("=", 2);
    if (name === "help") {
      options.help = true;
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    switch (name) {
      case "db":
        options.dbPath = resolve(value);
        break;
      case "repo":
        options.repoRoot = resolve(value);
        break;
      case "port": {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid port: ${value}`);
        }
        options.port = port;
        break;
      }
      case "web-dist":
        options.webDist = resolve(value);
        break;
      default:
        throw new Error(`Unknown argument: --${name}`);
    }
  }
  return options;
}
