import type { MediaSearchCandidate, MediaSearchProvider } from "@media-track/workflow";
import type { MessagingCommandPorts, MessagingSearchInput, MessagingSearchResult } from "./commands";

export function createMessagingSearch(providerForAccount: (accountId: string) => Promise<MediaSearchProvider>): MessagingCommandPorts["search"] {
  return async (input: MessagingSearchInput): Promise<MessagingSearchResult> => {
    const provider = await providerForAccount(input.accountId);
    const found = await provider.searchMedia({ query: input.query });
    const selectedId = input.history.find((h) => h.kind === "title")?.value;
    const selected = selectedId ? found.find((c) => identity(c) === selectedId) : found.length === 1 ? found[0] : undefined;
    if (!selected) {
      if (selectedId) return { choices: [] };
      return { choices: found.slice(0, 5).map((c) => ({ kind: "title", value: identity(c), label: `${c.title} (${c.year ?? "年份未知"}) · ${c.mediaType === "movie" ? "电影" : "剧集"}` })) };
    }
    if (selected.mediaType === "movie") return { choices: [], request: { titleId: identity(selected), mediaType: "movie", title: selected.title, seasonNumber: null } };
    const seasons = selected.seasons.filter((s) => s.seasonNumber > 0);
    const seasonValue = input.history.find((h) => h.kind === "season")?.value;
    const season = seasonValue ? seasons.find((s) => String(s.seasonNumber) === seasonValue) : seasons.length === 1 ? seasons[0] : undefined;
    if (!season) {
      if (seasonValue) return { choices: [] };
      return { choices: seasons.map((s) => ({ kind: "season", value: String(s.seasonNumber), label: `${selected.title} · 第 ${s.seasonNumber} 季（${s.episodeCount} 集）`, history: [{ kind: "title", value: identity(selected) }] })) };
    }
    return { choices: [], request: { titleId: identity(selected), mediaType: "tv", title: selected.title, seasonNumber: season.seasonNumber } };
  };
}

function identity(candidate: MediaSearchCandidate): string { return `tmdb_${candidate.mediaType}_${candidate.tmdbId}`; }
