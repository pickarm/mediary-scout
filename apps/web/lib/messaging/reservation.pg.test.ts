import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresWorkflowRepository, initializeWorkflowPostgresSchema } from "../../../../packages/workflow/src/postgres";
import { queueMovieAcquisition } from "../../../../packages/workflow/src/commands";
import { PostgresMessagingStore } from "./store";
import { MessagingCommandProcessor } from "./commands";
import { createMessagingEnqueue } from "./enqueue";
import type { MessagingConnection } from "./types";
import { workflowPersistenceFixture } from "../../../../packages/workflow/tests/workflow-fixtures";

const adminUrl = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
describe.skipIf(!adminUrl)("message-to-native reservation transaction", () => {
  const database = `v11_reservation_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let repository: PostgresWorkflowRepository;
  let store: PostgresMessagingStore;
  const connection: MessagingConnection = { id: "reservation-bot", accountId: "acct_default", platform: "telegram", botId: "1", enabled: true, senderId: "2", defaultStorageId: null, credentials: {} };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(adminUrl!); url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    pool.on("error", () => {});
    await initializeWorkflowPostgresSchema(pool);
    repository = new PostgresWorkflowRepository(pool);
    store = new PostgresMessagingStore(pool);
    await store.ensureSchema();
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); }
  });
  const title = { id: "tmdb_movie_991119", tmdbId: 991119, type: "movie" as const, title: "事务测试电影", originalTitle: "Transaction", year: 2024, aliases: [] };

  it("associates a new or existing native run before the queue transaction commits", async () => {
    const [job] = await store.accept(connection, [{ connectionId: connection.id, platform: "telegram", botId: "1", messageId: "message-one", conversationId: "2", senderId: "2", text: "事务测试电影" }]);
    await store.update(connection.accountId, job!.id, { phase: "queued" });
    const queued = await queueMovieAcquisition({ title, keyword: title.title, repository, accountId: connection.accountId, messagingJobId: job!.id });
    expect((await store.get(connection.accountId, job!.id))?.workflowRunId).toBe(queued.workflowRunId);
    const again = await queueMovieAcquisition({ title, keyword: title.title, repository, accountId: connection.accountId, messagingJobId: job!.id });
    expect(again.workflowRunId).toBe(queued.workflowRunId);
    expect((await pool.query("SELECT count(*)::int AS n FROM workflow_runs")).rows[0]?.n).toBe(1);
  });

  it("rolls back a reservation when the associated message does not belong to the account", async () => {
    const otherTitle = { ...title, id: "tmdb_movie_991120", tmdbId: 991120 };
    await expect(queueMovieAcquisition({ title: otherTitle, keyword: otherTitle.title, repository, accountId: connection.accountId, messagingJobId: "missing-message" })).rejects.toThrow(/消息任务/);
    expect((await pool.query("SELECT count(*)::int AS n FROM workflow_runs WHERE tracked_season_id=$1", [`${otherTitle.id}_movie`])).rows[0]?.n).toBe(0);
  });

  it("dispatches a sole title from received/running through the real reservation without hand-setting queued", async () => {
    const single = { ...title, id: "tmdb_movie_991121", tmdbId: 991121 };
    await store.accept(connection, [{ connectionId: connection.id, platform: "telegram", botId: "1", messageId: "single-command", conversationId: "2", senderId: "2", text: "我想看事务测试电影" }]);
    const job = await store.claimNext();
    expect(job?.phase).toBe("running");
    const processor = new MessagingCommandProcessor(store, {
      search: async () => ({ choices: [], request: { titleId: single.id, mediaType: "movie", title: single.title, seasonNumber: null } }),
      enqueue: createMessagingEnqueue(pool, async (accountId, _candidate, storageId, messagingJobId) => queueMovieAcquisition({ title: single, keyword: single.title, repository, accountId, connectedStorageId: storageId, messagingJobId })),
      listStorages: async () => [{ id: "test-drive", label: "光鸭测试盘" }],
      query: async () => [],
      stop: async ({ id }) => ({ taskId: id, stopped: false, reason: "finished" }),
    });
    expect((await processor.handle(job!, connection)).text).toContain("已排队");
    const stored = await store.get(connection.accountId, job!.id);
    expect(stored?.workflowRunId).toBeTruthy();
    expect((await repository.getWorkflowRunSnapshot(stored!.workflowRunId!, connection.accountId))?.title.tmdbId).toBe(991121);
  });
  it("commits an already-tracked reply as pending before the caller can crash", async () => {
    const fixture = workflowPersistenceFixture();
    await repository.saveWorkflowRunSnapshot({ ...fixture, accountId: connection.accountId, workflowRun: { ...fixture.workflowRun, status: "succeeded" } });
    const [job] = await store.accept(connection, [{ connectionId: connection.id, platform: "telegram", botId: "1", messageId: "already-tracked", conversationId: "2", senderId: "2", text: fixture.title.title }]);
    await store.update(connection.accountId, job!.id, { phase: "queued" });
    expect(await repository.reserveWorkflowRun({ ...fixture, accountId: connection.accountId, workflowRun: { ...fixture.workflowRun, id: "blocked-new-run", status: "queued" }, transferAttempts: [], notifications: [], decisions: [], resourceSnapshots: [], messagingJobId: job!.id, blockIfEpisodeStatesExist: true })).toMatchObject({ status: "already_has_episode_state" });
    expect(await store.get(connection.accountId, job!.id)).toMatchObject({ phase: "completed", workflowRunId: null, sendStatus: "pending", result: { kind: "already_tracked", text: expect.any(String) } });
  });
});
