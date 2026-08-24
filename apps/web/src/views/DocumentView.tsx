// Document editor: Markdown, enlaces al recurso y archivo reversible (PRB-541).
import { useEffect, useState } from "react";
import { gql, mutate, useQuery } from "../api.ts";
import { ErrorState, LoadingState } from "../components/AsyncState.tsx";
import { MarkdownContent } from "../components/MarkdownContent.tsx";
import { Link, navigate } from "../router.tsx";

const DOCUMENT_QUERY = `query($id: ID!) {
  document(id: $id) {
    id title content createdAt updatedAt archivedAt
    creator { name type }
    issue { identifier title }
    project { id name }
    team { key name }
    initiative { id name }
    cycle { number name }
  }
}`;

type DocumentData = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  creator: { name: string; type: string };
  issue: { identifier: string; title: string } | null;
  project: { id: string; name: string } | null;
  team: { key: string; name: string } | null;
  initiative: { name: string } | null;
  cycle: { number: number; name: string } | null;
};

export function DocumentView({ documentId }: { documentId: string }) {
  const query = useQuery<{ document: DocumentData | null }>(DOCUMENT_QUERY, { id: documentId });
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!query.data?.document) return;
    setTitle(query.data.document.title);
    setContent(query.data.document.content);
  }, [query.data?.document]);
  if (query.loading && !query.data) return <LoadingState />;
  if (query.error) return <ErrorState message={query.error.message} onRetry={query.refetch} />;
  const document = query.data?.document;
  if (!document) return <div className="empty">Document not found.</div>;
  const currentDocument: DocumentData = document;
  const target = document.issue
    ? `Issue ${document.issue.identifier}`
    : (document.project?.name ??
      document.team?.key ??
      document.initiative?.name ??
      (document.cycle ? `Cycle ${document.cycle.number}` : "Workspace"));
  async function save() {
    setError(null);
    try {
      await mutate(
        `mutation($id: ID!, $input: DocumentUpdateInput!) { documentUpdate(id: $id, input: $input) { document { id title content updatedAt } } }`,
        { id: currentDocument.id, input: { title, content } },
      );
      setEditing(false);
      query.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function toggleArchive() {
    try {
      const mutation = currentDocument.archivedAt ? "documentUnarchive" : "documentArchive";
      await mutate(`mutation($id: ID!) { ${mutation}(id: $id) { success } }`, {
        id: currentDocument.id,
      });
      if (currentDocument.archivedAt) await query.refetch();
      else navigate("/documents");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <article className="document-page">
      <div className="document-header">
        <Link to="/documents">Documents</Link>
        <span>·</span>
        <span>{target}</span>
        <span className="right">
          <button className="btn secondary" onClick={() => setEditing((value) => !value)}>
            {editing ? "Cancel" : "Edit"}
          </button>
          <button className="btn secondary" onClick={() => void toggleArchive()}>
            {document.archivedAt ? "Restore" : "Archive"}
          </button>
        </span>
      </div>
      {editing ? (
        <div className="document-editor">
          <input
            className="document-title-editor"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            className="description-editor"
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <button className="btn" onClick={() => void save()}>
            Save changes
          </button>
        </div>
      ) : (
        <>
          <h1>{document.title}</h1>
          <p className="hint">
            Edited {new Date(document.updatedAt).toLocaleString()} by {document.creator.name}
          </p>
          <MarkdownContent text={document.content} />
          {error && <p className="error">{error}</p>}
        </>
      )}
    </article>
  );
}
