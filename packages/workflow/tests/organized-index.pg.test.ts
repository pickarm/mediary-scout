import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { getStorageBrand } from "@media-track/workflow";
import {
  computeNamingTemplatesFingerprint,
  DEFAULT_NAMING_TEMPLATES,
  LibraryScanner,
  PostgresAutoOrganizationStore,
  PostgresIdentificationStore,
  PostgresLibraryStore,
  PostgresOrganizedIndexStore,
  PostgresScanStore,
  type DirectoryReader,
  type OrganizationIdentity,
} from "@media-track/workflow/library";

const adminUrl = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;

describe.skipIf(!adminUrl)("library organized index and drift lifecycle (PostgreSQL)", () => {
  it("skips unchanged files, detects renames/template drifts, honors ignore snapshots, cleans deletions, and runs concurrent scan commitPage", async () => {
    const dbName = `org_index_${randomUUID().replaceAll("-", "")}`;
    const adminPool = new Pool({ connectionString: adminUrl });
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE DATABASE ${dbName}`);
      const url = new URL(adminUrl!);
      url.pathname = `/${dbName}`;
      pool = new Pool({ connectionString: url.toString() });
      pool.on("error", () => {});

      const scanStore = new PostgresScanStore(pool);
      const libraryStore = new PostgresLibraryStore(pool);
      const idStore = new PostgresIdentificationStore(pool);
      const indexStore = new PostgresOrganizedIndexStore(pool);
      const autoStore = new PostgresAutoOrganizationStore(pool);
      await Promise.all([
        scanStore.ensureSchema(),
        libraryStore.ensureSchema(),
        idStore.ensureSchema(),
        indexStore.ensureSchema(),
        autoStore.ensureSchema(),
      ]);

      const provider = getStorageBrand("quark").provider;
      await pool.query(
        "INSERT INTO connected_storages(id,account_id,provider,provider_uid,payload,created_at) VALUES('drive','acct',$1,'uid','{}'::jsonb,'now')",
        [provider],
      );
      const scope = { accountId: "acct", connectedStorageId: "drive" };
      const templates = { ...DEFAULT_NAMING_TEMPLATES };
      const fingerprint = computeNamingTemplatesFingerprint(templates);

      const configuration = {
        configId: "cfg-main",
        scope,
        sourceRoots: [{ directoryId: "movies-root", name: "电影" }],
        movieTargetDirectoryId: "movies-root",
        tvTargetDirectoryId: null,
        mediaKind: "movie" as const,
        dailyScheduleEnabled: true,
        dailyScheduleTime: "03:00",
        dailyScheduleTimezone: "Asia/Shanghai" as const,
        autoOrganize: true,
        organizeConcurrency: 3,
        autoAcquire: false as const,
        templates,
      };
      await scanStore.saveConfiguration(configuration);

      // 导入影片基线并写入整理索引
      const identity: OrganizationIdentity = {
        mediaTitleId: "tmdb_movie_438631",
        trackedSeasonId: "tmdb_movie_438631_movie",
        mediaType: "movie",
        title: "沙丘",
        originalTitle: "Dune",
        year: 2021,
        tmdbId: 438631,
        season: 1,
        edition: "4K",
      };
      await libraryStore.importExistingMedia({
        accountId: "acct",
        connectedStorageId: "drive",
        title: {
          id: identity.mediaTitleId,
          tmdbId: identity.tmdbId,
          type: "movie",
          title: identity.title,
          originalTitle: identity.originalTitle,
          year: identity.year,
          aliases: [],
        },
        season: {
          id: identity.trackedSeasonId,
          mediaTitleId: identity.mediaTitleId,
          seasonNumber: 1,
          status: "active",
          qualityPreference: "",
          storageDirectoryId: "dir-dune",
          totalEpisodes: 1,
          latestAiredEpisode: 1,
          latestAiredSource: "unknown",
        },
        episodes: [],
        files: [{ fileId: "file-dune", parentDirectoryId: "dir-dune", episodeCode: "S01E01" }],
        directories: [
          { directoryId: "movies-root", parentDirectoryId: null },
          { directoryId: "dir-dune", parentDirectoryId: "movies-root" },
        ],
        now: "2026-11-28T00:00:00.000Z",
      });

      const organizedName = "沙丘 (2021) - 2160p.DV.mkv";
      const organizedRel = "沙丘 (2021) [tmdbid=438631]/沙丘 (2021) - 2160p.DV.mkv";
      await indexStore.upsertOrganized({
        scope,
        fileId: "file-dune",
        parentDirectoryId: "dir-dune",
        targetRootId: "movies-root",
        organizedName,
        organizedRelativePath: organizedRel,
        templateFingerprint: fingerprint,
        source: "organization",
        identity,
        now: "2026-11-28T00:00:01.000Z",
      });

      // 工具函数：模拟不同阶段网盘目录树执行并发扫库
      let currentFileName: string | null = organizedName;
      let extraUnchangedDir = true;
      const runScan = async (taskId: string, config = configuration) => {
        const reader: DirectoryReader = {
          async listPage({ directoryId, directoryPath }) {
            if (directoryId === "movies-root") {
              const items = [
                {
                  fileId: "dir-dune",
                  parentDirectoryId: "movies-root",
                  name: "沙丘 (2021) [tmdbid=438631]",
                  isDirectory: true,
                  sizeBytes: null,
                  path: `${directoryPath}/沙丘 (2021) [tmdbid=438631]`,
                  modifiedAt: null,
                },
              ];
              if (extraUnchangedDir) {
                items.push({
                  fileId: "dir-empty-1",
                  parentDirectoryId: "movies-root",
                  name: "其他",
                  isDirectory: true,
                  sizeBytes: null,
                  path: `${directoryPath}/其他`,
                  modifiedAt: null,
                });
                items.push({
                  fileId: "dir-empty-2",
                  parentDirectoryId: "movies-root",
                  name: "待分类",
                  isDirectory: true,
                  sizeBytes: null,
                  path: `${directoryPath}/待分类`,
                  modifiedAt: null,
                });
              }
              return { items, nextPage: null };
            }
            if (directoryId === "dir-dune" && currentFileName) {
              return {
                items: [
                  {
                    fileId: "file-dune",
                    parentDirectoryId: "dir-dune",
                    name: currentFileName,
                    isDirectory: false,
                    sizeBytes: 1024,
                    path: `${directoryPath}/${currentFileName}`,
                    modifiedAt: null,
                  },
                ],
                nextPage: null,
              };
            }
            return { items: [], nextPage: null };
          },
        };
        const scanner = new LibraryScanner({ store: scanStore, reader, concurrency: 3 });
        await scanStore.createTask({ taskId, scope, configuration: config, roots: config.sourceRoots, now: "2026-11-28T00:01:00.000Z" });
        await scanner.resume(scope, taskId);
        await scanner.waitForIdle(scope, taskId);
        return indexStore.reconcileScanTask({ scope, taskId, now: "2026-11-28T00:01:05.000Z" });
      };

      // 1. 首次扫库：文件未变动 -> cleanSkipped = 1，识别直接跳过，自动整理也不再入队
      const sum1 = await runScan("scan-1");
      expect(sum1.cleanSkipped).toBe(1);
      expect(sum1.drifted).toBe(0);
      expect(await idStore.listResultFileIds(scope, "scan-1", null, 20)).not.toContain("file-dune");
      const skippedIdRow = await pool.query<{ status: string; import_status: string; reason: string }>(
        "SELECT status, import_status, reason FROM library_scan_identifications WHERE account_id='acct' AND connected_storage_id='drive' AND task_id='scan-1' AND file_id='file-dune'",
      );
      expect(skippedIdRow.rows[0]).toEqual({
        status: "confirmed",
        import_status: "imported",
        reason: "命中整理索引，文件未变动自动跳过",
      });
      const autoCandidate1 = { scope, taskId: "scan-1", configId: "cfg-main", checkpoint: null };
      await pool.query(
        "INSERT INTO library_auto_organization_tasks(account_id,connected_storage_id,task_id,config_id,status,created_at,updated_at) VALUES('acct','drive','scan-1','cfg-main','idle','now','now')",
      );
      expect(await autoStore.beginTask({ candidate: autoCandidate1, leaseId: "l1", now: "2026-11-28T00:01:06.000Z", leaseExpiresAt: "2026-11-28T00:05:06.000Z", requireEligible: true })).not.toBeNull();
      expect(await autoStore.claimBatch({ scope, taskId: "scan-1", configId: "cfg-main", batchId: "b1", now: "2026-11-28T00:01:07.000Z", limit: 20, leaseId: "l1" })).toBeNull();

      // 2. 网盘手工改名后扫库 -> 检出 drifted，且自动整理依然保护性不覆写
      currentFileName = "沙丘_朋友分享版.mkv";
      extraUnchangedDir = false;
      const sum2 = await runScan("scan-2");
      expect(sum2.drifted).toBe(1);
      const drifts2 = await indexStore.listDrifts(scope, { status: "drifted", page: 1, pageSize: 10 });
      expect(drifts2.items[0]?.driftReason).toBe("文件名已被修改");
      expect(drifts2.items[0]?.observedName).toBe("沙丘_朋友分享版.mkv");
      await pool.query(
        "INSERT INTO library_auto_organization_tasks(account_id,connected_storage_id,task_id,config_id,status,created_at,updated_at) VALUES('acct','drive','scan-2','cfg-main','idle','now','now')",
      );
      const autoCandidate2 = { scope, taskId: "scan-2", configId: "cfg-main", checkpoint: null };
      expect(await autoStore.beginTask({ candidate: autoCandidate2, leaseId: "l2", now: "2026-11-28T00:02:00.000Z", leaseExpiresAt: "2026-11-28T00:06:00.000Z", requireEligible: true })).not.toBeNull();
      expect(await autoStore.claimBatch({ scope, taskId: "scan-2", configId: "cfg-main", batchId: "b2", now: "2026-11-28T00:02:01.000Z", limit: 20, leaseId: "l2" })).toBeNull();

      // 3. 忽略当前改动后再次扫库 -> 保持 ignored，不再出现在待处理列表中
      expect(await indexStore.ignoreDrifts(scope, ["file-dune"], "2026-11-28T00:02:10.000Z")).toBe(1);
      const sum3 = await runScan("scan-3");
      expect(sum3.ignored).toBe(1);
      expect(sum3.drifted).toBe(0);
      expect((await indexStore.listDrifts(scope, { status: "drifted", page: 1, pageSize: 10 })).total).toBe(0);
      expect((await indexStore.listDrifts(scope, { status: "ignored", page: 1, pageSize: 10 })).total).toBe(1);

      // 4. 改成第三个文件名后扫库 -> 再次触发 drifted 提醒
      currentFileName = "沙丘_第三次修改.mkv";
      const sum4 = await runScan("scan-4");
      expect(sum4.drifted).toBe(1);

      // 5. 忽略后如果更换命名模板，下次扫库也会重新提示
      expect(await indexStore.ignoreDrifts(scope, ["file-dune"], "2026-11-28T00:03:00.000Z")).toBe(1);
      const updatedCfg = {
        ...configuration,
        templates: { ...templates, movieFile: "{originalTitle} ({year}){ext}" },
      };
      await scanStore.saveConfiguration(updatedCfg);
      const sum5 = await runScan("scan-5", updatedCfg);
      expect(sum5.drifted).toBe(1);
      const drifts5 = await indexStore.listDrifts(scope, { status: "drifted", page: 1, pageSize: 10 });
      expect(drifts5.items[0]?.driftReason).toBe("命名模板已更新");

      // 6. 网盘文件删除后完成扫库 -> 索引自动清理
      currentFileName = null;
      const sum6 = await runScan("scan-6", updatedCfg);
      expect(sum6.removed).toBe(1);
      expect(sum6.indexedTotal).toBe(0);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
      await adminPool.end();
    }
  }, 45_000);
});
