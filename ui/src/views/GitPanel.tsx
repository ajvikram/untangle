import { useCallback, useEffect, useState } from "react";
import { api, type GitBranchOut, type GitCommit, type GitStatusOut } from "../api/client.js";
import { useToast } from "../components/Toaster.js";
import { ConfirmModal } from "../components/ConfirmModal.js";

interface Props { repo: string }

const PROTECTED = ["main", "master", "develop", "production", "release"];

export function GitPanel({ repo }: Props) {
  const toast = useToast();
  const [status, setStatus] = useState<GitStatusOut["status"] | null>(null);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<GitBranchOut | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [diffMode, setDiffMode] = useState<"working" | "staged" | "head">("head");
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmPush, setConfirmPush] = useState<{ branch: string; force: boolean } | null>(null);

  const reload = useCallback(async () => {
    try {
      const [s, l, b] = await Promise.all([
        api.gitStatus(repo),
        api.gitLog(repo, 30),
        api.gitBranch(repo, false),
      ]);
      setStatus(s.status);
      setLog(l.commits);
      setBranches(b);
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }, [repo, toast]);

  const reloadDiff = useCallback(async () => {
    try {
      setDiff(await api.gitDiff({ repo, mode: diffMode }));
    } catch {
      setDiff("");
    }
  }, [repo, diffMode]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { void reloadDiff(); }, [reloadDiff]);

  async function doCommit(dryRun: boolean): Promise<void> {
    if (!commitMsg.trim()) { toast({ kind: "err", text: "Commit message required" }); return; }
    setBusy(true);
    try {
      const out = await api.gitCommit({ message: commitMsg, addAll: true, dryRun }, repo) as { sha?: string | null; dryRun: boolean };
      toast({ kind: "ok", text: out.dryRun ? "Dry-run commit ok" : `Committed ${out.sha?.slice(0, 8) ?? ""}` });
      setCommitMsg("");
      void reload();
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function doPush(forceProtected: boolean): Promise<void> {
    if (!status) return;
    setBusy(true);
    try {
      await api.gitPush({
        branch: status.branch,
        protectRefs: forceProtected ? [] : undefined,
      }, repo);
      toast({ kind: "ok", text: `Pushed ${status.branch}` });
      setConfirmPush(null);
      void reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("REF_PROTECTED")) {
        setConfirmPush({ branch: status.branch, force: true });
      } else {
        toast({ kind: "err", text: msg });
      }
    } finally {
      setBusy(false);
    }
  }

  async function doCheckout(ref: string): Promise<void> {
    try {
      await api.gitCheckout({ ref }, repo);
      toast({ kind: "ok", text: `Checked out ${ref}` });
      void reload();
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }

  const onProtected = status && PROTECTED.includes(status.branch);

  return (
    <div className="git-panel">
      <aside className="git-side">
        <div className="section-title">Status</div>
        {status ? (
          <div className="status-block">
            <div className="row"><span>branch</span><strong>{status.branch || "(detached)"}</strong></div>
            <div className="row"><span>ahead</span>{status.ahead}</div>
            <div className="row"><span>behind</span>{status.behind}</div>
            <div className="row"><span>clean</span>{status.clean ? "yes" : "no"}</div>
            {status.staged.length > 0 && (
              <details open><summary>staged ({status.staged.length})</summary>
                <ul>{status.staged.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
              </details>
            )}
            {status.modified.length > 0 && (
              <details><summary>modified ({status.modified.length})</summary>
                <ul>{status.modified.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
              </details>
            )}
            {status.untracked.length > 0 && (
              <details><summary>untracked ({status.untracked.length})</summary>
                <ul>{status.untracked.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
              </details>
            )}
            {status.conflicted.length > 0 && (
              <details open><summary className="warn">conflicted ({status.conflicted.length})</summary>
                <ul>{status.conflicted.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
              </details>
            )}
          </div>
        ) : <div className="empty">Loading…</div>}

        <div className="section-title" style={{ marginTop: 18 }}>Branches</div>
        <ul className="branch-list">
          {branches?.branches.map((b) => (
            <li key={b.name} className={b.current ? "current" : ""}>
              <code>{b.name}</code>
              {!b.current && <button onClick={() => void doCheckout(b.name)}>checkout</button>}
            </li>
          ))}
        </ul>
      </aside>

      <section className="git-main">
        <div className="commit-row">
          <input
            placeholder="commit message (stages all changes)"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            disabled={busy}
          />
          <button disabled={busy || !commitMsg.trim()} onClick={() => void doCommit(true)}>Dry-run</button>
          <button className="btn-primary" disabled={busy || !commitMsg.trim()} onClick={() => void doCommit(false)}>Commit</button>
          <button
            className={onProtected ? "btn-danger" : "btn-primary"}
            disabled={busy || !status}
            onClick={() => { if (onProtected) setConfirmPush({ branch: status!.branch, force: false }); else void doPush(false); }}
          >Push{onProtected ? " (protected!)" : ""}</button>
        </div>

        <div className="diff-row">
          <div className="diff-header">
            <h4>Diff</h4>
            <select value={diffMode} onChange={(e) => setDiffMode(e.target.value as typeof diffMode)}>
              <option value="head">HEAD (staged + unstaged)</option>
              <option value="staged">staged</option>
              <option value="working">working (unstaged)</option>
            </select>
          </div>
          <pre className="diff">{diff || "(empty)"}</pre>
        </div>

        <div className="log-row">
          <h4>Log ({log.length})</h4>
          <ul className="commit-list">
            {log.map((c) => (
              <li key={c.sha}>
                <code className="sha">{c.sha.slice(0, 8)}</code>
                <span className="commit-subj">{c.subject}</span>
                <span className="commit-meta">{c.author} · {new Date(c.date).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <ConfirmModal
        open={!!confirmPush}
        title={`Push to protected branch '${confirmPush?.branch}'`}
        destructive
        confirmLabel="Push anyway"
        body={
          <>
            <p>Branch <code>{confirmPush?.branch}</code> is in the default protected list ({PROTECTED.join(", ")}).</p>
            <p>Pushing will override the safety guard. Push uses <code>--force-with-lease</code>.</p>
          </>
        }
        onConfirm={() => void doPush(true)}
        onCancel={() => setConfirmPush(null)}
      />
    </div>
  );
}
