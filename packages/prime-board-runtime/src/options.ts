import { resolve } from "node:path";

export interface RuntimeOptions {
  /** Git project root to isolate. Resolved by the launcher. */
  projectRoot?: string;
  /** Legacy name for --project. */
  repoRoot?: string;
  dbPath?: string;
  port?: number;
  host?: string;
  webDist?: string;
  backupPath?: string;
  restorePath?: string;
  update?: boolean;
  status?: boolean;
  printEnv?: boolean;
  help: boolean;
}

function pathValue(value: string): string {
  return value === ":memory:" ? value : resolve(value);
}

function hostValue(value: string): string {
  const host = value.trim();
  if (!host || /\s/.test(host) || host.includes("/")) {
    throw new Error(`Invalid host: ${value}`);
  }
  return host;
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
    if (name === "status") {
      if (inlineValue !== undefined) throw new Error("--status does not accept a value");
      options.status = true;
      continue;
    }
    if (name === "print-env") {
      if (inlineValue !== undefined) throw new Error("--print-env does not accept a value");
      options.printEnv = true;
      continue;
    }
    if (name === "update") {
      if (inlineValue !== undefined) throw new Error("--update does not accept a value");
      options.update = true;
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    switch (name) {
      case "project":
        if (options.repoRoot) throw new Error("Use only one of --project and --repo");
        options.projectRoot = resolve(value);
        break;
      case "repo":
        if (options.projectRoot) throw new Error("Use only one of --project and --repo");
        options.repoRoot = resolve(value);
        break;
      case "db":
        options.dbPath = pathValue(value);
        break;
      case "port": {
        if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value}`);
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(`Invalid port: ${value}`);
        }
        options.port = port;
        break;
      }
      case "host":
        options.host = hostValue(value);
        break;
      case "web-dist":
        options.webDist = pathValue(value);
        break;
      case "backup":
        options.backupPath = pathValue(value);
        break;
      case "restore":
        options.restorePath = pathValue(value);
        break;
      default:
        throw new Error(`Unknown argument: --${name}`);
    }
  }
  if (options.printEnv && options.status)
    throw new Error("Use only one of --status and --print-env");
  if (options.backupPath && options.restorePath)
    throw new Error("Use only one of --backup and --restore");
  if (
    options.update &&
    (options.backupPath || options.restorePath || options.status || options.printEnv)
  ) {
    throw new Error("Use --update only when starting the runtime");
  }
  return options;
}
