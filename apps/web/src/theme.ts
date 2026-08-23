import { getUiStorageKey } from "./ui-context.ts";
// Preferencias de tema persistidas por Workspace y Actor. Los ids `dark` y `light`
// se conservan para leer preferencias existentes; los nuevos temas usan Catppuccin.
export type ThemePreference =
  | "dark"
  | "light"
  | "system"
  | "catppuccin-latte"
  | "catppuccin-frappe"
  | "catppuccin-macchiato"
  | "catppuccin-mocha";

export type ResolvedTheme = Exclude<ThemePreference, "system">;

export interface ThemeOption {
  value: ThemePreference;
  label: string;
}

export const THEME_OPTIONS: ThemeOption[] = [
  { value: "system", label: "System" },
  { value: "catppuccin-latte", label: "Catppuccin Latte" },
  { value: "catppuccin-frappe", label: "Catppuccin Frappé" },
  { value: "catppuccin-macchiato", label: "Catppuccin Macchiato" },
  { value: "catppuccin-mocha", label: "Catppuccin Mocha" },
  { value: "dark", label: "Dark (legacy)" },
  { value: "light", label: "Light (legacy)" },
];

const STORAGE_KEY = "theme";
const THEME_VALUES: ReadonlySet<string> = new Set(THEME_OPTIONS.map((option) => option.value));

export function isThemePreference(value: string): value is ThemePreference {
  return THEME_VALUES.has(value);
}

export function getThemePreference(): ThemePreference {
  const stored = localStorage.getItem(getUiStorageKey(STORAGE_KEY));
  return stored && isThemePreference(stored) ? stored : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark = prefersDarkMode(),
): ResolvedTheme {
  if (preference === "system") return prefersDark ? "catppuccin-mocha" : "catppuccin-latte";
  return preference;
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(preference);
}

export function setThemePreference(preference: ThemePreference): void {
  localStorage.setItem(getUiStorageKey(STORAGE_KEY), preference);
  applyTheme(preference);
}

function prefersDarkMode(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Sigue los cambios de tema del sistema operativo cuando la preferencia es "system". */
export function watchSystemTheme(): void {
  if (typeof window === "undefined") return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (getThemePreference() === "system") applyTheme("system");
  });
}
