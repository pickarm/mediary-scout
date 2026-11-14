import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeWorkflowPostgresSchema } from "@media-track/workflow";
import { createGuangYaTokenPersister, type ConnectedStorageCasQuery } from "./library-runtime";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const integration = describe.skipIf(!adminConnectionString);
let adminPool: pg.Pool;
let pool: pg.Pool;
let databaseName = "";
let databaseCreated = false;

async function createStorage(payload: Record<string, unknown>): Promise<{ accountId: string; storageId: string }> {
  const suffix = randomUUID().replaceAll("-", "");
  const accountId = `f08a_refresh_account_${suffix}`;
  const storageId = `f08a_refresh_storage_${suffix}`;
  await pool.query(
    "INSERT INTO accounts (id,username,password_hash,is_owner,created_at) VALUES ($1,$2,'',false,now()::text)",
    [accountId, `user_${suffix}`],
  );
  await pool.query(
    "INSERT INTO connected_storages (id,account_id,provider,provider_uid,label,payload,root_cid,movies_cid,tv_cid,anime_cid,created_at) " +
      "VALUES ($1,$2,'guangya',$3,'drive label',$4::jsonb,'root-cid','movies-cid','tv-cid','anime-cid',now()::text)",
    [storageId, accountId, `uid-${suffix}`, JSON.stringify(payload)],
  );
  return { accountId, storageId };
}

integration("F08a GuangYa refresh persistence CAS", () => {
  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `library_refresh_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const databaseUrl = new URL(adminConnectionString);
    databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 4 });
    await initializeWorkflowPostgresSchema(pool);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      try {
        if (databaseCreated) await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      } finally { await adminPool.end(); }
    }
  }, 30_000);

  it("advances repeated refreshes and preserves row metadata, then rejects a stale callback racing with rebind", async () => {
    const originalCredentials = { accessToken: "access-0", refreshToken: "refresh-0", deviceId: "device-0" };
    const connected = await createStorage({ ...originalCredentials, customMetadata: { keep: true } });
    const storageRow = (await pool.query(
      "SELECT provider_uid FROM connected_storages WHERE id=$1", [connected.storageId],
    )).rows[0] as { provider_uid: string };
    const persist = createGuangYaTokenPersister((sql, values) => pool.query(sql, [...values]), {
      accountId: connected.accountId,
      connectedStorageId: connected.storageId,
      providerUid: storageRow.provider_uid,
      credentials: originalCredentials,
    });

    await persist({ accessToken: "access-1", refreshToken: "refresh-1", deviceId: "device-0" });
    await persist({ accessToken: "access-2", refreshToken: "refresh-2", deviceId: "device-0" });
    let row = (await pool.query(
      "SELECT payload,root_cid,movies_cid,tv_cid,anime_cid FROM connected_storages WHERE id=$1", [connected.storageId],
    )).rows[0] as { payload: Record<string, unknown>; root_cid: string; movies_cid: string; tv_cid: string; anime_cid: string };
    expect(row.payload).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2", deviceId: "device-0", customMetadata: { keep: true } });
    expect([row.root_cid, row.movies_cid, row.tv_cid, row.anime_cid]).toEqual(["root-cid", "movies-cid", "tv-cid", "anime-cid"]);

    const raced = await createStorage({ accessToken: "old-access", refreshToken: "old-refresh", deviceId: "device-old", customMetadata: { original: true } });
    const racedUid = (await pool.query("SELECT provider_uid FROM connected_storages WHERE id=$1", [raced.storageId])).rows[0] as { provider_uid: string };
    const rebind = await pool.connect();
    try {
      await rebind.query("BEGIN");
      await rebind.query(
        "UPDATE connected_storages SET payload=payload || jsonb_build_object('accessToken','rebound-access','refreshToken','rebound-refresh','deviceId','device-new') WHERE id=$1 AND account_id=$2",
        [raced.storageId, raced.accountId],
      );

      let casStarted!: () => void;
      const casStartedPromise = new Promise<void>((resolve) => { casStarted = resolve; });
      const observedQuery: ConnectedStorageCasQuery = (sql, values) => {
        casStarted();
        return pool.query(sql, [...values]);
      };
      const staleCallback = createGuangYaTokenPersister(observedQuery, {
        accountId: raced.accountId,
        connectedStorageId: raced.storageId,
        providerUid: racedUid.provider_uid,
        credentials: { accessToken: "old-access", refreshToken: "old-refresh", deviceId: "device-old" },
      });
      const pending = staleCallback({ accessToken: "stale-access", refreshToken: "stale-refresh", deviceId: "device-old" });
      await casStartedPromise;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await rebind.query("COMMIT");
      await pending;
    } finally {
      await rebind.query("ROLLBACK").catch(() => undefined);
      rebind.release();
    }
    row = (await pool.query(
      "SELECT payload,root_cid,movies_cid,tv_cid,anime_cid FROM connected_storages WHERE id=$1", [raced.storageId],
    )).rows[0] as typeof row;
    expect(row.payload).toMatchObject({ accessToken: "rebound-access", refreshToken: "rebound-refresh", deviceId: "device-new", customMetadata: { original: true } });
  }, 30_000);
});
