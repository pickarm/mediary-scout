import { beforeEach, describe, expect, it, vi } from "vitest";
const owned = vi.hoisted(() => vi.fn(async () => ({ status: "queued", workflowRunId: "run-a", trackedSeasonId: "season-a" })));
vi.mock("../workflow-runtime", () => ({
  queueCandidateTrackingForAccount: owned,
  getAccountScopedSettings: (id: string) => ({ id }),
  getTmdbAccesses: async () => [],
}));
import { acquireMedia } from "./acquire";
beforeEach(() => owned.mockClear());
describe("authenticated API acquisition", () => {
  it("propagates its verified account rather than relying on browser cookies", async () => {
    expect(await acquireMedia({ query: "", tmdbId: 42, type: "movie", storageId: "drive-a" }, "account-a"))
      .toMatchObject({ status: "requested", workflowRunId: "run-a" });
    expect(owned).toHaveBeenCalledWith("account-a", "tmdb_movie_42", "drive-a");
  });
});
