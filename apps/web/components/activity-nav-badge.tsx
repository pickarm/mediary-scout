"use client";

import { useLibraryActiveTotal } from "./library-progress-provider";

/** Small live count of active (queued + running) acquisitions, shown on the 活动
 *  nav entry. Reads the page-wide shared progress snapshot — the SAME single SSE
 *  the activity page and the cards use — so it costs no request of its own (it
 *  used to poll /api/activity every 5s, once per mounted badge). Hidden at zero. */
export function ActivityNavBadge({ storageId }: { storageId?: string | undefined }) {
  const count = useLibraryActiveTotal(storageId ?? null);
  if (count === 0) {
    return null;
  }
  return <span className="nav-badge">{count}</span>;
}
