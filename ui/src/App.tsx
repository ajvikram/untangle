import { useEffect, useRef, useState } from "react";
import { api, TOKEN } from "./api/client.js";
import { ToastProvider, useToast } from "./components/Toaster.js";
import { MissingTokenScreen } from "./components/MissingTokenScreen.js";
import { ConfirmModal } from "./components/ConfirmModal.js";
import { DecomposeView } from "./views/DecomposeView.js";
import { PrDashboard } from "./views/PrDashboard.js";
import { GitPanel } from "./views/GitPanel.js";
import { ActivityFeed } from "./views/ActivityFeed.js";

type Tab = "decompose" | "prs" | "git" | "activity";

const TAB_ORDER: Tab[] = ["decompose", "prs", "git", "activity"];

function parseInitialTab(): { tab: Tab; sub?: string } {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.startsWith("/proposals")) return { tab: "decompose", sub: hash.replace("/proposals/", "") || undefined };
  if (hash.startsWith("/prs")) return { tab: "prs", sub: hash.replace("/prs/", "") || undefined };
  if (hash.startsWith("/git")) return { tab: "git" };
  if (hash.startsWith("/activity")) return { tab: "activity" };
  return { tab: "decompose" };
}

export function App() {
  if (!TOKEN) return <MissingTokenScreen />;
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}

function AppInner() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>(parseInitialTab().tab);
  const stored = localStorage.getItem("untangle.repo") ?? "";
  const [repo, setRepo] = useState<string>(stored);
  const [serverCwd, setServerCwd] = useState<string | null>(null);
  const [serverWorkspace, setServerWorkspace] = useState<string | null>(null);
  const [serverRepoIsGit, setServerRepoIsGit] = useState<boolean | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const repoInputRef = useRef<HTMLInputElement>(null);

  // Fetch session on mount
  useEffect(() => {
    api.session().then((s) => {
      setServerCwd(s.cwd);
      setServerWorkspace(s.workspace);
      setServerRepoIsGit(s.isGitRepo);
      if (!stored && s.resolvedRepo && s.isGitRepo) setRepo(s.resolvedRepo);
    }).catch(() => { /* token error path renders below */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (repo) localStorage.setItem("untangle.repo", repo);
  }, [repo]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.key === "?" && !inField) { e.preventDefault(); setShowHelp((h) => !h); return; }
      if (e.key === "Escape") { setShowHelp(false); return; }
      if (inField) return;
      if (e.key === "1") { e.preventDefault(); setTab("decompose"); }
      else if (e.key === "2") { e.preventDefault(); setTab("prs"); }
      else if (e.key === "3") { e.preventDefault(); setTab("git"); }
      else if (e.key === "4") { e.preventDefault(); setTab("activity"); }
      else if (e.key === "/") { e.preventDefault(); repoInputRef.current?.focus(); repoInputRef.current?.select(); }
      else if (e.key === "g" || e.key === "G") {
        // sequence: 'g' then a tab key. Lightweight Vim-style.
        const handler = (e2: KeyboardEvent): void => {
          window.removeEventListener("keydown", handler);
          if (e2.key === "d") setTab("decompose");
          else if (e2.key === "p") setTab("prs");
          else if (e2.key === "g") setTab("git");
          else if (e2.key === "a") setTab("activity");
        };
        window.addEventListener("keydown", handler, { once: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function doRegenerate(): Promise<void> {
    try {
      const { url } = await api.regenerateToken();
      window.location.href = url;
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
      setConfirmRegen(false);
    }
  }

  const repoMissing = !repo.trim();
  void TAB_ORDER; // silence unused

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-logo">⌥</span>
          <span className="brand-name">untangle</span>
        </div>
        <nav className="tabs">
          <button className={tab === "decompose" ? "active" : ""} onClick={() => setTab("decompose")}>Decompose <kbd>1</kbd></button>
          <button className={tab === "prs" ? "active" : ""} onClick={() => setTab("prs")}>PRs <kbd>2</kbd></button>
          <button className={tab === "git" ? "active" : ""} onClick={() => setTab("git")}>Git <kbd>3</kbd></button>
          <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Activity <kbd>4</kbd></button>
        </nav>
        <div className="header-actions">
          <button title="Keyboard shortcuts (?)" onClick={() => setShowHelp(true)}>?</button>
          <button title="Regenerate session token" onClick={() => setConfirmRegen(true)}>↻ token</button>
        </div>
        <div className="repo-input">
          <label htmlFor="repo">repo</label>
          <input
            id="repo"
            ref={repoInputRef}
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
              If your MCP host doesn&apos;t forward workspace roots, set <code>cwd</code> in your MCP config to your project folder.
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

      <ConfirmModal
        open={confirmRegen}
        title="Regenerate session token?"
        destructive
        confirmLabel="Rotate + redirect"
        body={
          <>
            <p>This invalidates the current token. Any other browser tabs open to this dashboard will need to be reopened with the new URL.</p>
            <p>You will be redirected to the new URL automatically.</p>
          </>
        }
        onConfirm={() => void doRegenerate()}
        onCancel={() => setConfirmRegen(false)}
      />

      {showHelp && (
        <div className="modal-backdrop" onClick={() => setShowHelp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard shortcuts</h3>
            <table className="kbd-table">
              <tbody>
                <tr><td><kbd>1</kbd>–<kbd>4</kbd></td><td>Switch tabs</td></tr>
                <tr><td><kbd>g</kbd> <kbd>d</kbd>/<kbd>p</kbd>/<kbd>g</kbd>/<kbd>a</kbd></td><td>Vim-style tab nav</td></tr>
                <tr><td><kbd>/</kbd></td><td>Focus repo input</td></tr>
                <tr><td><kbd>?</kbd></td><td>This help</td></tr>
                <tr><td><kbd>Esc</kbd></td><td>Close modal</td></tr>
              </tbody>
            </table>
            <div className="modal-actions">
              <button onClick={() => setShowHelp(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
