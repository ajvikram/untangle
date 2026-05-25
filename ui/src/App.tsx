import { useEffect, useState } from "react";
import { api, TOKEN } from "./api/client.js";
import { ToastProvider } from "./components/Toaster.js";
import { DecomposeView } from "./views/DecomposeView.js";
import { PrDashboard } from "./views/PrDashboard.js";
import { GitPanel } from "./views/GitPanel.js";
import { ActivityFeed } from "./views/ActivityFeed.js";

type Tab = "decompose" | "prs" | "git" | "activity";

function parseInitialTab(): { tab: Tab; sub?: string } {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.startsWith("/proposals")) return { tab: "decompose", sub: hash.replace("/proposals/", "") || undefined };
  if (hash.startsWith("/prs")) return { tab: "prs", sub: hash.replace("/prs/", "") || undefined };
  if (hash.startsWith("/git")) return { tab: "git" };
  if (hash.startsWith("/activity")) return { tab: "activity" };
  return { tab: "decompose" };
}

export function App() {
  const [tab, setTab] = useState<Tab>(parseInitialTab().tab);
  const stored = localStorage.getItem("untangle.repo") ?? "";
  const [repo, setRepo] = useState<string>(stored);
  const [serverCwd, setServerCwd] = useState<string | null>(null);
  const [serverWorkspace, setServerWorkspace] = useState<string | null>(null);
  const [serverRepoIsGit, setServerRepoIsGit] = useState<boolean | null>(null);

  // Fetch session on mount; if no stored repo, default to the discovered
  // workspace (MCP roots → .git walk-up → cwd). User can override in the input.
  useEffect(() => {
    if (!TOKEN) return;
    api.session().then((s) => {
      setServerCwd(s.cwd);
      setServerWorkspace(s.workspace);
      setServerRepoIsGit(s.isGitRepo);
      if (!stored) {
        // Prefer resolvedRepo (git toplevel from workspace) → workspace → leave empty
        if (s.resolvedRepo) setRepo(s.resolvedRepo);
        else if (s.workspace) setRepo(s.workspace);
      }
    }).catch(() => { /* token error path renders below */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (repo) localStorage.setItem("untangle.repo", repo);
  }, [repo]);

  if (!TOKEN) {
    return (
      <div className="auth-error">
        <h2>Missing session token</h2>
        <p>Open the URL printed by the MCP server (it includes <code>?t=&lt;token&gt;</code>).</p>
      </div>
    );
  }

  // Repo not yet configured AND the server's own cwd isn't a git repo either
  const repoMissing = !repo.trim();

  return (
    <ToastProvider>
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <span className="brand-logo">⌥</span>
            <span className="brand-name">untangle</span>
          </div>
          <nav className="tabs">
            <button className={tab === "decompose" ? "active" : ""} onClick={() => setTab("decompose")}>Decompose</button>
            <button className={tab === "prs" ? "active" : ""} onClick={() => setTab("prs")}>PRs</button>
            <button className={tab === "git" ? "active" : ""} onClick={() => setTab("git")}>Git</button>
            <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Activity</button>
          </nav>
          <div className="repo-input">
            <label htmlFor="repo">repo</label>
            <input
              id="repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder={serverWorkspace ?? serverCwd ?? "/path/to/your/repo"}
              spellCheck={false}
            />
          </div>
        </header>
        {repoMissing && (
          <div className="repo-banner">
            Set the absolute path to your git repository in the <strong>repo</strong> field above.
            {serverWorkspace && !serverRepoIsGit && (
              <>
                {" "}Auto-discovery resolved to <code>{serverWorkspace}</code>, which is not a git repo.
                If your MCP host doesn't forward workspace roots, set <code>cwd</code> in your MCP config to your project folder.
              </>
            )}
          </div>
        )}
        <main className="app-main">
          {tab === "decompose" && <DecomposeView repo={repo} initialId={parseInitialTab().sub} />}
          {tab === "prs" && <PrDashboard repo={repo} initialNumber={parseInitialTab().sub} />}
          {tab === "git" && <GitPanel repo={repo} />}
          {tab === "activity" && <ActivityFeed />}
        </main>
      </div>
    </ToastProvider>
  );
}
