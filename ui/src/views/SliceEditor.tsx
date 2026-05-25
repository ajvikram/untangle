import type { Slice } from "../api/client.js";

interface Props {
  slices: Slice[];
  proposalId: string;
}

export function SliceEditor({ slices }: Props) {
  if (slices.length === 0) {
    return <div className="empty">No slices in this proposal. Run <code>propose_split</code>.</div>;
  }
  return (
    <div className="slices">
      <div className="section-title">Stacked slices ({slices.length})</div>
      <ol className="slice-list">
        {slices.map((s, i) => (
          <li key={s.id} className="slice-card">
            <div className="slice-head">
              <span className="slice-idx">#{i + 1}</span>
              <span className="slice-title">{s.title}</span>
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
              <summary>{s.hunks.length} files</summary>
              <ul className="hunk-list">
                {[...new Set(s.hunks.map((h) => h.filePath))].map((p) => (
                  <li key={p}><code>{p}</code></li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
