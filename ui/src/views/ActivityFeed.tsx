import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type ActivityEntry } from "../api/client.js";
import { useSse } from "../hooks/useSse.js";

const KIND_LABELS: Record<string, string> = {
  analyze_diff: "Analyze",
  propose_split: "Propose",
  apply_split: "Apply",
  score_review_effort: "Score",
  route_reviewers: "Route",
  summarize_slice: "Summarize",
  decompose: "Decompose",
  git_commit: "Commit",
  git_push: "Push",
  git_checkout: "Checkout",
  git_stash: "Stash",
  pr_review: "Review",
  pr_comment: "Comment",
  pr_merge: "Merge",
  pr_close: "Close",
  pr_reopen: "Reopen",
  pr_ready: "Ready",
  ui_open: "UI",
};

type Filter = "all" | "errors" | "mutations" | "decompose";

const MUTATION_KINDS = new Set([
  "git_commit", "git_push", "git_checkout", "git_stash",
  "pr_review", "pr_comment", "pr_merge", "pr_close", "pr_reopen", "pr_ready",
  "apply_split",
]);

const DECOMPOSE_KINDS = new Set([
  "analyze_diff", "propose_split", "apply_split", "score_review_effort",
  "route_reviewers", "summarize_slice", "decompose",
]);

export function ActivityFeed() {
  const [items, setItems] = useState<ActivityEntry[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const reload = useCallback(async () => {
    const { activity } = await api.activity(200);
    setItems(activity);
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useSse((kind, data) => {
    if (kind === "activity") {
      setItems((cur) => [data as ActivityEntry, ...cur].slice(0, 300));
    }
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((e) => {
      if (filter === "errors" && !e.error) return false;
      if (filter === "mutations" && !MUTATION_KINDS.has(e.kind)) return false;
      if (filter === "decompose" && !DECOMPOSE_KINDS.has(e.kind)) return false;
      if (q && !(e.summary.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [items, filter, query]);

  const errorCount = useMemo(() => items.filter((e) => !!e.error).length, [items]);

  return (
    <div className="activity">
      <div className="section-title">
        Activity ({filtered.length}{filter === "all" ? "" : ` of ${items.length}`})
        <span className="activity-filters">
          <input
            placeholder="search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="all">all</option>
            <option value="errors">errors{errorCount > 0 ? ` (${errorCount})` : ""}</option>
            <option value="mutations">mutations</option>
            <option value="decompose">decompose flow</option>
          </select>
        </span>
      </div>
      {filtered.length === 0 && <div className="empty">No activity matches the current filter.</div>}
      <ul className="activity-list">
        {filtered.map((e) => (
          <li key={e.id} className={e.error ? "err" : ""}>
            <div className="row">
              <span className={`kind kind-${e.kind}`}>{KIND_LABELS[e.kind] ?? e.kind}</span>
              <span className="ts">{new Date(e.ts).toLocaleTimeString()}</span>
            </div>
            <div className="summary">{e.summary}</div>
            {e.error && <div className="err-msg">{e.error}</div>}
            {e.details && Object.keys(e.details).length > 0 && (
              <details><summary>details</summary><pre>{JSON.stringify(e.details, null, 2)}</pre></details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
