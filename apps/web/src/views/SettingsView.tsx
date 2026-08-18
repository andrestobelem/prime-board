// Settings: la API key se pega una vez y queda en localStorage (spec §9).
import { useEffect, useState } from "react";
import { getApiKey, gql, setApiKey } from "../api.ts";
import {
  clearStagedOnboardingKey,
  getStagedOnboardingKey,
  shouldUseOnboardingKey,
} from "../onboarding.ts";
import { getThemePreference, setThemePreference, type ThemePreference } from "../theme.ts";

export function SettingsView() {
  const [onboardingKey] = useState(() => getStagedOnboardingKey());
  const existingKey = getApiKey();
  const useOnboardingKey = shouldUseOnboardingKey(existingKey, onboardingKey);
  const onboardingConflict = Boolean(
    onboardingKey && existingKey && !useOnboardingKey && existingKey !== onboardingKey,
  );
  const [key, setKey] = useState(() =>
    useOnboardingKey ? onboardingKey : existingKey || onboardingKey,
  );
  const [status, setStatus] = useState<string | null>(() => {
    if (!onboardingKey) return null;
    if (onboardingConflict) return "An onboarding key was detected; your existing key was kept.";
    if (existingKey) return "This onboarding key is already saved in this browser.";
    return "Onboarding key loaded. Save & connect to continue.";
  });
  const [theme, setTheme] = useState<ThemePreference>(getThemePreference());

  useEffect(() => {
    if (onboardingKey) clearStagedOnboardingKey();
  }, [onboardingKey]);

  function changeTheme(next: ThemePreference) {
    setTheme(next);
    setThemePreference(next);
  }

  async function save() {
    const nextKey = key.trim();
    if (!nextKey) {
      setStatus("Enter an API key to connect.");
      return;
    }
    setApiKey(nextKey);
    try {
      const data = await gql<{ viewer: { name: string; type: string } }>(
        "{ viewer { name type } }",
      );
      setStatus(`Connected as ${data.viewer.name} (${data.viewer.type.toLowerCase()})`);
      setTimeout(() => {
        window.location.hash = "#/";
        window.location.reload();
      }, 600);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Connection failed: ${message}. Check the key and try again.`);
    }
  }

  return (
    <div className="settings">
      <h2 style={{ margin: 0 }}>Settings</h2>
      <label>
        Theme
        <select
          value={theme}
          onChange={(event) => changeTheme(event.target.value as ThemePreference)}
        >
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      {onboardingConflict && (
        <div role="status" style={{ color: "var(--text-muted)" }}>
          <p style={{ margin: 0 }}>
            This link contains another API key. Your existing credential was not replaced.
          </p>
          <button
            className="btn secondary"
            type="button"
            onClick={() => {
              setKey(onboardingKey);
              setStatus("Onboarding key selected. Save & connect to confirm the change.");
            }}
          >
            Use onboarding key
          </button>
        </div>
      )}
      <label>
        API key
        <input
          value={key}
          placeholder="pb_..."
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && save()}
        />
      </label>
      <div>
        <button className="btn" onClick={save}>
          Save & connect
        </button>
      </div>
      {status && <div style={{ color: "var(--text-muted)" }}>{status}</div>}
      <p style={{ color: "var(--text-faint)" }}>
        The key is stored in this browser only (localStorage) and sent as
        <code> Authorization: Bearer</code> to /graphql.
      </p>
    </div>
  );
}
