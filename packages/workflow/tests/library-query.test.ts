import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  LibraryQueryInputError,
  normalizePostgresLibraryQueryInput,
  PostgresLibraryQuery,
} from "../src/library/library-query.js";

describe("normalizePostgresLibraryQueryInput", () => {
  it("accepts updatedAt sort and preserves asc/desc direction", () => {
    const parsed = normalizePostgresLibraryQueryInput({
      accountId: " acct_1 ",
      connectedStorageId: null,
      sort: "updatedAt",
      direction: "desc",
    });
    expect(parsed).toMatchObject({
      accountId: "acct_1",
      connectedStorageId: null,
      sort: "updatedAt",
      direction: "desc",
      page: 1,
      pageSize: 48,
    });
  });

  it("rejects unsupported sort keys", () => {
    expect(() =>
      normalizePostgresLibraryQueryInput({
        accountId: "acct_1",
        connectedStorageId: null,
        sort: "unknown" as never,
      }),
    ).toThrow(LibraryQueryInputError);
  });
});

describe("PostgresLibraryQuery updatedAt sorting", () => {
  it("generates ORDER BY updated_at NULLS LAST and maps updatedAt items", async () => {
    const querySpy = vi.fn(async () => ({
      rows: [
        {
          total: 2,
          items: [
            {
              tmdb_id: 101,
              type: "movie",
              title: "新片",
              year: 2026,
              posterPath: null,
              releaseDate: "2026-01-01",
              seasonCount: 1,
              obtainedEpisodes: 1,
              totalAiredEpisodes: 1,
              totalEpisodes: 1,
              state: "complete",
              airing: false,
              acquiring: false,
              autoAcquire: null,
              updatedAt: "2026-11-26T10:00:00.000Z",
            },
            {
              tmdb_id: 102,
              type: "tv",
              title: "导入旧片",
              year: 2020,
              posterPath: null,
              releaseDate: null,
              seasonCount: 1,
              obtainedEpisodes: 12,
              totalAiredEpisodes: 12,
              totalEpisodes: 12,
              state: "complete",
              airing: false,
              acquiring: false,
              autoAcquire: false,
              updatedAt: null,
            },
          ],
        },
      ],
    }));
    const query = new PostgresLibraryQuery({ query: querySpy } as unknown as Pool);

    const page = await query.list({
      accountId: "acct_1",
      connectedStorageId: "cs_1",
      sort: "updatedAt",
      direction: "desc",
    });

    expect(querySpy).toHaveBeenCalledTimes(1);
    const sql = String((querySpy.mock.calls[0] as unknown[] | undefined)?.[0] ?? "");
    expect(sql).toContain("NULLIF(wr.payload->>'finishedAt', '')");
    expect(sql).toContain("NULLIF(wr.payload->>'startedAt', '')");
    expect(sql).toContain("ORDER BY updated_at DESC NULLS LAST");
    expect(page.items).toEqual([
      expect.objectContaining({ tmdbId: 101, updatedAt: "2026-11-26T10:00:00.000Z" }),
      expect.objectContaining({ tmdbId: 102, updatedAt: null }),
    ]);
  });
});
