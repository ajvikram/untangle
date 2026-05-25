import { useCallback, useEffect, useState } from "react";
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
  pr_review: "Review",
  pr_comment: "Comment",
  pr_merge: "Merge",
  pr_close: "Close",
  pr_reopen: "Reopen",
  pr_ready: "Ready",
  ui_open: "UI",
};

export function ActivityFeed() {
  const [items, setItems] = useState<ActivityEntry[]>([]);

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

  return (
    <div className="activity">
      <div className="section-title">Activity</div>
      {items.length === 0 && <div className="empty">No activity yet.</div>}
      <ul className="activity-list">
        {items.map((e) => (
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
