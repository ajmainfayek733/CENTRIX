"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastTone = "success" | "danger" | "info" | "warning";

export interface ToastItem {
  id: string;
  tone: ToastTone;
  title?: string;
  message: string;
  duration?: number;
}

interface ToastContextValue {
  showToast: (options: {
    tone?: ToastTone;
    title?: string;
    message: string;
    duration?: number;
  }) => void;
  success: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  info: (message: string, title?: string) => void;
  warning: (message: string, title?: string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    ({
      tone = "info",
      title,
      message,
      duration = 4000,
    }: {
      tone?: ToastTone;
      title?: string;
      message: string;
      duration?: number;
    }) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newToast: ToastItem = { id, tone, title, message, duration };

      setToasts((prev) => [...prev, newToast]);

      if (duration > 0) {
        setTimeout(() => {
          dismiss(id);
        }, duration);
      }
    },
    [dismiss],
  );

  const success = useCallback(
    (message: string, title?: string) => {
      showToast({ tone: "success", title, message });
    },
    [showToast],
  );

  const error = useCallback(
    (message: string, title?: string) => {
      showToast({ tone: "danger", title: title || "Error", message });
    },
    [showToast],
  );

  const info = useCallback(
    (message: string, title?: string) => {
      showToast({ tone: "info", title, message });
    },
    [showToast],
  );

  const warning = useCallback(
    (message: string, title?: string) => {
      showToast({ tone: "warning", title: title || "Warning", message });
    },
    [showToast],
  );

  return (
    <ToastContext.Provider value={{ showToast, success, error, info, warning, dismiss }}>
      {children}
      {/* Floating Toast Container */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm w-full flex-col gap-2.5 p-2 sm:bottom-6 sm:right-6"
      >
        {toasts.map((toast) => {
          const Icon = {
            success: CheckCircle2,
            danger: AlertCircle,
            warning: AlertTriangle,
            info: Info,
          }[toast.tone];

          const colorClasses = {
            success: "border-success/40 bg-surface-strong text-text-primary shadow-glass-md",
            danger: "border-danger/40 bg-surface-strong text-text-primary shadow-glass-md",
            warning: "border-warning/40 bg-surface-strong text-text-primary shadow-glass-md",
            info: "border-brand/40 bg-surface-strong text-text-primary shadow-glass-md",
          }[toast.tone];

          const iconColor = {
            success: "text-success",
            danger: "text-danger",
            warning: "text-warning",
            info: "text-brand",
          }[toast.tone];

          return (
            <div
              key={toast.id}
              role="status"
              className={cn(
                "pointer-events-auto flex items-start gap-3 rounded-lg border p-3.5 backdrop-blur-md transition-all duration-200 animate-in slide-in-from-bottom-5",
                colorClasses,
              )}
            >
              <Icon className={cn("size-5 shrink-0 mt-0.5", iconColor)} aria-hidden />
              <div className="flex-1 min-w-0">
                {toast.title && (
                  <p className="text-[13px] font-semibold text-text-primary leading-tight">
                    {toast.title}
                  </p>
                )}
                <p className="text-[12.5px] text-text-secondary leading-snug mt-0.5 break-words">
                  {toast.message}
                </p>
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="text-text-tertiary hover:text-text-primary p-0.5 rounded transition-colors shrink-0"
                aria-label="Close notification"
              >
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    // Fallback if rendered outside ToastProvider
    return {
      showToast: (opts) => console.log("Toast:", opts),
      success: (msg) => console.log("Toast success:", msg),
      error: (msg) => console.error("Toast error:", msg),
      info: (msg) => console.log("Toast info:", msg),
      warning: (msg) => console.warn("Toast warning:", msg),
      dismiss: () => {},
    };
  }
  return context;
}
