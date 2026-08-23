// Documents workspace: lista y creación de documentos Markdown (PRB-541).
import { useState } from "react";
import { gql, mutate, useQuery } from "../api.ts";
import { ErrorState, LoadingState } from "../components/AsyncState.tsx";
import { Icon } from "../components/icons.tsx";
import { Link } from "../router.tsx";

const DOCUMENT_FIELDS = `id title content createdAt updatedAt archivedAt url
  creator { id name type }
  issue { id identifier title }
  project { id name }
  team { id key name }
  initiative { id name }
  cycle { id number name }`;

interface DocumentItem {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  creator: { id: string; name: string; type: string };
  issue: { id: string; identifier: string; title: string } | null;
  project: { id: string; name: string } | null;
  team: { id: string; key: string; name: string } | null;
  initiative: { id: string; name: string } | null;
  cycle: { id: string; number: number; name: string } | null;
}

export function DocumentsView() {
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const query = useQuery<{ documents: DocumentItem[] }>(
    `query($search: String) { documents(search: $search) { ${DOCUMENT_FIELDS} } }`,
    { search: search.trim() || null },
  );
  if (query.loading && !query.data) return <LoadingState />;
  if (query.error) return <ErrorState message={query.error.message} onRetry={query.refetch} />;
  const documents = query.data?.documents ?? [];
  return (
    <div className="documents-page">
      <div className="documents-toolbar">
        <input
          aria-label="Search documents"
          placeholder="Search documents"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button className="btn" onClick={() => setCreateOpen(true)}>
          <Icon name="plus" size={14} /> New document
        </button>
      </div>
      {documents.length === 0 ? (
        <div className="empty">No documents found.</div>
      ) : (
        <div className="documents-list">
          {documents.map((document) => (
            <Link key={document.id} to={`/document/${document.id}`} className="document-list-item">
              <Icon name="file-text" size={18} />
              <span>
                <strong>{document.title}</strong>
                <small>
                  {document.issue?.identifier ??
                    document.project?.name ??
                    document.team?.key ??
                    document.initiative?.name ??
                    (document.cycle ? `Cycle ${document.cycle.number}` : "Workspace")}
                  {` · ${document.creator.name}`}
                </small>
              </span>
              <time dateTime={document.updatedAt}>
                {new Date(document.updatedAt).toLocaleDateString()}
              </time>
            </Link>
          ))}
        </div>
      )}
      {createOpen && (
        <CreateDocument onClose={() => setCreateOpen(false)} onCreated={query.refetch} />
      )}
    </div>
  );
}

function CreateDocument({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!title.trim()) return setError("Document title cannot be empty.");
    setSaving(true);
    setError(null);
    try {
      await mutate(
        `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { document { id } } }`,
        { input: { title, content } },
      );
      onCreated();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="overlay" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-document-title">
        <div className="modal-header">
          <h2 id="new-document-title">New document</h2>
        </div>
        <label>
          Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
        </label>
        <label>
          Content
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={10}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
