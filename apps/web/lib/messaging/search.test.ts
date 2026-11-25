import { describe, expect, it } from "vitest";
import type { MediaSearchCandidate } from "@media-track/workflow";
import { createMessagingSearch } from "./search";

const movie: MediaSearchCandidate = { tmdbId: 99, mediaType: "movie", title: "同名作品", originalTitle: "Same", year: 2024, overview: "", posterPath: null, backdropPath: null, seasons: [] };
const television: MediaSearchCandidate = { ...movie, mediaType: "tv", seasons: [{ seasonNumber: 1, episodeCount: 8, latestAiredEpisode: 8 }, { seasonNumber: 2, episodeCount: 9, latestAiredEpisode: 9 }] };
describe("messaging title search", () => {
  it("keeps movie and TV identities distinct and asks for the actual season", async () => {
    const search = createMessagingSearch(async () => ({ searchMedia: async () => [movie, television] }));
    const input = { accountId: "alice", connectionId: "bot", conversationId: "chat", query: "同名作品", history: [] };
    const titles = await search(input);
    expect(titles.choices.map((c) => c.value)).toEqual(["tmdb_movie_99", "tmdb_tv_99"]);
    const seasons = await search({ ...input, history: [{ kind: "title", value: "tmdb_tv_99" }] });
    expect(seasons.choices.map((c) => c.value)).toEqual(["1", "2"]);
    const selected = await search({ ...input, history: [{ kind: "title", value: "tmdb_tv_99" }, { kind: "season", value: "2" }] });
    expect(selected.request).toEqual({ titleId: "tmdb_tv_99", mediaType: "tv", seasonNumber: 2, title: "同名作品" });
  });
  it("passes the owning account to the provider and directly obtains a sole movie", async () => {
    const accounts: string[] = [];
    const search = createMessagingSearch(async (account) => { accounts.push(account); return { searchMedia: async () => [movie] }; });
    const found = await search({ accountId: "bob", connectionId: "bot", conversationId: "chat", query: "Same", history: [] });
    expect(accounts).toEqual(["bob"]);
    expect(found.request).toMatchObject({ titleId: "tmdb_movie_99", mediaType: "movie", seasonNumber: null });
  });
});
