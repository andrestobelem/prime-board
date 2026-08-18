// Utilidades puras y almacenamiento temporal para consumir enlaces de onboarding
// sin pisar credenciales existentes.

const STAGED_KEY_STORAGE = "pb.onboardingKey";

/** Devuelve la API key del parámetro `key`, normalizada y sin efectos secundarios. */
export function getOnboardingKeyFromSearch(search: string): string | null {
  const key = new URLSearchParams(search).get("key")?.trim() ?? "";
  return key || null;
}

/** Quita `key` y conserva el resto de los parámetros de búsqueda. */
export function stripOnboardingKey(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("key");
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Solo un perfil sin credencial existente puede adoptar automáticamente la key. */
export function shouldUseOnboardingKey(existingKey: string, onboardingKey: string): boolean {
  return Boolean(onboardingKey && !existingKey);
}

/** Guarda temporalmente una key hasta que Settings confirme la conexión. */
export function stageOnboardingKey(key: string): boolean {
  try {
    window.sessionStorage.setItem(STAGED_KEY_STORAGE, key);
    return true;
  } catch {
    return false;
  }
}

/** Lee la key pendiente sin consumirla; permite a React inicializar su estado una vez. */
export function getStagedOnboardingKey(): string {
  try {
    return window.sessionStorage.getItem(STAGED_KEY_STORAGE)?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Elimina la key temporal después de copiarla al estado del formulario. */
export function clearStagedOnboardingKey(): void {
  try {
    window.sessionStorage.removeItem(STAGED_KEY_STORAGE);
  } catch {
    // El almacenamiento temporal puede estar bloqueado por el navegador.
  }
}
