// Configuración del CLI: perfiles locales y contexto efectivo del Workspace.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./errors.ts";

/** Identidad que el servidor resolvió para una credencial, nunca un input del caller. */
export interface EffectiveWorkspaceContext {
  workspaceId: string;
  workspaceName?: string;
  workspaceUrlKey?: string;
  actorId: string;
  actorName?: string;
  actorType?: string;
}

export interface CliConfig {
  url: string;
  apiKey: string;
  /** Perfil efectivo usado para resolver la credencial. */
  profile?: string;
  /** Contexto obtenido del endpoint, no una selección de Workspace. */
  context?: EffectiveWorkspaceContext;
}

interface StoredProfile {
  url: string;
  apiKey: string;
  context?: EffectiveWorkspaceContext;
}

interface StoredConfig {
  version?: number;
  currentProfile?: string;
  profiles?: Record<string, StoredProfile>;
  // Compatibilidad con cli.json de antes de PRB-405.
  url?: string;
  apiKey?: string;
  context?: EffectiveWorkspaceContext;
}

export const CONFIG_DIR = join(homedir(), ".prime-board");
export const CONFIG_PATH = join(CONFIG_DIR, "cli.json");
export const DEFAULT_PROFILE = "default";

function hardenPermissions(): void {
  chmodSync(CONFIG_DIR, 0o700);
  chmodSync(CONFIG_PATH, 0o600);
}

async function readStoredConfig(): Promise<StoredConfig> {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) return {};
  hardenPermissions();
  const parsed = (await file.json()) as StoredConfig;
  return parsed && typeof parsed === "object" ? parsed : {};
}

function profileName(value: string | undefined): string {
  const name = value?.trim() || DEFAULT_PROFILE;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new UsageError(`Invalid profile name: ${name}`);
  }
  return name;
}

function profileFromStored(stored: StoredConfig, name: string): StoredProfile | undefined {
  const profile = stored.profiles?.[name];
  if (profile?.url && profile.apiKey) return profile;
  // Lee las credenciales heredadas del nivel superior solo para el perfil default.
  if (name === DEFAULT_PROFILE && !stored.profiles && stored.url && stored.apiKey) {
    return { url: stored.url, apiKey: stored.apiKey, context: stored.context };
  }
  return undefined;
}

/** Carga el perfil efectivo; PRIME_BOARD_URL/API_KEY siguen siendo overrides explícitos. */
export async function loadConfig(profile?: string): Promise<CliConfig> {
  const stored = await readStoredConfig();
  const selected = profileName(
    profile ?? process.env.PRIME_BOARD_PROFILE ?? stored.currentProfile ?? DEFAULT_PROFILE,
  );
  const saved = profileFromStored(stored, selected);
  const url = process.env.PRIME_BOARD_URL ?? saved?.url;
  const apiKey = process.env.PRIME_BOARD_API_KEY ?? saved?.apiKey;
  if (!url || !apiKey) {
    throw new UsageError(
      "Missing credentials. Run `pb auth login --url <url> --key <api-key>` " +
        "or set PRIME_BOARD_URL and PRIME_BOARD_API_KEY.",
    );
  }
  // Las credenciales del entorno pueden apuntar a otro contexto efectivo; no arrastrar metadata entre ellos.
  const hasExplicitCredential = Boolean(
    process.env.PRIME_BOARD_URL || process.env.PRIME_BOARD_API_KEY,
  );
  return {
    url,
    apiKey,
    profile: selected,
    context: hasExplicitCredential ? undefined : saved?.context,
  };
}

export async function listProfiles(): Promise<
  Array<{ name: string; context?: EffectiveWorkspaceContext }>
> {
  const stored = await readStoredConfig();
  const profiles = { ...(stored.profiles ?? {}) };
  if (!stored.profiles && stored.url && stored.apiKey) {
    profiles[DEFAULT_PROFILE] = { url: stored.url, apiKey: stored.apiKey, context: stored.context };
  }
  return Object.entries(profiles)
    .filter(([, value]) => Boolean(value?.url && value?.apiKey))
    .map(([name, value]) => ({ name, context: value.context }));
}

export async function currentProfile(): Promise<string> {
  const stored = await readStoredConfig();
  return profileName(process.env.PRIME_BOARD_PROFILE ?? stored.currentProfile ?? DEFAULT_PROFILE);
}

export async function saveConfig(config: CliConfig, requestedProfile?: string): Promise<void> {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CONFIG_DIR, 0o700);

  const profile = profileName(requestedProfile ?? config.profile ?? DEFAULT_PROFILE);
  const existing = await readStoredConfig();
  const profiles = { ...(existing.profiles ?? {}) };
  profiles[profile] = { url: config.url, apiKey: config.apiKey, context: config.context };
  const payload: StoredConfig = {
    version: 2,
    currentProfile: profile,
    profiles,
    // Conserva la forma anterior para binarios viejos, pero solo refleja el perfil seleccionado.
    url: config.url,
    apiKey: config.apiKey,
    context: config.context,
  };

  const temporaryPath = `${CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, CONFIG_PATH);
    chmodSync(CONFIG_PATH, 0o600);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

/** Cambia el perfil sin alterar ni inferir una selección de Workspace. */
export async function selectProfile(profile: string): Promise<CliConfig> {
  const selected = profileName(profile);
  const config = await loadConfig(selected);
  await saveConfig(config, selected);
  return config;
}
