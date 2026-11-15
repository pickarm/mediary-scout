import {
  LibraryScanScheduler,
  PostgresIdentificationStore,
  PostgresScanStore,
  type ScanScope,
} from "@media-track/workflow/library";
import { isDemoMode } from "./demo-mode";
import { getLibraryIdentificationService } from "./library-identification-runtime";
import { getLibraryPool, getLibraryServices } from "./library-runtime";
import { isUpdateHoldActive, whileInFlight } from "./update-hold";

const INTERVAL_MS = boundedEnv("MEDIA_TRACK_LIBRARY_SCAN_WORKER_POLL_MS", 15_000, 2_000, 60_000);
const MAX_SCOPES_PER_TICK = 4;
const IDENTIFICATION_CONCURRENCY = 2;
const MAX_QUEUED_IDENTIFICATION_SCOPES = 64;
let started = false;
let ticking = false;
let scopeCursor: ScopeCursor | null = null;
const schedulers = new Map<string, LibraryScanScheduler>();
let workerScanStore: PostgresScanStore | null = null;
let workerIdentificationStore: PostgresIdentificationStore | null = null;
const identificationServices = new Map<string, { service: Awaited<ReturnType<typeof getLibraryIdentificationService>>; refreshedAt: number }>();
const identificationDispatcher = createIdentificationDispatcher({
  concurrency: IDENTIFICATION_CONCURRENCY,
  canStart: () => !isUpdateHoldActive(Date.now()),
  run: runIdentificationBatch,
  onError: (scope, error) => console.error(`[library-scan-worker] identification failed for storage ${scope.connectedStorageId}: ${safeError(error)}`),
});

/** Independent bounded scanner/identification loop; does not wait behind acquisition draining. */
export function startLibraryScanWorker(): void {
  if (started || process.env.MEDIA_TRACK_INPROCESS_WORKER === "0" || process.env.MEDIA_TRACK_REHEARSAL === "1" || isDemoMode()) return;
  started = true;
  const tick = async (): Promise<void> => {
    if (ticking || isUpdateHoldActive(Date.now())) return;
    ticking = true;
    try {
      await whileInFlight(async () => {
        if (isUpdateHoldActive(Date.now())) return;
        const ordered = await listActiveGuangyaScopes();
        for (const scope of ordered.slice(0, MAX_SCOPES_PER_TICK)) {
          if (isUpdateHoldActive(Date.now())) break;
          try { await schedulerFor(scope).tick(scope); }
          catch (error) { console.error(`[library-scan-worker] tick failed for storage ${scope.connectedStorageId}: ${safeError(error)}`); }
        }
        identificationDispatcher.pump();
      });
    } catch (error) {
      console.error(`[library-scan-worker] tick failed: ${safeError(error)}`);
    } finally { ticking = false; }
  };
  console.log(`[library-scan-worker] started (poll ${INTERVAL_MS}ms)`);
  void tick();
  setInterval(() => { void tick(); }, INTERVAL_MS);
}

async function listActiveGuangyaScopes(): Promise<ScanScope[]> {
  const pool = getLibraryPool();
  await getWorkerScanStore().ensureSchema();
  const after = scopeCursor;
  let result = await queryScopePage(pool, after, MAX_SCOPES_PER_TICK);
  if (!result.length && after) result = await queryScopePage(pool, null, MAX_SCOPES_PER_TICK);
  if (result.length) scopeCursor = { accountId: result.at(-1)!.accountId, connectedStorageId: result.at(-1)!.connectedStorageId };
  return result;
}

function schedulerFor(scope: ScanScope): LibraryScanScheduler {
  const key = `${scope.accountId}\0${scope.connectedStorageId}`;
  let scheduler = schedulers.get(key);
  if (!scheduler) {
    scheduler = new LibraryScanScheduler({
      store: {
        listConfigurations: async (s, limit, after) => (await getLibraryServices(s)).scanStore.listConfigurations(s, limit, after),
        listTasks: async (s, input) => (await getLibraryServices(s)).scanStore.listTasks(s, input),
        getConfiguration: async (s, id) => (await getLibraryServices(s)).scanStore.getConfiguration(s, id),
        getTask: async (s, id) => (await getLibraryServices(s)).scanStore.getTask(s, id),
        createTask: async (input) => (await getLibraryServices(input.scope)).scanStore.createTask(input),
        createScheduledTask: async (input) => (await getLibraryServices(input.scope)).scanStore.createScheduledTask(input),
        hasActiveTaskForConfiguration: async (s, id) => (await getLibraryServices(s)).scanStore.hasActiveTaskForConfiguration(s, id),
      },
      resumeScan: async (s, taskId) => { const services = await getLibraryServices(s); await services.scanner.resume(s, taskId); },
      hasIdentificationJob: async (s, id) => Boolean(await getWorkerIdentificationStore().getJob(s, id)),
      ensureIdentification: async (s, taskId) => getWorkerIdentificationStore().enqueueForScan(s, taskId),
      drainIdentification: async (s) => { identificationDispatcher.enqueue(s); },
    });
    schedulers.set(key, scheduler);
  }
  return scheduler;
}

