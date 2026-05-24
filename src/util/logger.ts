/**
 * Structured JSON logger — writes to stderr.
 * §S8: never log credentials or full diffs.
 *
 * Every log line is a single-line JSON object with:
 *   tool, event, durationMs, details (redacted).
 */

/** Patterns that trigger redaction in log values. */
const SENSITIVE_KEYS = /^(ghp_token|token|secret|password|api_key|credential|auth)/i;
const SENSITIVE_VALUES = /ghp_[a-zA-Z0-9]{30,}|sk-[a-zA-Z0-9]{20,}|npm_[a-zA-Z0-9]{30,}/g;

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      result[key] = value.replace(SENSITIVE_VALUES, "[REDACTED]");
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

type LogListener = (line: string) => void;

class Logger {
  private listeners: LogListener[] = [];

  /** Attach an in-process listener (used by tests). */
  attach(fn: LogListener): void {
    this.listeners.push(fn);
  }

  /** Detach all listeners. */
  detachAll(): void {
    this.listeners.length = 0;
  }

  info(event: string, details: Record<string, unknown> = {}): void {
    this.emit("info", event, details);
  }

  warn(event: string, details: Record<string, unknown> = {}): void {
    this.emit("warn", event, details);
  }

  error(event: string, details: Record<string, unknown> = {}): void {
    this.emit("error", event, details);
  }

  private emit(level: string, event: string, details: Record<string, unknown>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...redactObject(details),
    });
    // Write to stderr (keeps MCP stdout clean)
    process.stderr.write(line + "\n");
    // Notify in-process listeners
    for (const fn of this.listeners) {
      fn(line);
    }
  }
}

export const logger = new Logger();
