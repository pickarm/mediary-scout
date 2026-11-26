import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGuangYaAuthCoordinator, getGuangYaAuthFailureSnapshot, GuangYaClient, initializeWorkflowPostgresSchema } from "@media-track/workflow";
import { createGuangYaAuthHooks, freezeGuangYaStorageIfUnchanged } from "./guangya-auth-runtime";
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
    pool.on("error", () => {});
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
    const connected = await createStorage({ ...originalCredentials, meta: { connectedAt: "bind-1" }, customMetadata: { keep: true } });
    const storageRow = (await pool.query(
      "SELECT provider_uid FROM connected_storages WHERE id=$1", [connected.storageId],
    )).rows[0] as { provider_uid: string };
    const persist = createGuangYaTokenPersister((sql, values) => pool.query(sql, [...values]), {
      accountId: connected.accountId,
      connectedStorageId: connected.storageId,
      providerUid: storageRow.provider_uid,
      credentials: originalCredentials,
      connectionMarker: "bind-1",
    });

    await persist({ accessToken: "access-1", refreshToken: "refresh-1", deviceId: "device-0" });
    await persist({ accessToken: "access-2", refreshToken: "refresh-2", deviceId: "device-0" });
    let row = (await pool.query(
      "SELECT payload,root_cid,movies_cid,tv_cid,anime_cid FROM connected_storages WHERE id=$1", [connected.storageId],
    )).rows[0] as { payload: Record<string, unknown>; root_cid: string; movies_cid: string; tv_cid: string; anime_cid: string };
    expect(row.payload).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2", deviceId: "device-0", meta: { connectedAt: "bind-1" }, customMetadata: { keep: true } });
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

  it("rejects a same-UID rebind marker change while accepting ordinary token refreshes", async () => {
    const credentials = { accessToken: "access-marker", refreshToken: "refresh-marker", deviceId: "device-marker" };
    const connected = await createStorage({ ...credentials, meta: { connectedAt: "bind-original" } });
    const uid = (await pool.query("SELECT provider_uid FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { provider_uid: string };
    const hooks = createGuangYaAuthHooks({
      accountId: connected.accountId,
      connectedStorageId: connected.storageId,
      providerUid: uid.provider_uid,
      credentials,
      connectionMarker: "bind-original",
    }, (sql, values) => pool.query(sql, [...values]));

    await expect(hooks.loadCurrentCredentials()).resolves.toMatchObject({ tokens: credentials, snapshot: { credentials, connectionMarker: "bind-original" } });
    await expect(hooks.onTokensRefreshed({ accessToken: "access-next", refreshToken: "refresh-next", deviceId: "device-marker" }))
      .resolves.toBe(true);
    await expect(hooks.loadCurrentCredentials()).resolves.toMatchObject({
      tokens: { accessToken: "access-next", refreshToken: "refresh-next", deviceId: "device-marker" },
      snapshot: { credentials: { accessToken: "access-next", refreshToken: "refresh-next", deviceId: "device-marker" }, connectionMarker: "bind-original" },
    });

    await pool.query(
      "UPDATE connected_storages SET payload=jsonb_set(payload,'{meta,connectedAt}','\"bind-rebound\"'::jsonb) WHERE id=$1",
      [connected.storageId],
    );
    await expect(hooks.loadCurrentCredentials()).resolves.toBeNull();
  }, 30_000);

  it("does not persist a delayed refresh over a same-UID rebind with an unchanged token tuple", async () => {
    const credentials = { accessToken: "marker-access", refreshToken: "marker-refresh", deviceId: "marker-device" };
    const connected = await createStorage({ ...credentials, meta: { connectedAt: "marker-before" }, custom: "old" });
    const uid = (await pool.query("SELECT provider_uid FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { provider_uid: string };
    const hooks = createGuangYaAuthHooks({
      accountId: connected.accountId, connectedStorageId: connected.storageId, providerUid: uid.provider_uid,
      credentials, connectionMarker: "marker-before",
    }, (sql, values) => pool.query(sql, [...values]));
    let allowRefresh!: () => void;
    let refreshPaused!: () => void;
    const pause = new Promise<void>((resolve) => { allowRefresh = resolve; });
    const paused = new Promise<void>((resolve) => { refreshPaused = resolve; });
    const client = new GuangYaClient({
      ...hooks.credentials,
      authCoordinator: createGuangYaAuthCoordinator(), authAccountKey: hooks.accountKey,
      loadCurrentCredentials: hooks.loadCurrentCredentials, onTokensRefreshed: hooks.onTokensRefreshed,
      fetchImpl: async (url) => {
        if (url.endsWith("/userres/v1/file/get_file_list")) return new Response(JSON.stringify({ msg: "expired" }), { status: 401 });
        if (url.endsWith("/v1/auth/token")) {
          refreshPaused();
          await pause;
          return new Response(JSON.stringify({ access_token: "marker-new-access", refresh_token: "marker-new-refresh" }), { status: 200 });
        }
        throw new Error("unexpected request");
      },
    });
    const pending = client.listFilesPage("root", 0);
    await paused;
    await pool.query(
      "UPDATE connected_storages SET payload=jsonb_set(payload,'{meta,connectedAt}','\"marker-after\"'::jsonb) WHERE id=$1",
      [connected.storageId],
    );
    allowRefresh();
    await expect(pending).rejects.toMatchObject({ name: "GuangYaConnectionChangedError" });
    const row = (await pool.query("SELECT payload FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { payload: Record<string, unknown> };
    expect(row.payload).toMatchObject({ ...credentials, meta: { connectedAt: "marker-after" }, custom: "old" });
  }, 30_000);

  it("refreshes a legacy row without Did and persists the stable runtime Did", async () => {
    const legacy = { accessToken: "legacy-access", refreshToken: "legacy-refresh" };
    const connected = await createStorage({ ...legacy, meta: { connectedAt: "legacy-bind" } });
    const uid = (await pool.query("SELECT provider_uid FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { provider_uid: string };
    const hooks = createGuangYaAuthHooks({
      accountId: connected.accountId, connectedStorageId: connected.storageId, providerUid: uid.provider_uid,
      credentials: { ...legacy, deviceId: "" }, connectionMarker: "legacy-bind",
    }, (sql, values) => pool.query(sql, [...values]));
    const loaded = await hooks.loadCurrentCredentials();
    expect(loaded?.tokens.deviceId).toBe(hooks.credentials.deviceId);
    expect(loaded?.snapshot.credentials.deviceId).toBeNull();
    const client = new GuangYaClient({
      ...hooks.credentials,
      authCoordinator: createGuangYaAuthCoordinator(), authAccountKey: hooks.accountKey,
      loadCurrentCredentials: hooks.loadCurrentCredentials, onTokensRefreshed: hooks.onTokensRefreshed,
      fetchImpl: async (url, init) => {
        if (url.endsWith("/userres/v1/file/get_file_list")) {
          const headers = (init as RequestInit).headers as Record<string, string>;
          if (headers.Authorization === "Bearer legacy-access") return new Response("{}", { status: 401 });
          expect(headers.Did).toBe(hooks.credentials.deviceId);
          return new Response(JSON.stringify({ msg: "success", data: { list: [] } }), { status: 200 });
        }
        if (url.endsWith("/v1/auth/token")) return new Response(JSON.stringify({ access_token: "legacy-next", refresh_token: "legacy-next-refresh" }), { status: 200 });
        throw new Error("unexpected request");
      },
    });
    await expect(client.listFilesPage("root", 0)).resolves.toEqual({ items: [], hasMore: false });
    const row = (await pool.query("SELECT payload FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { payload: Record<string, unknown> };
    expect(row.payload).toMatchObject({ accessToken: "legacy-next", refreshToken: "legacy-next-refresh", deviceId: hooks.credentials.deviceId, meta: { connectedAt: "legacy-bind" } });
  }, 30_000);

  it("uses one stable runtime Did for missing, empty camel, empty snake, and mixed aliases", async () => {
    const variants: Array<{ payload: Record<string, unknown>; expectedRaw: string | null }> = [
      { payload: { accessToken: "alias-camel", refreshToken: "refresh-camel" }, expectedRaw: null },
      { payload: { accessToken: "alias-empty-camel", refreshToken: "refresh-empty-camel", deviceId: "" }, expectedRaw: "" },
      { payload: { access_token: "alias-empty-snake", refresh_token: "refresh-empty-snake", device_id: "" }, expectedRaw: "" },
      { payload: { accessToken: "alias-mixed", refresh_token: "refresh-mixed", deviceId: "", device_id: "ignored-snake" }, expectedRaw: "" },
    ];
    for (const [index, variant] of variants.entries()) {
      const connected = await createStorage({ ...variant.payload, meta: { connectedAt: `alias-bind-${index}` } });
      const uid = (await pool.query("SELECT provider_uid FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { provider_uid: string };
      const initialAccess = String(variant.payload.accessToken ?? variant.payload.access_token);
      const initialRefresh = String(variant.payload.refreshToken ?? variant.payload.refresh_token);
      const hooks = createGuangYaAuthHooks({
        accountId: connected.accountId, connectedStorageId: connected.storageId, providerUid: uid.provider_uid,
        credentials: { accessToken: initialAccess, refreshToken: initialRefresh, deviceId: "" },
        connectionMarker: `alias-bind-${index}`,
      }, (sql, values) => pool.query(sql, [...values]));
      const loaded = await hooks.loadCurrentCredentials();
      expect(loaded?.tokens.deviceId).toBe(hooks.credentials.deviceId);
      expect(hooks.credentials.deviceId).not.toBe("");
      expect(loaded?.snapshot.credentials.deviceId).toBe(variant.expectedRaw);
      let exchangeCount = 0;
      const client = new GuangYaClient({
        ...hooks.credentials, authCoordinator: createGuangYaAuthCoordinator(), authAccountKey: hooks.accountKey,
        loadCurrentCredentials: hooks.loadCurrentCredentials, onTokensRefreshed: hooks.onTokensRefreshed,
        fetchImpl: async (url, init) => {
          if (url.endsWith("/userres/v1/file/get_file_list")) {
            const headers = (init as RequestInit).headers as Record<string, string>;
            const authorization = headers.Authorization;
            if (!authorization) throw new Error("missing Authorization header");
            if (authorization === `Bearer ${initialAccess}`) return new Response("{}", { status: 401 });
            expect(headers.Did).toBe(hooks.credentials.deviceId);
            return new Response(JSON.stringify({ msg: "success", data: { list: [] } }), { status: 200 });
          }
          if (url.endsWith("/v1/auth/token")) {
            exchangeCount += 1;
            expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ refresh_token: initialRefresh });
            return new Response(JSON.stringify({ access_token: `alias-next-${index}`, refresh_token: `refresh-next-${index}` }), { status: 200 });
          }
          throw new Error("unexpected request");
        },
      });
      await expect(client.listFilesPage("root", 0)).resolves.toEqual({ items: [], hasMore: false });
      expect(exchangeCount).toBe(1);
      const row = (await pool.query("SELECT payload FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { payload: Record<string, unknown> };
      expect(row.payload).toMatchObject({ accessToken: `alias-next-${index}`, refreshToken: `refresh-next-${index}`, deviceId: hooks.credentials.deviceId, meta: { connectedAt: `alias-bind-${index}` } });
    }
  }, 30_000);

  it("permits only an explicit frozen-row probe to refresh and reactivate the same connection", async () => {
    const credentials = { accessToken: "frozen-access", refreshToken: "frozen-refresh", deviceId: "frozen-device" };
    const connected = await createStorage({ ...credentials, meta: { connectedAt: "frozen-bind" } });
    const uid = (await pool.query("SELECT provider_uid FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { provider_uid: string };
    await pool.query("UPDATE connected_storages SET status='frozen', frozen_reason='expired', frozen_at='now' WHERE id=$1", [connected.storageId]);
    const scope = { accountId: connected.accountId, connectedStorageId: connected.storageId, providerUid: uid.provider_uid, credentials, connectionMarker: "frozen-bind" };
    const ordinaryHooks = createGuangYaAuthHooks(scope, (sql, values) => pool.query(sql, [...values]));
    await expect(ordinaryHooks.loadCurrentCredentials()).resolves.toBeNull();
    const probeHooks = createGuangYaAuthHooks({ ...scope, allowFrozenForProbe: true }, (sql, values) => pool.query(sql, [...values]));
    expect((await probeHooks.loadCurrentCredentials())?.snapshot.expectedStatus).toBe("frozen");
    const client = new GuangYaClient({
      ...probeHooks.credentials, authCoordinator: createGuangYaAuthCoordinator(), authAccountKey: probeHooks.accountKey,
      loadCurrentCredentials: probeHooks.loadCurrentCredentials, onTokensRefreshed: probeHooks.onTokensRefreshed,
      fetchImpl: async (url, init) => {
        if (url.endsWith("/v1/user/me")) {
          const headers = (init as RequestInit).headers as Record<string, string>;
          if (headers.Authorization === "Bearer frozen-access") return new Response("{}", { status: 401 });
          const persisted = (await pool.query("SELECT status FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { status: string };
          expect(persisted.status).toBe("frozen");
          return new Response(JSON.stringify({ sub: uid.provider_uid }), { status: 200 });
        }
        if (url.endsWith("/v1/auth/token")) return new Response(JSON.stringify({ access_token: "frozen-next", refresh_token: "frozen-next-refresh" }), { status: 200 });
        throw new Error("unexpected request");
      },
    });
    await expect(client.validateToken()).resolves.toBe(uid.provider_uid);
    expect(await probeHooks.reactivateIfUnchanged()).toBe(true);
    const row = (await pool.query("SELECT status,frozen_reason,frozen_at,payload FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { status: string; frozen_reason: string | null; frozen_at: string | null; payload: Record<string, unknown> };
    expect(row).toMatchObject({ status: "active", frozen_reason: null, frozen_at: null });
    expect(row.payload).toMatchObject({ accessToken: "frozen-next", refreshToken: "frozen-next-refresh", meta: { connectedAt: "frozen-bind" } });
  }, 30_000);

  it("does not reactivate a frozen connection after its binding marker changes", async () => {
    const credentials = { accessToken: "probe-access", refreshToken: "probe-refresh", deviceId: "probe-device" };
    const connected = await createStorage({ ...credentials, meta: { connectedAt: "probe-before" } });
    const uid = (await pool.query("SELECT provider_uid FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { provider_uid: string };
    await pool.query("UPDATE connected_storages SET status='frozen' WHERE id=$1", [connected.storageId]);
    const hooks = createGuangYaAuthHooks({
      accountId: connected.accountId, connectedStorageId: connected.storageId, providerUid: uid.provider_uid,
      credentials, connectionMarker: "probe-before", allowFrozenForProbe: true,
    }, (sql, values) => pool.query(sql, [...values]));
    await expect(hooks.loadCurrentCredentials()).resolves.not.toBeNull();
    await pool.query("UPDATE connected_storages SET payload=jsonb_set(payload,'{meta,connectedAt}','\"probe-after\"'::jsonb) WHERE id=$1", [connected.storageId]);
    await expect(hooks.reactivateIfUnchanged()).resolves.toBe(false);
    const row = (await pool.query("SELECT status,payload FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { status: string; payload: Record<string, unknown> };
    expect(row).toMatchObject({ status: "frozen", payload: { meta: { connectedAt: "probe-after" } } });
  }, 30_000);

  it("does not reactivate after the credential tuple changes after probe validation", async () => {
    const credentials = { accessToken: "probe-cas-access", refreshToken: "probe-cas-refresh", deviceId: "probe-cas-device" };
    const connected = await createStorage({ ...credentials, meta: { connectedAt: "probe-cas-bind" } });
    const uid = (await pool.query("SELECT provider_uid FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { provider_uid: string };
    await pool.query("UPDATE connected_storages SET status='frozen' WHERE id=$1", [connected.storageId]);
    const hooks = createGuangYaAuthHooks({ accountId: connected.accountId, connectedStorageId: connected.storageId,
      providerUid: uid.provider_uid, credentials, connectionMarker: "probe-cas-bind", allowFrozenForProbe: true },
    (sql, values) => pool.query(sql, [...values]));
    const observed = await hooks.loadCurrentCredentials();
    expect(observed).not.toBeNull();
    await expect(hooks.onTokensRefreshed({ accessToken: "probe-cas-next", refreshToken: "probe-cas-next-r", deviceId: credentials.deviceId }, observed?.snapshot)).resolves.toBe(true);
    await pool.query("UPDATE connected_storages SET payload=payload || '{\"accessToken\":\"probe-cas-newer\",\"refreshToken\":\"probe-cas-newer-r\"}'::jsonb WHERE id=$1", [connected.storageId]);
    await expect(hooks.reactivateIfUnchanged()).resolves.toBe(false);
    const row = (await pool.query("SELECT status FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { status: string };
    expect(row.status).toBe("frozen");
  }, 30_000);

  it("keeps a frozen connection frozen when token exchange succeeds but user validation fails", async () => {
    const credentials = { accessToken: "frozen-fail-access", refreshToken: "frozen-fail-refresh", deviceId: "frozen-fail-device" };
    const connected = await createStorage({ ...credentials, meta: { connectedAt: "frozen-fail-bind" } });
    const uid = (await pool.query("SELECT provider_uid FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { provider_uid: string };
    await pool.query("UPDATE connected_storages SET status='frozen',frozen_reason='expired',frozen_at='now' WHERE id=$1", [connected.storageId]);
    const hooks = createGuangYaAuthHooks({ accountId: connected.accountId, connectedStorageId: connected.storageId,
      providerUid: uid.provider_uid, credentials, connectionMarker: "frozen-fail-bind", allowFrozenForProbe: true },
    (sql, values) => pool.query(sql, [...values]));
    const client = new GuangYaClient({ ...hooks.credentials, authCoordinator: createGuangYaAuthCoordinator(), authAccountKey: hooks.accountKey,
      loadCurrentCredentials: hooks.loadCurrentCredentials, onTokensRefreshed: hooks.onTokensRefreshed,
      fetchImpl: async (url, init) => {
        if (url.endsWith("/v1/user/me")) {
          const authorization = ((init as RequestInit).headers as Record<string, string>).Authorization;
          if (authorization === `Bearer ${credentials.accessToken}`) return new Response("{}", { status: 401 });
          return new Response("network unavailable", { status: 503 });
        }
        if (url.endsWith("/v1/auth/token")) return new Response(JSON.stringify({ access_token: "frozen-fail-next", refresh_token: "frozen-fail-next-r" }), { status: 200 });
        throw new Error("unexpected request");
      },
    });
    await expect(client.validateToken()).rejects.toThrow();
    const row = (await pool.query("SELECT status,frozen_reason,payload FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { status: string; frozen_reason: string | null; payload: Record<string, unknown> };
    expect(row).toMatchObject({ status: "frozen", frozen_reason: "expired", payload: { accessToken: "frozen-fail-next", refreshToken: "frozen-fail-next-r" } });
  }, 30_000);

  it("freezes only the exact credentials and connection generation that returned the terminal 401", async () => {
    for (const mutation of ["rebind", "rotate", "unchanged"] as const) {
      const credentials = { accessToken: `late-access-${mutation}`, refreshToken: `late-refresh-${mutation}`, deviceId: `late-device-${mutation}` };
      const marker = `late-bind-${mutation}`;
      const connected = await createStorage({ ...credentials, meta: { connectedAt: marker } });
      const uid = (await pool.query("SELECT provider_uid FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { provider_uid: string };
      const hooks = createGuangYaAuthHooks({ accountId: connected.accountId, connectedStorageId: connected.storageId,
        providerUid: uid.provider_uid, credentials, connectionMarker: marker }, (sql, values) => pool.query(sql, [...values]));
      let requestCount = 0;
      let retryEntered!: () => void;
      const retryStarted = new Promise<void>((resolve) => { retryEntered = resolve; });
      let releaseRetry!: (response: Response) => void;
      const heldRetry = new Promise<Response>((resolve) => { releaseRetry = resolve; });
      const client = new GuangYaClient({ ...hooks.credentials, authCoordinator: createGuangYaAuthCoordinator(), authAccountKey: hooks.accountKey,
        loadCurrentCredentials: hooks.loadCurrentCredentials, onTokensRefreshed: hooks.onTokensRefreshed,
        fetchImpl: async (url) => {
          if (url.endsWith("/userres/v1/file/get_file_list")) {
            requestCount += 1;
            if (requestCount === 1) return new Response("{}", { status: 401 });
            retryEntered();
            return heldRetry;
          }
          if (url.endsWith("/v1/auth/token")) return new Response(JSON.stringify({ access_token: `late-next-${mutation}`, refresh_token: `late-next-r-${mutation}` }), { status: 200 });
          throw new Error("unexpected request");
        },
      });
      const pending = client.listFilesPage("root", 0).catch((error: unknown) => error);
      await retryStarted;
      if (mutation === "rebind") {
        await pool.query("UPDATE connected_storages SET payload=jsonb_set(payload,'{meta,connectedAt}',$2::jsonb) WHERE id=$1", [connected.storageId, JSON.stringify(`${marker}-new`)]);
      } else if (mutation === "rotate") {
        await pool.query("UPDATE connected_storages SET payload=payload || $2::jsonb WHERE id=$1", [connected.storageId, JSON.stringify({ accessToken: "newer-access", refreshToken: "newer-refresh" })]);
      }
      releaseRetry(new Response("{}", { status: 401 }));
      const error = await pending;
      const snapshot = getGuangYaAuthFailureSnapshot(error);
      expect(snapshot?.credentials.accessToken).toBe(`late-next-${mutation}`);
      expect(error).toBeInstanceOf(Error);
      expect(Object.keys(error as object)).not.toContain("credentials");
      const froze = await freezeGuangYaStorageIfUnchanged(snapshot!, "terminal unauthorized", (sql, values) => pool.query(sql, [...values]));
      expect(froze).toBe(mutation === "unchanged");
      const row = (await pool.query("SELECT status,frozen_reason FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { status: string; frozen_reason: string | null };
      expect(row.status).toBe(mutation === "unchanged" ? "frozen" : "active");
    }
  }, 30_000);

  it("lets two long-lived clients alternate refreshes through the real PostgreSQL CAS", async () => {
    const initial = { accessToken: "rotate-access-0", refreshToken: "rotate-refresh-0", deviceId: "rotate-device" };
    const connected = await createStorage({ ...initial, meta: { connectedAt: "rotate-bind" }, customMetadata: { keep: true } });
    const uid = (await pool.query("SELECT provider_uid FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { provider_uid: string };
    const makeHooks = () => createGuangYaAuthHooks({
      accountId: connected.accountId, connectedStorageId: connected.storageId, providerUid: uid.provider_uid,
      credentials: initial, connectionMarker: "rotate-bind",
    }, (sql, values) => pool.query(sql, [...values]));
    const hooksA = makeHooks();
    const hooksB = makeHooks();
    let refreshCount = 0;
    let acceptedAccess = initial.accessToken;
    let acceptedRefresh = initial.refreshToken;
    const expired = new Set<string>();
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      if (url.endsWith("/v1/auth/token")) {
        const body = JSON.parse(String(init.body)) as { refresh_token: string };
        expect(body.refresh_token).toBe(acceptedRefresh);
        refreshCount += 1;
        acceptedAccess = `rotate-access-${refreshCount}`;
        acceptedRefresh = `rotate-refresh-${refreshCount}`;
        return new Response(JSON.stringify({ access_token: acceptedAccess, refresh_token: acceptedRefresh }), { status: 200 });
      }
      if (url.endsWith("/userres/v1/file/get_file_list")) {
        const headers = init.headers as Record<string, string>;
        const authorization = headers.Authorization;
        if (!authorization) throw new Error("missing Authorization header");
        const access = authorization.replace("Bearer ", "");
        if (expired.has(access)) return new Response(JSON.stringify({ msg: "expired" }), { status: 401 });
        return new Response(JSON.stringify({ msg: "success", data: { list: [] } }), { status: 200 });
      }
      throw new Error("unexpected request");
    };
    const createClient = (hooks: ReturnType<typeof makeHooks>) => new GuangYaClient({
      ...hooks.credentials, fetchImpl, authCoordinator: createGuangYaAuthCoordinator(), authAccountKey: hooks.accountKey,
      loadCurrentCredentials: hooks.loadCurrentCredentials, onTokensRefreshed: hooks.onTokensRefreshed,
    });
    const clientA = createClient(hooksA);
    const clientB = createClient(hooksB);
    for (let round = 1; round <= 3; round += 1) {
      expired.add(acceptedAccess);
      await clientA.listFilesPage("root", 0);
      await clientB.listFilesPage("root", 0);
      expect(refreshCount).toBe(round);
      const row = (await pool.query("SELECT payload FROM connected_storages WHERE id=$1", [connected.storageId])).rows[0] as { payload: Record<string, unknown> };
      expect(row.payload).toMatchObject({ accessToken: acceptedAccess, refreshToken: acceptedRefresh, deviceId: initial.deviceId, meta: { connectedAt: "rotate-bind" }, customMetadata: { keep: true } });
      await clientA.listFilesPage("root", 0);
      await clientB.listFilesPage("root", 0);
      expect(refreshCount).toBe(round);
    }
  }, 30_000);
});
