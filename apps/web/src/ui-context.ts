/**
 * Identidad efectiva usada para separar estado local de la UI.
 *
 * El Workspace se obtiene del servidor junto con el viewer autenticado. Nunca se
 * construye desde una ruta o un selector visual. El fallback por credencial cubre
 * el breve intervalo entre guardar una key y validar su contexto.
 */
export interface EffectiveWorkspaceContext {
  workspaceId: string;
  workspaceName?: string;
  workspaceUrlKey?: string;
  actorId: string;
  actorName?: string;
  actorType?: string;
}

const CONTEXT_KEY = "pb.ui.context";
const CREDENTIAL_KEY = "pb.apiKey";
const CREDENTIAL_MARKER_KEY = "pb.ui.credential";
const LEGACY_PREFERENCE_KEYS = ["pb.group-by", "pb.order-by", "pb.visible-columns", "pb.theme"];

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function hash(value: string): string {
  // Namespace estable no secreto; intencionalmente no es una primitiva de seguridad.
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

export function credentialNamespace(apiKey: string): string {
  return `credential-${hash(apiKey)}`;
}

export function contextNamespace(context: EffectiveWorkspaceContext): string {
  return `workspace-${hash(`${context.workspaceId}:${context.actorId}`)}`;
}

function namespaceKey(namespace: string, key: string): string {
  return `pb.ui.${namespace}.${key}`;
}

function readContext(): EffectiveWorkspaceContext | null {
  const store = storage();
  if (!store) return null;
  try {
    const parsed = JSON.parse(
      store.getItem(CONTEXT_KEY) ?? "null",
    ) as Partial<EffectiveWorkspaceContext> | null;
    if (!parsed?.workspaceId || !parsed.actorId) return null;
    return parsed as EffectiveWorkspaceContext;
  } catch {
    return null;
  }
}

export function getEffectiveWorkspaceContext(): EffectiveWorkspaceContext | null {
  return readContext();
}

function currentNamespace(): string | null {
  const store = storage();
  if (!store) return null;
  const context = readContext();
  if (context) return contextNamespace(context);
  const key = store.getItem(CREDENTIAL_KEY)?.trim();
  return key ? credentialNamespace(key) : null;
}

/** Key namespaced by the authenticated Workspace + Actor effective context. */
export function getUiStorageKey(key: string): string {
  adoptLegacyUiState();
  const namespace = currentNamespace();
  return namespace ? namespaceKey(namespace, key) : `pb.ui.anonymous.${key}`;
}

function migrateNamespaceData(fromNamespace: string | null, toNamespace: string | null): void {
  const store = storage();
  if (!store || !fromNamespace || !toNamespace || fromNamespace === toNamespace) return;
  const prefix = `pb.ui.${fromNamespace}.`;
  const targetPrefix = `pb.ui.${toNamespace}.`;
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (!key?.startsWith(prefix)) continue;
    const target = `${targetPrefix}${key.slice(prefix.length)}`;
    // El contexto validado del Workspace prevalece sobre el fallback de credencial no validado.
    if (store.getItem(target) === null) store.setItem(target, store.getItem(key)!);
    store.removeItem(key);
    index -= 1;
  }
}

function moveLegacyPreferences(fromNamespace: string | null, toNamespace: string | null): void {
  const store = storage();
  if (!store || !toNamespace || fromNamespace === toNamespace) return;
  for (const key of LEGACY_PREFERENCE_KEYS) {
    const legacy = store.getItem(key);
    if (legacy !== null) store.setItem(namespaceKey(fromNamespace ?? toNamespace, key), legacy);
    store.removeItem(key);
  }
  for (const key of LEGACY_PREFERENCE_KEYS) {
    const namespaced = store.getItem(namespaceKey(toNamespace, key));
    if (namespaced !== null) store.setItem(key, namespaced);
  }
}

/**
 * Se ejecuta antes de cambiar una credencial. Las preferencias de la identidad anterior
 * se conservan en su namespace, pero nunca son visibles para la nueva.
 */
export function prepareCredentialChange(previousKey: string, nextKey: string): void {
  const store = storage();
  if (!store) return;
  const fromNamespace = readContext()
    ? contextNamespace(readContext()!)
    : previousKey
      ? credentialNamespace(previousKey)
      : null;
  const toNamespace = nextKey ? credentialNamespace(nextKey) : null;
  moveLegacyPreferences(fromNamespace, toNamespace);
  store.removeItem(CONTEXT_KEY);
  if (nextKey) store.setItem(CREDENTIAL_MARKER_KEY, credentialNamespace(nextKey));
  else store.removeItem(CREDENTIAL_MARKER_KEY);
}

/**
 * Asocia la identidad validada por el servidor con la credencial activa.
 * Es la única forma en que la UI registra el contexto efectivo del Workspace.
 */
export function setEffectiveWorkspaceContext(context: EffectiveWorkspaceContext): void {
  if (!context.workspaceId || !context.actorId) throw new Error("Invalid Workspace context");
  const store = storage();
  if (!store) return;
  const apiKey = store.getItem(CREDENTIAL_KEY)?.trim() ?? "";
  const previousContext = readContext();
  const fallback = apiKey ? credentialNamespace(apiKey) : null;
  const target = contextNamespace(context);
  // Conserva las preferencias escritas por App mientras se validaba el contexto,
  // y luego expone el namespace del contexto, incluidas las preferencias previas del actor.
  const unvalidatedNamespace = previousContext ? contextNamespace(previousContext) : fallback;
  moveLegacyPreferences(unvalidatedNamespace, target);
  migrateNamespaceData(fallback, target);
  store.setItem(CONTEXT_KEY, JSON.stringify(context));
  store.setItem(CREDENTIAL_MARKER_KEY, fallback ?? target);
}

/** Clears only the effective Workspace while preserving per-Workspace state. */
export function clearEffectiveWorkspaceContext(): void {
  const store = storage();
  if (!store) return;
  store.removeItem(CONTEXT_KEY);
}

/** Remove visible anonymous state on logout; namespaced data remains isolated. */
export function clearAnonymousUiState(): void {
  const store = storage();
  if (!store) return;
  store.removeItem(CONTEXT_KEY);
  store.removeItem(CREDENTIAL_MARKER_KEY);
  for (const key of LEGACY_PREFERENCE_KEYS) store.removeItem(key);
}

/** Detect direct legacy logout (App removes pb.apiKey) and prevent stale state. */
export function adoptLegacyUiState(): void {
  const store = storage();
  const key = store?.getItem(CREDENTIAL_KEY)?.trim();
  if (!store || !key || store.getItem(CREDENTIAL_MARKER_KEY)) return;
  const namespace = credentialNamespace(key);
  moveLegacyPreferences(null, namespace);
  store.setItem(CREDENTIAL_MARKER_KEY, namespace);
}

export function clearUiStateWithoutCredential(): void {
  const store = storage();
  if (!store) return;
  if (store.getItem(CREDENTIAL_KEY)) {
    adoptLegacyUiState();
    return;
  }
  clearAnonymousUiState();
}
