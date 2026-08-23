import { ConfirmModal } from "./EntityModal.tsx";

export type ArchiveConfirmationTarget =
  | { kind: "issue"; identifier: string }
  | { kind: "issues"; count: number }
  | { kind: "project"; name: string }
  | { kind: "saved-view"; name: string };

export interface ArchiveConfirmationCopy {
  title: string;
  message: string;
  confirmLabel: string;
}

export function archiveConfirmationCopy(
  target: ArchiveConfirmationTarget,
): ArchiveConfirmationCopy {
  switch (target.kind) {
    case "issue":
      return {
        title: "Archive issue",
        message: `Archive ${target.identifier}? It will leave active issue lists.`,
        confirmLabel: "Archive",
      };
    case "issues": {
      const noun = target.count === 1 ? "issue" : "issues";
      return {
        title: "Archive issues",
        message: `Archive ${target.count} selected ${noun}? They will leave active issue lists.`,
        confirmLabel: "Archive",
      };
    }
    case "project":
      return {
        title: "Archive project",
        message: `Archive project ${target.name}? Its issues and history are retained, but the project leaves normal views until restored.`,
        confirmLabel: "Archive",
      };
    case "saved-view":
      return {
        title: "Archive saved view",
        message: `Archive saved view ${target.name}? It will leave normal views until restored.`,
        confirmLabel: "Archive",
      };
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

export function ArchiveConfirmModal({
  target,
  onClose,
  onConfirm,
}: {
  target: ArchiveConfirmationTarget;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const copy = archiveConfirmationCopy(target);
  return <ConfirmModal {...copy} onClose={onClose} onConfirm={onConfirm} />;
}
