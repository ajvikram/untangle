/**
 * Server-Sent Events helpers.
 * UI subscribes to /api/sse to receive live updates.
 */

import type { ServerResponse } from "node:http";
import { getStore } from "./state.js";

export function startSseStream(res: ServerResponse): () => void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Initial comment line so EventSource sees an open stream
  res.write(": connected\n\n");

  const store = getStore();

  const onActivity = (entry: unknown): void => {
    try {
      res.write(`event: activity\ndata: ${JSON.stringify(entry)}\n\n`);
    } catch { /* response closed */ }
  };
  const onChange = (entry: unknown): void => {
    try {
      res.write(`event: change\ndata: ${JSON.stringify(entry)}\n\n`);
    } catch { /* response closed */ }
  };
  store.on("activity", onActivity);
  store.on("change", onChange);

  // Heartbeat to keep proxies happy and detect dead sockets
  const heartbeat = setInterval(() => {
    try {
      res.write(": hb\n\n");
    } catch { /* response closed */ }
  }, 25_000);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    store.off("activity", onActivity);
    store.off("change", onChange);
    try { res.end(); } catch { /* ignore */ }
  };
  res.on("close", cleanup);
  return cleanup;
}
