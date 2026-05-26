import { useState } from "react";

/**
 * Recovery flow when the URL doesn't carry a token (user bookmarked the
 * bare host:port, reloaded after copy/paste, etc.). Lets them paste a token
 * and reloads with it appended; tells them where to find it.
 */
export function MissingTokenScreen() {
  const [pasted, setPasted] = useState("");

  function apply(): void {
    const t = pasted.trim();
    if (!t) return;
    const url = new URL(window.location.href);
    url.searchParams.set("t", t);
    window.location.href = url.toString();
  }

  return (
    <div className="auth-error">
      <h2>Session token required</h2>
      <p>
        This page reads the token from <code>?t=…</code> in the URL. If you bookmarked the
        bare host:port or reloaded without it, paste the token below to recover.
      </p>
      <form
        onSubmit={(e) => { e.preventDefault(); apply(); }}
        style={{ display: "flex", gap: 8, marginTop: 14 }}
      >
        <input
          type="text"
          autoFocus
          placeholder="paste session token"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
          spellCheck={false}
        />
        <button type="submit" className="btn-primary" disabled={!pasted.trim()}>
          Open
        </button>
      </form>
      <div style={{ marginTop: 22, fontSize: 13, color: "var(--muted)" }}>
        <strong>Where is the token?</strong>
        <ul style={{ paddingLeft: 18, margin: "6px 0" }}>
          <li>It is printed to <code>stderr</code> when the MCP server starts &mdash; look for <code>[untangle-ui]</code>.</li>
          <li>
            It is also stored on disk at <code>~/.config/untangle/session.json</code>:
            <pre style={{ marginTop: 4 }}>cat ~/.config/untangle/session.json | jq -r .token</pre>
          </li>
          <li>The token is stable across MCP server restarts &mdash; bookmark the full URL once.</li>
        </ul>
      </div>
    </div>
  );
}
