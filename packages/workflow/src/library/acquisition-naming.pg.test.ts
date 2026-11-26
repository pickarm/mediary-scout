import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MediaTitle } from "../domain.js";
import { FakeStorageExecutor } from "../fakes.js";
import { initializeWorkflowPostgresSchema } from "../postgres.js";
import {
  attachAcquisitionNamingDatabase,
  PostgresAcquisitionNamingDatabase,
  prepareAcquisitionNaming,
} from "./acquisition-naming.js";
import { PostgresScanStore } from "./scan-store.js";
import type { ScanConfiguration } from "./scanner.js";

const adminConnectionString =
  process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL ?? process.env.TEST_POSTGRES_ADMIN;
const integration = describe.skipIf(!adminConnectionString);

integration("F14b acquisition naming SQL", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let scanStore: PostgresScanStore;
  let databaseName: string;

  const dbTest = (name: string, test: () => Promise<void>) => it(name, test, 30_000);

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("Integration connection string is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `acquisition_naming_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(adminConnectionString);
    databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString() });
    pool.on("error", () => {});
    await initializeWorkflowPostgresSchema(pool);
    scanStore = new PostgresScanStore(pool);
  }, 30_000);

  afterAll(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      try {
        if (adminPool && databaseName) {
          await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        }
      } finally {
        if (adminPool) await adminPool.end();
      }
    }
  }, 30_000);

  async function createScope(): Promise<{
    accountId: string;
    connectedStorageId: string;
  }> {
    const suffix = randomUUID().replaceAll("-", "");
    const accountId = `acct_${suffix}`;
    const connectedStorageId = `storage_${suffix}`;
    await pool.query(
      "INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ($1, $2, '', false, now()::text)",
      [accountId, `user_${suffix}`],
    );
    await pool.query(
      "INSERT INTO connected_storages " +
        "(id, account_id, provider, provider_uid, payload, created_at) VALUES ($1, $2, 'guangya', $3, '{}'::jsonb, now()::text)",
      [connectedStorageId, accountId, `uid_${suffix}`],
    );
    return { accountId, connectedStorageId };
  }

  function configuration(input: {
    scope: { accountId: string; connectedStorageId: string };
    configId: string;
    tvTargetDirectoryId?: string;
    templates?: Record<string, string>;
  }): ScanConfiguration {
    return {
      configId: input.configId,
      scope: input.scope,
      sourceRoots: [{ directoryId: `scan_${input.configId}`, name: "扫描源" }],
      movieTargetDirectoryId: "movie_root",
      movieTargetDirectoryName: "电影",
      tvTargetDirectoryId: input.tvTargetDirectoryId ?? "tv_root",
      tvTargetDirectoryName: "剧集",
      mediaKind: "mixed",
      dailyScheduleEnabled: false,
      dailyScheduleTime: null,
      dailyScheduleTimezone: "Asia/Shanghai",
      autoOrganize: false,
      autoAcquire: false,
      templates: input.templates ?? {},
    };
  }

  function title(tmdbId = 501): MediaTitle {
    return {
      id: `tmdb_tv_${tmdbId}`,
      tmdbId,
      type: "tv",
      title: "规范标题",
      originalTitle: "Canonical Show",
      year: 2026,
      aliases: [],
    };
  }

  async function preparedStorage(input: {
    scope: { accountId: string; connectedStorageId: string };
    storage?: FakeStorageExecutor;
    mediaTitle?: MediaTitle;
    workflowRunId?: string;
  }): Promise<FakeStorageExecutor> {
    const storage = input.storage ?? new FakeStorageExecutor();
    attachAcquisitionNamingDatabase(storage, pool);
    return await prepareAcquisitionNaming({
      storage,
      scope: input.scope,
      title: input.mediaTitle ?? title(),
      categoryParentId: "tv_root",
      seasons: [1],
      workflowRunId: input.workflowRunId ?? "run_naming_pg",
    }) as FakeStorageExecutor;
  }

  dbTest("initializes both naming tables through public ensureSchema", async () => {
    await new PostgresAcquisitionNamingDatabase(pool).ensureSchema();
    const result = await pool.query<{ table_name: string; column_name: string }>([
      "SELECT table_name,column_name",
      "FROM information_schema.columns",
      "WHERE table_schema=current_schema()",
      "AND table_name IN ('library_acquisition_naming_directories','library_acquisition_naming_files')",
      "ORDER BY table_name,ordinal_position",
    ].join(" "));
    const columns = (table: string) => result.rows
      .filter((row) => row.table_name === table)
      .map((row) => row.column_name);
    expect(columns("library_acquisition_naming_directories")).toEqual([
      "account_id", "connected_storage_id", "media_type", "tmdb_id", "directory_key",
      "root_directory_id", "relative_path", "directory_id", "status", "updated_at",
    ]);
    expect(columns("library_acquisition_naming_files")).toEqual([
      "account_id", "connected_storage_id", "media_type", "tmdb_id", "workflow_run_id",
      "file_id", "attempt_id", "kind", "original_directory_id", "original_name",
      "target_directory_id", "target_name", "episode_codes", "status", "reason", "updated_at",
    ]);
  });

  dbTest("reads exact PG configuration scope and reuses a persisted directory ID after template changes", async () => {
    const scope = await createScope();
    const otherScope = await createScope();
    await scanStore.saveConfiguration(configuration({
      scope,
      configId: "a",
      templates: {
        tvDirectory: "节目/{title}",
        seasonDirectory: "季度 {season:02}",
        episodeFile: "{title} - {episodeCode}{ext}",
      },
    }));
    await scanStore.saveConfiguration(configuration({
      scope: otherScope,
      configId: "b",
      templates: {
        tvDirectory: "别账号/{title}",
        episodeFile: "{title}-{episodeCode}{ext}",
      },
    }));

    const storage = new FakeStorageExecutor();
    const first = await preparedStorage({ scope, storage, workflowRunId: "run_first" });
    const showId = await first.createDirectory({
      name: "规范标题 (2026) {tmdb-501}",
      parentId: "tv_root",
    });
    expect((await storage.listChildDirectories("tv_root")).map((entry) => entry.name))
      .toEqual(["节目"]);

    await scanStore.saveConfiguration(configuration({
      scope,
      configId: "a",
      templates: {
        tvDirectory: "完全不同的模板/{year}",
        seasonDirectory: "Changed {season}",
        episodeFile: "{title}.{episodeCode}{ext}",
      },
    }));
    const second = await preparedStorage({ scope, storage, workflowRunId: "run_second" });
    expect(await second.createDirectory({
      name: "规范标题 (2026) {tmdb-501}",
      parentId: "tv_root",
    })).toBe(showId);

    const stored = await new PostgresAcquisitionNamingDatabase(pool).getDirectoryIntent({
      scope,
      mediaType: "tv",
      tmdbId: 501,
      directoryKey: "title",
    });
    expect(stored).toMatchObject({
      directoryId: showId,
      rootDirectoryId: "tv_root",
      relativePath: "节目/规范标题",
      status: "verified",
    });
  });

  dbTest("rejects conflicting matching configurations before the acquisition writes a directory", async () => {
    const scope = await createScope();
    await scanStore.saveConfiguration(configuration({
      scope,
      configId: "a",
      templates: {
        episodeFile: "{title} - A - {episodeCode}{ext}",
      },
    }));
    await scanStore.saveConfiguration(configuration({
      scope,
      configId: "b",
      templates: {
        episodeFile: "{title} - B - {episodeCode}{ext}",
      },
    }));
    const storage = new FakeStorageExecutor();
    attachAcquisitionNamingDatabase(storage, pool);

    await expect(prepareAcquisitionNaming({
      storage,
      scope,
      title: title(502),
      categoryParentId: "tv_root",
      seasons: [1],
      workflowRunId: "run_conflict",
    })).rejects.toMatchObject({
      code: "ACQUISITION_NAMING_TEMPLATE_CONFLICT",
    });
    expect(await storage.listChildDirectories("tv_root")).toEqual([]);
  });

  dbTest("recovers a planned physical-file rename after restart and marks the verified provider ID", async () => {
    const scope = await createScope();
    await scanStore.saveConfiguration(configuration({ scope, configId: "default" }));
    const storage = new FakeStorageExecutor();
    const first = await preparedStorage({
      scope,
      storage,
      mediaTitle: title(503),
      workflowRunId: "run_before_crash",
    });
    const showId = await first.createDirectory({
      name: "规范标题 (2026) {tmdb-503}",
      parentId: "tv_root",
    });
    const seasonId = await first.createDirectory({
      name: "Season 01",
      parentId: showId,
    });
    storage.seedDirectoryFiles(seasonId, [{
      id: "physical-503",
      providerFileId: "physical-503",
      storageDirectoryId: seasonId,
      name: "Source.S01E05.mkv",
      sizeBytes: 100,
      episodeCode: "S01E05",
    }]);
    const database = new PostgresAcquisitionNamingDatabase(pool);
    await database.beginFileIntent({
      identity: {
        scope,
        mediaType: "tv",
        tmdbId: 503,
        workflowRunId: "run_before_crash",
        fileId: "physical-503",
      },
      attemptId: "attempt-before-crash",
      kind: "video",
      originalDirectoryId: "staging-before-crash",
      originalName: "Source.S01E05.mkv",
      targetDirectoryId: seasonId,
      targetName: "规范标题 - S01E05.mkv",
      episodeCodes: ["S01E05"],
    });

    await preparedStorage({
      scope,
      storage,
      mediaTitle: title(503),
      workflowRunId: "run_after_restart",
    });

    expect((await storage.listTree({ directoryId: seasonId })).map((file) => [
      file.providerFileId,
      file.path,
    ])).toEqual([["physical-503", "规范标题 - S01E05.mkv"]]);
    expect(await database.getFileIntent({
      scope,
      mediaType: "tv",
      tmdbId: 503,
      workflowRunId: "run_before_crash",
      fileId: "physical-503",
    })).toMatchObject({
      status: "verified",
      targetName: "规范标题 - S01E05.mkv",
    });
  });

  dbTest("isolates identical TMDB numbers by media type", async () => {
    const scope = await createScope();
    await scanStore.saveConfiguration(configuration({ scope, configId: "default" }));
    const database = new PostgresAcquisitionNamingDatabase(pool);
    for (const mediaType of ["tv", "movie"] as const) {
      await database.beginDirectoryIntent({
        identity: {
          scope,
          mediaType,
          tmdbId: 504,
          directoryKey: "title",
        },
        rootDirectoryId: `${mediaType}_root`,
        relativePath: `${mediaType}/same-number`,
      });
    }

    const result = await pool.query<{ media_type: string }>(
      `SELECT media_type FROM library_acquisition_naming_directories
        WHERE account_id=$1 AND connected_storage_id=$2 AND tmdb_id=504 ORDER BY media_type`,
      [scope.accountId, scope.connectedStorageId],
    );
    expect(result.rows.map((row) => row.media_type)).toEqual(["movie", "tv"]);
  });
});
