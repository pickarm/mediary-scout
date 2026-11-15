import {
  createAiIdentitySuggester,
  createTmdbIdentificationAdapter,
  IdentificationService,
  PostgresLibraryStore,
  type ScanScope,
} from "@media-track/workflow/library";
import { createTmdbMetadataProvider, createTmdbSearchProvider } from "@media-track/workflow";
import { getAgentModelForSearch, getAccountScopedSettings, getTmdbAccesses } from "./workflow-runtime";
import { getLibraryServices } from "./library-runtime";

const identificationWatches = new Map<string, Promise<void>>();

export async function getLibraryIdentificationService(scope: ScanScope): Promise<IdentificationService> {
  const services = await getLibraryServices(scope);
  const settings = getAccountScopedSettings(scope.accountId);
  const accesses = await getTmdbAccesses(settings);
  const search = createTmdbSearchProvider(accesses);
  const metadata = createTmdbMetadataProvider(accesses);
  const model = await getAgentModelForSearch(settings);
  return new IdentificationService({
    pool: services.pool,
    scanStore: services.scanStore,
    tmdb: createTmdbIdentificationAdapter(search, metadata),
    ...(model ? { suggester: createAiIdentitySuggester(model) } : {}),
  });
}

/** Called by the daily scheduler or a worker after startup to resume durable jobs for a scope. */
export async function drainLibraryIdentifications(scope: ScanScope, limit = 10): Promise<void> {
  const service = await getLibraryIdentificationService(scope);
  await service.drainPending(scope, limit);
}

export async function setLibrarySeasonTracking(scope: ScanScope, trackedSeasonId: string, autoAcquire: boolean): Promise<void> {
  const services = await getLibraryServices(scope);
  await new PostgresLibraryStore(services.pool).setSeasonAutoAcquire({
    accountId: scope.accountId,
    connectedStorageId: scope.connectedStorageId,
    trackedSeasonId,
    autoAcquire,
  });
}

/** Short non-blocking watch bridges a long scanner run to its durable waiting job. */
export function watchLibraryScanForIdentification(scope: ScanScope, taskId: string): Promise<void> {
  const key = `${scope.accountId}\0${scope.connectedStorageId}\0${taskId}`;
  const existing = identificationWatches.get(key);
  if (existing) return existing;
  const run = runWatch();
  identificationWatches.set(key, run);
  return run.finally(() => { if (identificationWatches.get(key) === run) identificationWatches.delete(key); });

  async function runWatch(): Promise<void> {
    const services = await getLibraryServices(scope);
    const deadline = Date.now() + 24 * 60 * 60_000;
    let delayMs = 5_000;
    while (Date.now() < deadline) {
      const task = await services.scanStore.getTask(scope, taskId);
      if (!task || task.status === "cancelled" || task.status === "failed" || task.status === "completed" || task.status === "partial") {
        if (task) await drainLibraryIdentifications(scope, 10);
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(60_000, delayMs * 2);
    }
  }
}
