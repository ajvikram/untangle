/**
 * Session token generation and auth middleware for the UI HTTP server.
 * Token is randomly generated at server start; required on every request
 * (header `Authorization: Bearer <token>` OR `?t=<token>` query param).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

export function checkToken(req: IncomingMessage, expected: string, url: URL): boolean {
  const header = req.headers["authorization"];
  let provided: string | undefined;
  if (header && typeof header === "string" && header.startsWith("Bearer ")) {
    provided = header.substring(7);
  } else {
    provided = url.searchParams.get("t") ?? undefined;
  }
  if (!provided) return false;
  // Constant-time compare
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
