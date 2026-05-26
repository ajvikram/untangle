import { useEffect, useState } from "react";
import { api, type HunkRef, type Slice } from "../api/client.js";
import { useToast } from "../components/Toaster.js";

interface Props {
  slices: Slice[];
  proposalId: string;
  onChange?: () => void;
}

/**
 * Editable view of the slice stack.
 * - Inline rename slice title.
 * - Move a hunk to another slice via a dropdown.
 * - Save persists via PUT /api/proposals/:id, then triggers parent reload.
 */
export function SliceEditor({ slices: initial, proposalId, onChange }: Props) {
  const toast = useToast();
  const [slices, setSlices] = useState<Slice[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset local state when the upstream slices change (e.g. after re-propose)
  useEffect(() => {
    setSlices(initial);
    setDirty(false);
  }, [initial, proposalId]);

  function renameSlice(idx: number, title: string): void {
    setSlices((cur) => cur.map((s, i) => i === idx ? { ...s, title } : s));
    setDirty(true);
  }

  function moveHunk(fromIdx: number, hunk: HunkRef, toIdx: number): void {
    if (fromIdx === toIdx) return;
    setSlices((cur) => {
      const next = cur.map((s) => ({ ...s, hunks: [...s.hunks] }));
      next[fromIdx]!.hunks = next[fromIdx]!.hunks.filter((h) => h.hash !== hunk.hash);
      next[toIdx]!.hunks.push(hunk);
      return next;
    });
    setDirty(true);
  }

  async function save(): Promise<void> {
    setSaving(true);
    try {
      // Drop slices that ended up empty
      const compacted = slices.filter((s) => s.hunks.length > 0);
      await api.editProposal(proposalId, compacted);
      toast({ kind: "ok", text: "Slice changes saved" });
      setDirty(false);
      onChange?.();
    } catch (err) {
      toast({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  function discard(): void {
    setSlices(initial);
    setDirty(false);
  }

  if (slices.length === 0) {
    return <div className="empty">No slices in this proposal. Run <code>propose_split</code>.</div>;
  }

  return (
    <div className="slices">
      <div className="section-title">
        Stacked slices ({slices.length})
        {dirty && (
          <span className="slice-edit-actions">
            <button onClick={discard} disabled={saving}>Discard</button>
            <button className="btn-primary" onClick={() => void save()} disabled={saving}>Save</button>
          </span>
        )}
      </div>
      <ol className="slice-list">
        {slices.map((s, i) => (
          <li key={s.id} className="slice-card">
            <div className="slice-head">
              <span className="slice-idx">#{i + 1}</span>
              <input
                className="slice-title-input"
                value={s.title}
                onChange={(e) => renameSlice(i, e.target.value)}
                spellCheck={false}
              />
              <span className="slice-effort">effort {(s.effortScore * 100).toFixed(0)}%</span>
            </div>
            <div className="slice-meta">
              {s.concernIds.length} concern(s) · {s.hunks.length} hunk(s)
              {s.parentSliceId && <> · builds on <code>{s.parentSliceId.slice(0, 6)}</code></>}
            </div>
            {s.kindMix && (
              <div className="slice-mix">
                {Object.entries(s.kindMix).map(([k, v]) => (
                  <span key={k} className={`kind-badge kind-${k}`}>{k} {(v * 100).toFixed(0)}%</span>
                ))}
              </div>
            )}
            <details>
              <summary>{s.hunks.length} hunk(s)</summary>
              <ul className="hunk-list">
                {s.hunks.map((h) => (
                  <li key={h.hash}>
                    <code className="hunk-path">{h.filePath}</code>
                    <span className="hunk-loc">+{h.newLines} −{h.oldLines}</span>
                    <select
                      value={i}
                      onChange={(e) => moveHunk(i, h, Number(e.target.value))}
                      title="Move hunk to another slice"
                    >
                      {slices.map((other, j) => (
                        <option key={other.id} value={j}>
                          {j === i ? "↺ here" : `→ #${j + 1}: ${other.title.slice(0, 24)}`}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
