"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "../lib/use-router";
import { useLibraryProgress } from "./library-progress-provider";

/**
 * The "获取中 / disabled" state is owned by the SERVER (a queued/running
 * workflow run), not by client state — so it survives reloads and a closed
 * browser. This component is the client's way of learning, without a manual
 * refresh, WHEN the server says a run has finished: it watches the page-wide
 * shared progress snapshot (the same single SSE the activity page and cards
 * use) and refreshes the server view ONCE per observed run leaving the active
 * set. There is no fixed-interval `router.refresh()` any more — a finished run
 * is an event, not a 5-second bet.
 *
 * Library pages keep it mounted even when their bounded preview contains no
 * active item, so work outside that preview can still release completed cards.
 */

/**
 * Should this snapshot trigger a server re-read?
 *
 * `previous === null` = first snapshot of this mount: the server rendered a card
 * as 获取中, so an already-empty active set means the run finished between render
 * and hydration → refresh.
 *
 * Afterwards: refresh when a previously observed run LEFT the active set. With two
 * concurrent runs, the first one finishing must release ITS card immediately, even
 * while the other keeps running — waiting for "all done" left finished cards stuck
 * on 获取中. New runs appearing need no refresh (their own click already refreshed),
 * and an unchanged set never refreshes (no loop).
 */
export function shouldRefreshAfterProgress(
  previous: ReadonlySet<string> | null,
  next: ReadonlySet<string>,
  initiallyAcquiring = true,
  previousTotal: number | null = null,
  nextTotal: number | null = null,
): boolean {
  if (previous === null) return initiallyAcquiring && next.size === 0;
  if (previousTotal !== null && nextTotal !== null && nextTotal < previousTotal) return true;
  for (const runId of previous) {
    if (!next.has(runId)) return true;
  }
  return false;
}

export function AcquiringPoller({ storageId, initiallyAcquiring = true }: {
  storageId?: string | undefined;
  initiallyAcquiring?: boolean;
}) {
  const router = useRouter();
  const scope = storageId ?? null;
  const page = useLibraryProgress(scope).page;
  const previous = useRef<ReadonlySet<string> | null>(null);
  const previousTotal = useRef<number | null>(null);

  // A different drive is a different run set: never read a scope change as "all
  // of the old drive's runs finished".
  useEffect(() => {
    previous.current = null;
    previousTotal.current = null;
  }, [scope]);

  useEffect(() => {
    // No snapshot yet: never refresh on a guess.
    if (!page) return;
    const next = new Set(page.active.items.map((run) => run.runId));
    if (shouldRefreshAfterProgress(previous.current, next, initiallyAcquiring, previousTotal.current, page.totals.active)) router.refresh();
    previous.current = next;
    previousTotal.current = page.totals.active;
  }, [page, router, initiallyAcquiring]);

  return null;
}
