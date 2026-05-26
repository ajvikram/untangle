import { useEffect, useMemo, useState } from "react";
import { api, type ProposalRecord } from "../api/client.js";
import { ConcernGraph } from "./ConcernGraph.js";
import { SliceEditor } from "./SliceEditor.js";
import { ConfirmModal } from "../components/ConfirmModal.js";
import { useToast } from "../components/Toaster.js";
import { useSse } from "../hooks/useSse.js";

interface Props {
  repo: string;
  initialId?: string;
}

export function DecomposeView({ repo, initialId }: Props) {
  const toast = useToast();
  const [proposals, setProposals] = useState<ProposalRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialId ?? null);
  const [detail, setDetail] = useState<ProposalRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmApply, setConfirmApply] = useState<{ dryRun: boolean } | null>(null);

  async function reload(): Promise<void> {
    const { proposals } = await api.listProposals();
    setProposals(proposals);
    if (!selectedId && proposals.length > 0) setSelectedId(proposals[0]!.id);
  }

  useEffect(() => { void reload(); }, []);
  useSse((kind) => { if (kind === "change") void reload(); });

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    void api.getProposal(selectedId).then(setDetail).catch(() => setDetail(null));
  }, [selectedId, proposals.length]);

  const branch = detail?.branch ?? "";
  const base = detail?.base ?? "main";

  async function doPropose(): Promise<void> {
    if (!detail) return;
    setBusy(true);
    try {
      await api.reproposeProposal(detail.id, {});
      toast({ kind: "ok", text: "Proposed split" });
      await reload();
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function doApply(dryRun: boolean): Promise<void> {
    if (!detail || !detail.proposal) return;
    setBusy(true);
    try {
      const result = await api.applyProposal(detail.id, {
        target: { kind: "branch", repo, branch: branch || "HEAD", base },
        dryRun,
        draftPRs: true,
      });
      toast({ kind: "ok", text: dryRun ? "Dry-run apply succeeded" : "Applied — stacked branches/PRs created" });
      void result;
      await reload();
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setConfirmApply(null);
    }
  }

  const slices = detail?.proposal?.slices ?? [];

  async function doClearAll(): Promise<void> {
    if (!confirm("Clear all proposals from history? This cannot be undone.")) return;
    try {
      await api.clearProposals();
      toast({ kind: "ok", text: "Proposals cleared" });
      setSelectedId(null);
      await reload();
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function doDelete(id: string): Promise<void> {
    try {
      await api.deleteProposal(id);
      if (selectedId === id) setSelectedId(null);
      await reload();
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="decompose">
      <aside className="proposal-list">
        <div className="section-title">
          Proposals
          {proposals.length > 0 && (
            <button className="link-btn" onClick={() => void doClearAll()} title="Clear all proposals">clear all</button>
          )}
        </div>
        {proposals.length === 0 && <div className="empty">No proposals yet. Run <code>analyze_diff</code> via your agent.</div>}
        <ul>
          {proposals.map((p) => (
            <li
              key={p.id}
              className={selectedId === p.id ? "active" : ""}
              onClick={() => setSelectedId(p.id)}
            >
              <div className="proposal-title">
                {p.proposal ? `${p.proposal.slices.length} slices` : "graph only"}
                {p.applied && <span className={`badge ${p.applied.dryRun ? "dry" : "live"}`}>{p.applied.dryRun ? "dry-run" : "applied"}</span>}
                <button
                  className="link-btn proposal-delete"
                  title="Delete proposal"
                  onClick={(e) => { e.stopPropagation(); void doDelete(p.id); }}
                >×</button>
              </div>
              <div className="proposal-meta">
                {p.branch ?? "—"} → {p.base ?? "—"} · {new Date(p.ts).toLocaleTimeString()}
              </div>
            </li>
          ))}
        </ul>
      </aside>

      <section className="proposal-detail">
        {detail ? (
          <DetailContent
            detail={detail}
            busy={busy}
            onPropose={doPropose}
            onDryRun={() => setConfirmApply({ dryRun: true })}
            onApply={() => setConfirmApply({ dryRun: false })}
            onSlicesChanged={() => void reload()}
          />
        ) : (
          <div className="empty-detail">Select a proposal on the left.</div>
        )}
      </section>

      <ConfirmModal
        open={!!confirmApply}
        title={confirmApply?.dryRun ? "Dry-run apply" : "Apply split"}
        body={
          <>
            <p>Materialize <strong>{slices.length}</strong> slice(s) {confirmApply?.dryRun ? "locally only" : "and push stacked draft PRs"}.</p>
            <p>Target: <code>{branch || "HEAD"} → {base}</code></p>
          </>
        }
        destructive={!confirmApply?.dryRun}
        confirmLabel={confirmApply?.dryRun ? "Dry-run" : "Apply"}
        onConfirm={() => doApply(!!confirmApply?.dryRun)}
        onCancel={() => setConfirmApply(null)}
      />
    </div>
  );
}

function DetailContent({ detail, busy, onPropose, onDryRun, onApply, onSlicesChanged }: {
  detail: ProposalRecord;
  busy: boolean;
  onPropose: () => void;
  onDryRun: () => void;
  onApply: () => void;
  onSlicesChanged: () => void;
}) {
  const graph = detail.graph;
  const proposal = detail.proposal;
  const slices = proposal?.slices ?? [];
  const hasGraph = !!graph;
  const summary = useMemo(() => {
    if (!graph) return null;
    return {
      concerns: graph.concerns?.length ?? 0,
      files: graph.meta?.fileCount ?? 0,
      loc: graph.meta?.loc ?? 0,
      languages: graph.meta?.languagesDetected ?? [],
    };
  }, [graph]);

  return (
    <>
      <header className="detail-header">
        <div>
          <h2>Proposal · {detail.id.slice(0, 8)}</h2>
          {summary && (
            <div className="detail-summary">
              {summary.concerns} concerns · {summary.files} files · {summary.loc} LoC
              {summary.languages.length > 0 && ` · ${summary.languages.join(", ")}`}
            </div>
          )}
        </div>
        <div className="detail-actions">
          {!proposal && hasGraph && (
            <button className="btn-primary" disabled={busy} onClick={onPropose}>
              Run propose_split
            </button>
          )}
          <button disabled={busy || !proposal} onClick={onDryRun}>Dry-run apply</button>
          <button className="btn-primary" disabled={busy || !proposal} onClick={onApply}>Apply (stacked PRs)</button>
        </div>
      </header>

      {detail.applied && (
        <div className={`applied-banner ${detail.applied.dryRun ? "dry" : "live"}`}>
          {detail.applied.dryRun ? "Dry-run created" : "Applied"} {detail.applied.branches.length} branch(es)
          {detail.applied.prs.length > 0 && ` · ${detail.applied.prs.length} PR(s) opened`}
          <ul>
            {detail.applied.prs.map((p) => (
              <li key={p.url}><a href={p.url} target="_blank" rel="noreferrer">{p.url}</a></li>
            ))}
          </ul>
        </div>
      )}

      <div className="detail-grid">
        <div className="graph-pane">
          {hasGraph
            ? <ConcernGraph graph={graph} slices={slices} />
            : <div className="empty">No concern graph yet.</div>}
        </div>
        <div className="slices-pane">
          <SliceEditor slices={slices} proposalId={detail.id} onChange={onSlicesChanged} />
        </div>
      </div>
    </>
  );
}
