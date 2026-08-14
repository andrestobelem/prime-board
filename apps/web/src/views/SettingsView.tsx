// Settings: la API key se pega una vez y queda en localStorage (spec §9).
import { useState } from "react";
import { getApiKey, gql, setApiKey } from "../api.ts";

export function SettingsView() {
  const [key, setKey] = useState(getApiKey());
  const [status, setStatus] = useState<string | null>(null);

  async function save() {
    setApiKey(key.trim());
    try {
      const data = await gql<{ viewer: { name: string; type: string } }>("{ viewer { name type } }");
      setStatus(`Connected as ${data.viewer.name} (${data.viewer.type.toLowerCase()})`);
      setTimeout(() => {
        window.location.hash = "#/";
        window.location.reload();
      }, 600);
    } catch (error) {
      setStatus(`Connection failed: ${error}`);
    }
  }

  return (
    <div className="settings">
      <h2 style={{ margin: 0 }}>Settings</h2>
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
        <button className="btn" onClick={save}>Save & connect</button>
      </div>
      {status && <div style={{ color: "var(--text-muted)" }}>{status}</div>}
      <p style={{ color: "var(--text-faint)" }}>
        The key is stored in this browser only (localStorage) and sent as
        <code> Authorization: Bearer</code> to /graphql.
      </p>
    </div>
  );
}
