export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <div>{message}</div>
      {onRetry && (
        <button className="btn secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {description && <span>{description}</span>}
      {action && (
        <button className="btn" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
