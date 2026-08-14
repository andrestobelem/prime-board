// Manejo de tema (AT-150): dark / light / system, persistido en localStorage.
// El index.html aplica el tema resuelto ANTES de cargar el bundle (sin FOUC);
// acá vive la lógica para cambiarlo en runtime y seguir al sistema operativo.
export type ThemePreference = "dark" | "light" | "system";

const STORAGE_KEY = "pb.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "dark" || stored === "light" ? stored : "system";
}

export function resolveTheme(preference: ThemePreference): "dark" | "light" {
  if (preference === "system") return media.matches ? "dark" : "light";
  return preference;
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(preference);
}

export function setThemePreference(preference: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, preference);
  applyTheme(preference);
}

/** Sigue los cambios de tema del sistema operativo cuando la preferencia es "system". */
export function watchSystemTheme(): void {
  media.addEventListener("change", () => {
    if (getThemePreference() === "system") applyTheme("system");
  });
}
