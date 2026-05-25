import { useCallback, useEffect, useState } from "react";
import { api, type PrDetails, type PrSummary, type CheckRun, type ChecksSummary } from "../api/client.js";
import { useToast } from "../components/Toaster.js";
import { ConfirmModal } from "../components/ConfirmModal.js";

interface Props {
  repo: string;
  initialNumber?: string;
}

type ConfirmAction = null | { kind: "merge"; n: number; method: "merge" | "squash" | "rebase"; protectedBase: boolean }
                       | { kind: "close"; n: number };

export function PrDashboard({ repo, initialNumber }: Props) {
  const toast = useToast();
  const [list, setList] = useState<PrSummary[]>([]);
  const [stateFilter, setStateFilter] = useState<"open" | "closed" | "merged" | "all">("open");
  const [selected, setSelected] = useState<number | null>(initialNumber ? Number(initialNumber) : null);
  const [detail, setDetail] = useState<PrDetails | null>(null);
  const [checks, setChecks] = useState<{ checks: CheckRun[]; summary: ChecksSummary } | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction>(null);

  const reload = useCallback(async () => {
    if (!repo.trim()) { setList([]); return; }
    try {
      const { prs } = await api.listPrs({ repo, state: stateFilter, limit: 50 });
      setList(prs);
      if (selected === null && prs.length > 0) setSelected(prs[0]!.number);
    } catch (err) {
      toast({ kind: "err", text: `List PRs failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [repo, stateFilter, selected, toast]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (selected === null) { setDetail(null); setChecks(null); setDiff(""); return; }
    setLoading(true);
    Promise.allSettled([
      api.viewPr(selected, repo).then((d) => setDetail(d.pr)),
      api.prChecks(selected, repo).then(setChecks),
      api.prDiff(selected, repo).then(setDiff),
    ]).finally(() => setLoading(false));
  }, [selected, repo]);

  async function doReview(event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"): Promise<void> {
    if (selected === null) return;
    let body: string | undefined;
    if (event === "REQUEST_CHANGES") {
      body = prompt("Reason for requesting changes:") ?? "";
      if (!body.trim()) return;
    } else if (event === "COMMENT") {
      body = prompt("Comment body:") ?? "";
      if (!body.trim()) return;
    }
    setBusy(true);
    try {
      await api.prReview(selected, { event, body }, repo);
      toast({ kind: "ok", text: `Review submitted: ${event}` });
      void reload();
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function doComment(): Promise<void> {
    if (selected === null) return;
    const body = prompt("Comment:");
    if (!body?.trim()) return;
    setBusy(true);
    try {
      await api.prComment(selected, body, repo);
      toast({ kind: "ok", text: "Comment posted" });
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function doMerge(method: "merge" | "squash" | "rebase", confirmProtectedBase = false): Promise<void> {
    if (selected === null) return;
    setBusy(true);
    try {
      await api.prMerge(selected, { method, deleteBranch: true, confirmProtectedBase }, repo);
      toast({ kind: "ok", text: `Merged via ${method}` });
      setConfirm(null);
      void reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If gh refuses because of protected base, surface to confirm modal
      if (msg.includes("PROTECTED_BASE") || msg.includes("protected base")) {
        setConfirm({ kind: "merge", n: selected, method, protectedBase: true });
      } else {
        toast({ kind: "err", text: msg });
      }
    } finally {
      setBusy(false);
    }
  }

  async function doClose(): Promise<void> {
    if (selected === null) return;
    setBusy(true);
    try {
      await api.prClose(selected, false, repo);
      toast({ kind: "ok", text: `Closed PR #${selected}` });
      setConfirm(null);
      void reload();
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function doReopen(): Promise<void> {
    if (selected === null) return;
    try {
      await api.prReopen(selected, repo);
      toast({ kind: "ok", text: "Reopened" });
      void reload();
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function doReady(): Promise<void> {
    if (selected === null) return;
    try {
      await api.prReady(selected, repo);
      toast({ kind: "ok", text: "Marked ready for review" });
      void reload();
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="pr-dash">
      <aside className="pr-list">
        <div className="section-title">
          PRs
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as typeof stateFilter)}>
            <option value="open">open</option>
            <option value="closed">closed</option>
            <option value="merged">merged</option>
            <option value="all">all</option>
          </select>
        </div>
        {list.length === 0 && <div className="empty">No PRs.</div>}
        <ul>
          {list.map((p) => (
            <li
              key={p.number}
              className={selected === p.number ? "active" : ""}
              onClick={() => setSelected(p.number)}
            >
              <div className="pr-title">
                <span className={`pr-state pr-state-${p.state.toLowerCase()}`}>{p.state}</span>
                {p.isDraft && <span className="badge dry">draft</span>}
                <strong>#{p.number}</strong> {p.title}
              </div>
              <div className="pr-meta">
                {p.author} · {p.headRef} → {p.baseRef} · {new Date(p.updatedAt).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      </aside>

      <section className="pr-detail">
        {selected === null ? (
          <div className="empty-detail">Select a PR on the left.</div>
        ) : (
          <>
            <header className="detail-header">
              <div>
                <h2>#{selected}{detail ? ` · ${detail.title}` : ""}</h2>
                {detail && (
                  <div className="detail-summary">
                    <a href={detail.url} target="_blank" rel="noreferrer">{detail.url}</a>
                    {" · "}
                    {detail.headRef} → {detail.baseRef}
                    {detail.reviewDecision && ` · review: ${detail.reviewDecision}`}
                    {detail.mergeable && ` · mergeable: ${detail.mergeable}`}
                  </div>
                )}
              </div>
              <div className="detail-actions">
                <button disabled={busy} onClick={() => doReview("APPROVE")}>✓ Approve</button>
                <button disabled={busy} onClick={() => doReview("REQUEST_CHANGES")}>✗ Request changes</button>
                <button disabled={busy} onClick={() => doReview("COMMENT")}>Comment review</button>
                <button disabled={busy} onClick={() => void doComment()}>Add comment</button>
                {detail?.isDraft && <button disabled={busy} onClick={() => void doReady()}>Mark ready</button>}
                {detail?.state === "OPEN" && (
                  <>
                    <select id="merge-method" defaultValue="merge" onChange={() => {}}>
                      <option value="merge">merge</option>
                      <option value="squash">squash</option>
                      <option value="rebase">rebase</option>
                    </select>
                    <button
                      className="btn-primary"
                      disabled={busy}
                      onClick={() => {
                        const m = (document.getElementById("merge-method") as HTMLSelectElement | null)?.value as "merge" | "squash" | "rebase" ?? "merge";
                        setConfirm({ kind: "merge", n: selected, method: m, protectedBase: false });
                      }}
                    >Merge</button>
                    <button className="btn-danger" disabled={busy} onClick={() => setConfirm({ kind: "close", n: selected })}>Close</button>
                  </>
                )}
                {detail?.state === "CLOSED" && !detail.mergedAt && (
                  <button disabled={busy} onClick={() => void doReopen()}>Reopen</button>
                )}
              </div>
            </header>

            {loading ? <div className="loading">Loading…</div> : (
              <div className="pr-grid">
                <div className="pr-body">
                  <h4>Description</h4>
                  <pre className="pr-body-md">{detail?.body || "(empty)"}</pre>
                  {detail?.labels?.length ? (
                    <div className="labels">{detail.labels.map((l) => <span key={l} className="badge">{l}</span>)}</div>
                  ) : null}
                </div>
                <div className="pr-checks">
                  <h4>Checks {checks ? `(${checks.summary.success}✓ ${checks.summary.failure}✗ ${checks.summary.pending}…)` : ""}</h4>
                  <ul>
                    {checks?.checks.map((c, i) => (
                      <li key={`${c.name}-${i}`} className={`check check-${c.conclusion ?? c.status}`}>
                        <span>{c.conclusion ?? c.status}</span>
                        <span>{c.name}</span>
                        {c.link && <a href={c.link} target="_blank" rel="noreferrer">log</a>}
                      </li>
                    ))}
                    {!checks?.checks.length && <li className="empty">No checks.</li>}
                  </ul>
                </div>
                <div className="pr-diff">
                  <h4>Diff</h4>
                  <pre className="diff">{diff || "(empty)"}</pre>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      <ConfirmModal
        open={confirm?.kind === "merge"}
        title={`Merge PR #${confirm?.kind === "merge" ? confirm.n : ""}`}
        destructive
        confirmLabel={`Merge (${confirm?.kind === "merge" ? confirm.method : ""})`}
        body={
          confirm?.kind === "merge" ? (
            <>
              <p>Merge with strategy <code>{confirm.method}</code> and delete the head branch.</p>
              {confirm.protectedBase && (
                <p className="warn">⚠ Base is protected (main/master/develop/production/release). Will pass <code>confirmProtectedBase</code>.</p>
              )}
            </>
          ) : null
        }
        onConfirm={() => { if (confirm?.kind === "merge") void doMerge(confirm.method, confirm.protectedBase); }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm?.kind === "close"}
        title={`Close PR #${confirm?.kind === "close" ? confirm.n : ""}`}
        destructive
        confirmLabel="Close PR"
        body={<p>This will close the PR without merging.</p>}
        onConfirm={() => void doClose()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
