"use client";

import type { ActivityActiveRunSummary } from "@media-track/workflow/activity-query";
import { useLibraryProgress } from "../components/library-progress-provider";
import { findActiveRunForMedia, type LibraryProgressMediaType } from "./library-progress-client";

/**
 * THIS card's active run, read from the page-wide shared progress snapshot
 * (F13). No per-card polling: the same (账号, 网盘) scope has exactly one SSE,
 * shared with the activity feed and the sidebar badge. The match key includes
 * the media type when the caller knows it — a movie and a TV show can share a
 * numeric TMDB id, so the numeric id alone is not an identity.
 */
export function useActiveRun(
  tmdbId: number,
  seasonNumber: number | null,
  storageId: string | undefined,
  mediaType?: LibraryProgressMediaType | null,
): ActivityActiveRunSummary | null {
  const state = useLibraryProgress(storageId ?? null);
  if (!state.page) return null;
  return findActiveRunForMedia(state.page.active.items, {
    tmdbId,
    seasonNumber,
    mediaType: mediaType ?? null,
  });
}
