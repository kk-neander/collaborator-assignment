import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconAlert, IconCheck, IconInfo, IconX } from "./icons.tsx";

export type ToastTone = "info" | "success" | "warn" | "error";

export interface ToastInput {
  tone: ToastTone;
  title: string;
  message?: string;
  action?: { label: string; run(): void };
  durationMs?: number;
}

interface Toast extends ToastInput {
  id: number;
  count: number;
  expiresAt: number;
}

const DURATION: Record<ToastTone, number> = { info: 4_000, success: 3_500, warn: 9_000, error: 15_000 };

const ToastContext = createContext<(toast: ToastInput) => void>(() => {});

export function useToast(): (toast: ToastInput) => void {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((input: ToastInput) => {
    const duration = input.durationMs ?? DURATION[input.tone];
    setToasts((list) => {
      const same = list.find((t) => t.title === input.title && t.message === input.message && t.tone === input.tone);
      if (same) {
        return list.map((t) => (t === same ? { ...t, count: t.count + 1, expiresAt: Date.now() + duration, action: input.action ?? t.action } : t));
      }
      return [...list, { ...input, id: nextId.current++, count: 1, expiresAt: Date.now() + duration }];
    });
  }, []);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const soonest = Math.min(...toasts.map((t) => t.expiresAt));
    const timer = setTimeout(() => setToasts((list) => list.filter((t) => t.expiresAt > Date.now())), Math.max(50, soonest - Date.now()));
    return () => clearTimeout(timer);
  }, [toasts]);

  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
            <span className="toast-icon">{t.tone === "error" || t.tone === "warn" ? <IconAlert /> : t.tone === "success" ? <IconCheck /> : <IconInfo />}</span>
            <div className="toast-body">
              <div className="toast-title">
                {t.title}
                {t.count > 1 && <span className="toast-count">×{t.count}</span>}
              </div>
              {t.message && <div className="toast-message">{t.message}</div>}
              {t.action && (
                <button
                  className="toast-action"
                  onClick={() => {
                    t.action?.run();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <IconX />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
