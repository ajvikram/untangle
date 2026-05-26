import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type Toast = { id: number; kind: "ok" | "err" | "info"; text: string };

const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});

let _nextId = 1;
const DEDUPE_WINDOW_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Keyed by `${kind}|${text}` → last ts. Suppresses dupes within DEDUPE_WINDOW.
  const recentRef = useRef<Map<string, number>>(new Map());

  const push = useCallback((t: Omit<Toast, "id">) => {
    const key = `${t.kind}|${t.text}`;
    const now = Date.now();
    const last = recentRef.current.get(key);
    if (last && now - last < DEDUPE_WINDOW_MS) {
      return; // suppress duplicate
    }
    recentRef.current.set(key, now);
    const id = _nextId++;
    setToasts((cur) => [...cur, { ...t, id }]);
    setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), 4500);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toaster">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): (t: Omit<Toast, "id">) => void {
  return useContext(ToastCtx);
}
