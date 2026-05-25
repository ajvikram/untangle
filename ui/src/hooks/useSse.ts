import { useEffect, useRef } from "react";
import { sseUrl } from "../api/client.js";

export type SseEventHandler = (kind: string, data: unknown) => void;

export function useSse(handler: SseEventHandler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const es = new EventSource(sseUrl());
    const wrap = (kind: string) => (e: MessageEvent): void => {
      try { handlerRef.current(kind, JSON.parse(e.data as string)); } catch { /* ignore */ }
    };
    es.addEventListener("activity", wrap("activity"));
    es.addEventListener("change", wrap("change"));
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do
    };
    return () => es.close();
  }, []);
}
