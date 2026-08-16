// Gestión de usuarios y agentes (AT-151 / PRB-197): alta, edición y keys.
import { useState } from "react";
import { GqlError, mutate, useQuery } from "../api.ts";
import { Avatar } from "../components/bits.tsx";
import { Icon } from "../components/icons.tsx";

interface KeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface Member {
  id: string;
  name: string;
  email: string | null;
  type: string;
  createdAt: string;
  apiKeys: KeyInfo[];
}

/** Agentes históricos del import/demo: no deben reactivarse con trabajo nuevo. */
const HISTORICAL_AGENT_NAMES = new Set(["claude", "demo-agent", "linear"]);

function isHistoricalAgent(member: Member): boolean {
  return member.type === "AGENT" && HISTORICAL_AGENT_NAMES.has(member.name.toLowerCase());
}

const MEMBERS_QUERY = `{
  actors { id name email type createdAt apiKeys { id name createdAt lastUsedAt } }
}`;

export function MembersView() {
  const result = useQuery<{ actors: Member[] }>(MEMBERS_QUERY);
  const [name, setName] = useState("");
  const [type, setType] = useState("HUMAN");
  const [email, setEmail] = useState("");
  // Key recién creada: se muestra UNA vez con link de onboarding copiable.
  const [freshKey, setFreshKey] = useState<{ actor: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function createActor() {
    if (!name.trim()) return;
    await mutate(
      `mutation($input: ActorCreateInput!) {
      actorCreate(input: $input) { actor { id } }
    }`,
      { input: { name: name.trim(), type, email: email.trim() || null } },
    );
    setName("");
    setEmail("");
  }

  async function createKey(member: Member) {
    const data = await mutate<{ apiKeyCreate: { key: string } }>(
      `
      mutation($input: ApiKeyCreateInput!) { apiKeyCreate(input: $input) { key } }
    `,
      { input: { actorId: member.id, name: `${member.name} key` } },
    );
    setFreshKey({ actor: member.name, key: data.apiKeyCreate.key });
    setCopied(false);
  }

  async function revokeKey(id: string) {
    await mutate(`mutation($id: ID!) { apiKeyDelete(id: $id) { success } }`, { id });
  }

  function openEdit(member: Member) {
    setEditing(member);
    setEditName(member.name);
    setEditEmail(member.email ?? "");
    setEditError(null);
  }

  function closeEdit() {
    setEditing(null);
    setEditError(null);
    setSaving(false);
  }

  async function saveEdit() {
    if (!editing) return;
    const nextName = editName.trim();
    if (!nextName) {
      setEditError("Name is required");
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      await mutate(
        `mutation($id: ID!, $input: ActorUpdateInput!) {
        actorUpdate(id: $id, input: $input) { actor { id name email } }
      }`,
        {
          id: editing.id,
          input: { name: nextName, email: editEmail.trim() || null },
        },
      );
      closeEdit();
    } catch (error) {
      const message = error instanceof GqlError ? error.message : String(error);
      setEditError(message);
      setSaving(false);
    }
  }

  function onboardingLink(key: string): string {
    return `${window.location.origin}/?key=${key}`;
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  }

  if (result.loading && !result.data) return <div className="loading">Loading…</div>;
  if (result.error) return <div className="error-banner">{result.error.message}</div>;

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          placeholder="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && createActor()}
        />
        <select value={type} onChange={(event) => setType(event.target.value)}>
          <option value="HUMAN">Human</option>
          <option value="AGENT">Agent</option>
        </select>
        <input
          placeholder="Email (optional)"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button className="btn" onClick={createActor}>
          Add member
        </button>
      </div>

      {(result.data?.actors ?? []).map((member) => {
        const historical = isHistoricalAgent(member);
        return (
          <div key={member.id} className="comment" style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Avatar actor={member} />
              <strong>{member.name}</strong>
              <span className="label-chip">
                {member.type === "AGENT" ? (
                  <>
                    <Icon name="bot" size={12} /> agent
                  </>
                ) : (
                  "human"
                )}
              </span>
              {historical && (
                <span className="label-chip" title="Historical import/demo agent">
                  historical
                </span>
              )}
              {member.email && <span style={{ color: "var(--text-faint)" }}>{member.email}</span>}
              <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button className="btn secondary" onClick={() => openEdit(member)}>
                  Edit
                </button>
                {!historical && (
                  <button className="btn secondary" onClick={() => createKey(member)}>
                    New API key
                  </button>
                )}
              </span>
            </div>
            {member.apiKeys.length > 0 && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {member.apiKeys.map((key) => (
                  <div
                    key={key.id}
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      color: "var(--text-muted)",
                      fontSize: 12,
                    }}
                  >
                    <code>{key.name}</code>
                    <span style={{ color: "var(--text-faint)" }}>
                      {key.lastUsedAt ? `last used ${key.lastUsedAt.slice(0, 10)}` : "never used"}
                    </span>
                    <button
                      style={{ color: "var(--danger)", marginLeft: "auto" }}
                      onClick={() => revokeKey(key.id)}
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {editing && (
        <div
          className="overlay"
          onMouseDown={(event) => event.target === event.currentTarget && closeEdit()}
        >
          <div className="modal">
            <div className="modal-body">
              <strong>Edit {editing.type === "AGENT" ? "agent" : "member"}</strong>
              <p style={{ color: "var(--text-muted)", margin: 0 }}>
                Changes keep the same identity, assignments, authorship, and API keys.
              </p>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                Name
                <input
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && saveEdit()}
                  autoFocus
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                Email
                <input
                  value={editEmail}
                  placeholder="optional"
                  onChange={(event) => setEditEmail(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && saveEdit()}
                />
              </label>
              {editError && <div className="error-banner">{editError}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn secondary" onClick={closeEdit} disabled={saving}>
                Cancel
              </button>
              <button className="btn" onClick={saveEdit} disabled={saving}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {freshKey && (
        <div
          className="overlay"
          onMouseDown={(event) => event.target === event.currentTarget && setFreshKey(null)}
        >
          <div className="modal">
            <div className="modal-body">
              <strong>API key for {freshKey.actor}</strong>
              <p style={{ color: "var(--text-muted)", margin: 0 }}>
                Save it now — it will not be shown again.
              </p>
              <code
                style={{
                  wordBreak: "break-all",
                  padding: 8,
                  background: "var(--surface)",
                  borderRadius: 6,
                }}
              >
                {freshKey.key}
              </code>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn secondary" onClick={() => copy(freshKey.key)}>
                  Copy key
                </button>
                <button
                  className="btn secondary"
                  onClick={() => copy(onboardingLink(freshKey.key))}
                >
                  Copy onboarding link
                </button>
                {copied && (
                  <span className="copied-hint">
                    <Icon name="check" size={14} /> Copied
                  </span>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setFreshKey(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
