"use client";

import { useEffect, type ReactNode } from "react";
import { X, AlertTriangle } from "lucide-react";
import { Button } from "./index";
import { cn } from "@/lib/utils";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Modal({ open, onClose, title, children, footer, className }: ModalProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) {
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "w-full max-w-md rounded-xl border border-glass-border bg-surface-strong p-5 shadow-glass-lg backdrop-blur-md animate-in zoom-in-95 duration-150",
          className,
        )}
      >
        {title && (
          <div className="flex items-center justify-between gap-3 border-b border-border pb-3 mb-4">
            <h3 className="text-base font-semibold text-text-primary">{title}</h3>
            <button
              type="button"
              onClick={onClose}
              className="text-text-tertiary hover:text-text-primary p-1 rounded transition-colors"
              aria-label="Close modal"
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        <div className="text-sm text-text-secondary leading-relaxed">{children}</div>

        {footer && <div className="mt-5 flex items-center justify-end gap-2.5 pt-3">{footer}</div>}
      </div>
    </div>
  );
}

export interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  loading?: boolean;
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  loading = false,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          {tone === "danger" && <AlertTriangle className="size-4.5 text-danger shrink-0" />}
          <span>{title}</span>
        </div>
      }
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === "danger" ? "danger" : "primary"}
            size="sm"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? "Processing..." : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="py-1">{message}</div>
    </Modal>
  );
}
