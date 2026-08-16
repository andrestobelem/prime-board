import { useEffect, useState } from "react";

export interface EntityModalOption {
  value: string;
  label: string;
}

export interface EntityModalField {
  key: string;
  label: string;
  type?: "text" | "textarea" | "date" | "select";
  value?: string;
  placeholder?: string;
  options?: EntityModalOption[];
}

interface EntityModalProps {
  title: string;
  fields: EntityModalField[];
  submitLabel: string;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => Promise<void> | void;
}

export function EntityModal({ title, fields, submitLabel, onClose, onSubmit }: EntityModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, field.value ?? ""])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  async function submit() {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="overlay"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="modal">
        <div className="modal-body">
          <strong>{title}</strong>
          {fields.map((field, index) => {
            const value = values[field.key] ?? "";
            const setValue = (next: string) =>
              setValues((current) => ({ ...current, [field.key]: next }));
            return (
              <label key={field.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {field.label}
                {field.type === "textarea" ? (
                  <textarea
                    autoFocus={index === 0}
                    value={value}
                    placeholder={field.placeholder}
                    onChange={(event) => setValue(event.target.value)}
                  />
                ) : field.type === "select" ? (
                  <select value={value} onChange={(event) => setValue(event.target.value)}>
                    {(field.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    autoFocus={index === 0}
                    type={field.type ?? "text"}
                    value={value}
                    placeholder={field.placeholder}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void submit()}
                  />
                )}
              </label>
            );
          })}
          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="btn" onClick={() => void submit()} disabled={submitting}>
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  onClose,
  onConfirm,
}: ConfirmModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  async function confirm() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="overlay"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="modal">
        <div className="modal-body">
          <strong>{title}</strong>
          <p style={{ color: "var(--text-muted)", margin: 0 }}>{message}</p>
          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="btn" onClick={() => void confirm()} disabled={submitting}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
