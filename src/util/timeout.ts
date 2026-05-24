/**
 * withTimeout — wraps a promise with a timeout.
 * §S9: external calls must never block indefinitely.
 */

import { UntangleErrorImpl } from "../schemas/types.js";

/**
 * Race a promise against a timeout. Rejects with code TIMEOUT if the
 * promise doesn't resolve within `ms` milliseconds.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new UntangleErrorImpl("TIMEOUT", `Operation timed out after ${ms}ms`, true)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); },
    );
  });
}