interface ScopeCursor { accountId: string; connectedStorageId: string }
interface ScopeRow { account_id: string; connected_storage_id: string }

async function queryScopePage(pool: ReturnType<typeof getLibraryPool>, after: ScopeCursor | null, limit: number): Promise<ScanScope[]> {
  const cursorSql = after ? "AND (s.account_id,s.id) > ($1,$2)" : "";
  const params = after ? [after.accountId, after.connectedStorageId, limit] : [limit];
  const limitIndex = params.length;
  const result = await pool.query<ScopeRow>(
    "SELECT s.account_id,s.id AS connected_storage_id FROM connected_storages s " +
    "WHERE s.provider='guangya' AND s.status='active' " + cursorSql + " " +
    "AND (EXISTS (SELECT 1 FROM library_scan_configs c WHERE c.account_id=s.account_id AND c.connected_storage_id=s.id) " +
    "OR EXISTS (SELECT 1 FROM library_scan_tasks t WHERE t.account_id=s.account_id AND t.connected_storage_id=s.id)) " +
    `ORDER BY s.account_id,s.id LIMIT $${limitIndex}`,
    params,
  );
  return result.rows.map((row) => ({ accountId: row.account_id, connectedStorageId: row.connected_storage_id }));
}

interface IdentificationDispatcherOptions {
  concurrency: number;
  canStart(): boolean;
  run(scope: ScanScope): Promise<void>;
  onError(scope: ScanScope, error: unknown): void;
}

/** Bounded fair async queue used so scan ticks never await TMDB/AI identification. */
export function createIdentificationDispatcher(options: IdentificationDispatcherOptions): {
  enqueue(scope: ScanScope): void;
  pump(): void;
} {
  const queued = new Map<string, ScanScope>();
  const running = new Set<string>();
  const keyFor = (scope: ScanScope) => `${scope.accountId}\0${scope.connectedStorageId}`;
  const pump = (): void => {
    while (options.canStart() && running.size < options.concurrency) {
      const next = [...queued.entries()].find(([key]) => !running.has(key));
      if (!next) return;
      const [key, scope] = next;
      queued.delete(key);
      running.add(key);
      void options.run(scope).catch((error: unknown) => { options.onError(scope, error); }).finally(() => {
        running.delete(key);
        pump();
      });
    }
  };
  return {
    enqueue(scope) {
      const key = keyFor(scope);
      if (!queued.has(key) && !running.has(key) && queued.size >= MAX_QUEUED_IDENTIFICATION_SCOPES) return;
      queued.set(key, scope); pump();
    },
    pump,
  };
}

async function runIdentificationBatch(scope: ScanScope): Promise<void> {
  if (isUpdateHoldActive(Date.now())) return;
  await whileInFlight(async () => {
    if (isUpdateHoldActive(Date.now())) return;
    const key = `${scope.accountId}\0${scope.connectedStorageId}`;
    let cached = identificationServices.get(key);
    if (!cached || Date.now() - cached.refreshedAt > 5 * 60_000) {
      const service = await getLibraryIdentificationService(scope);
      cached = { service, refreshedAt: Date.now() };
      identificationServices.set(key, cached);
    }
    const service = cached.service;
    const jobs = await service.identificationStore.drainPending(scope, 1);
    for (const job of jobs) {
      if (isUpdateHoldActive(Date.now())) return;
      await service.processTaskBatch(job.scope, job.taskId);
    }
  });
}

function getWorkerScanStore(): PostgresScanStore {
  workerScanStore ??= new PostgresScanStore(getLibraryPool());
  return workerScanStore;
}
function getWorkerIdentificationStore(): PostgresIdentificationStore {
  workerIdentificationStore ??= new PostgresIdentificationStore(getLibraryPool());
  return workerIdentificationStore;
}

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 300) : "unknown error"; }
