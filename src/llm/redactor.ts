/**
 * LLM credential redactor.
 * §S4: GitHub tokens, API keys, env vars, and .env content
 *       are filtered out before any LLM call.
 */

/** Patterns known to contain credentials. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  // GitHub PATs (classic + fine-grained)
  /ghp_[a-zA-Z0-9]{30,}/g,
  /github_pat_[a-zA-Z0-9_]{30,}/g,
  /gho_[a-zA-Z0-9]{30,}/g,
  /ghs_[a-zA-Z0-9]{30,}/g,

  // OpenAI / Anthropic / generic API keys
  /sk-[a-zA-Z0-9]{20,}/g,
  /sk-ant-[a-zA-Z0-9-]{20,}/g,

  // npm tokens
  /npm_[a-zA-Z0-9]{30,}/g,

  // AWS keys
  /AKIA[A-Z0-9]{16}/g,

  // Generic bearer tokens
  /Bearer\s+[a-zA-Z0-9._\-]{20,}/gi,

  // .env-shaped lines (KEY=value where value looks secret)
  /^[A-Z_]{3,}=\S{8,}$/gm,

  // Private keys
  /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA )?PRIVATE KEY-----/g,
];

/**
 * Redact sensitive content from a string.
 * Returns the string with credentials replaced by [REDACTED].
 */
export function redactSensitive(input: string): string {
  let output = input;
  for (const pattern of CREDENTIAL_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    output = output.replace(pattern, "[REDACTED]");
  }
  return output;
}
