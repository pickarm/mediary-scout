import pg from "pg";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeWorkflowPostgresSchema } from "@media-track/workflow";
import { DEFAULT_NAMING_TEMPLATES, PostgresScanStore } from "@media-track/workflow/library";

const mocks = vi.hoisted(() => ({ pool: null as pg.Pool | null, accountId: "", repository: null as { listConnectedStorages(accountId: string): Promise<unknown[]> } | null }));
vi.mock("./library-database", () => ({
  getLibraryDatabasePool: () => {
    if (!mocks.pool) throw new Error("isolated test pool is not initialized");
    return mocks.pool;
  },
}));
vi.mock("./workflow-runtime", () => ({
  requireAuthenticatedAccountId: async () => mocks.accountId,
  getWorkflowRepository: () => {
    if (!mocks.repository) throw new Error("test workflow repository is not initialized");
    return mocks.repository;
  },
}));
vi.mock("./library-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./library-api")>();
  return { ...actual, libraryAccount: async () => mocks.accountId };
});

import { getLibraryReadServices, getLibraryServices } from "./library-runtime";
import { getLibraryReadIdentificationService, getLibraryReadOrganizationService } from "./library-read-runtime";
import { GET as getConfigurations, POST as saveConfiguration } from "../app/api/library/configurations/route";
import { GET as getIdentifications } from "../app/api/library/scans/[taskId]/identifications/route";
import { GET as getDirectories } from "../app/api/library/directories/route";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const integration = describe.skipIf(!adminConnectionString);

integration("F08g read-only library runtime", () => {
  let adminPool: pg.Pool;
  let databaseName = "";
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `f08g_read_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(adminConnectionString);
    databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 4 });
    mocks.pool = pool;
    await initializeWorkflowPostgresSchema(pool);
  }, 30_000);

  afterAll(async () => {
    mocks.pool = null;
    mocks.accountId = "";
    mocks.repository = null;
    if (pool) await pool.end();
    if (adminPool) {
      try { if (databaseName) await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); }
      finally { await adminPool.end(); }
    }
  }, 30_000);

  it("reads owned history for frozen storage with empty credentials and rejects alien or removed storage", async () => {
    const accountId = `account_${randomUUID()}`;
    const otherAccountId = `account_${randomUUID()}`;
    const storageId = `storage_${randomUUID()}`;
    await pool.query("INSERT INTO accounts(id,username,password_hash,is_owner,created_at) VALUES($1,$2,'',false,now()::text),($3,$4,'',false,now()::text)", [accountId, accountId, otherAccountId, otherAccountId]);
    await pool.query("INSERT INTO connected_storages(id,account_id,provider,provider_uid,payload,status,created_at) VALUES($1,$2,'guangya',$3,'{}'::jsonb,'frozen',now()::text)", [storageId, accountId, `uid_${randomUUID()}`]);
    const scope = { accountId, connectedStorageId: storageId };
    mocks.accountId = accountId;
    mocks.repository = { listConnectedStorages: async () => [{ id: storageId, accountId, provider: "guangya", providerUid: "uid", payload: {}, status: "frozen" }] };
    await expect(getLibraryServices(scope)).rejects.toMatchObject({ code: "storage_frozen" });
    const owned = await getLibraryReadServices(scope);
    const configuration = {
      configId: `config_${randomUUID()}`, scope, sourceRoots: [{ directoryId: "root", name: "Library" }],
      movieTargetDirectoryId: null, tvTargetDirectoryId: null, mediaKind: "mixed" as const,
      dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai" as const,
      autoOrganize: false, autoAcquire: false as const, templates: DEFAULT_NAMING_TEMPLATES,
    };
    await owned.scanStore.saveConfiguration(configuration);
    const taskId = `task_${randomUUID()}`;
    await owned.scanStore.createTask({ taskId, scope, configuration, roots: configuration.sourceRoots, now: "2026-11-15T00:00:00.000Z" });
    expect(await owned.scanStore.listConfigurations(scope)).toMatchObject([{ configId: configuration.configId }]);
    const configResponse = await getConfigurations(new NextRequest(`http://localhost/api/library/configurations?storageId=${storageId}`));
    expect(configResponse.status).toBe(200);
    expect((await configResponse.json()).items).toMatchObject([{ configId: configuration.configId }]);
    const identifications = await getLibraryReadIdentificationService(scope);
    expect(await identifications.list(taskId, { limit: 20 })).toMatchObject({ items: [], hasMore: false });
    const identificationResponse = await getIdentifications(new NextRequest(`http://localhost/api/library/scans/${taskId}/identifications?storageId=${storageId}`), { params: Promise.resolve({ taskId }) });
    expect(identificationResponse.status).toBe(200);
    const directoryResponse = await getDirectories(new NextRequest(`http://localhost/api/library/directories?storageId=${storageId}`));
    expect(directoryResponse.status).toBe(409);
    const writeResponse = await saveConfiguration(new NextRequest("http://localhost/api/library/configurations", {
      method: "POST", headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ storageId, sourceRoots: [{ directoryId: "root" }], mediaKind: "mixed" }),
    }));
    expect(writeResponse.status).toBe(409);
    const organization = await getLibraryReadOrganizationService(accountId, storageId);
    expect(await organization.store.listPlans(scope, "missing-task", { limit: 10 })).toEqual([]);
    await expect(getLibraryReadServices({ accountId: otherAccountId, connectedStorageId: storageId })).rejects.toMatchObject({ code: "storage_not_found" });
    await pool.query("DELETE FROM connected_storages WHERE id=$1", [storageId]);
    await expect(getLibraryReadServices(scope)).rejects.toMatchObject({ code: "storage_not_found" });
  }, 30_000);
});
