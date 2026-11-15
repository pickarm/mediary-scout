import { Pool } from "pg";
import { configuredJevConcurrency, configuredPanSouConcurrency } from "@media-track/workflow";
import { PreparationService, PostgresPreparationStore, type PreparationContextProvider } from "@media-track/workflow/library";
import { postgresConnectionString, refreshLibraryPreparationContext } from "./workflow-runtime";

let pool: Pool | null = null;
let store: PostgresPreparationStore | null = null;
let service: PreparationService | null = null;

/** Singleton used by both the independent preparation worker and acquisition reads. */
export function getLibraryPreparationService(): PreparationService {
  if (service) return service;
  const currentStore = getLibraryPreparationStore();
  const context: PreparationContextProvider = { refresh: refreshLibraryPreparationContext };
  service = new PreparationService({
    store: currentStore,
    context,
    preparationConcurrency: boundedEnv("MEDIA_TRACK_PREPARATION_CONCURRENCY", 5, 1, 20),
    panSouConcurrency: configuredPanSouConcurrency(),
    aiConcurrency: configuredJevConcurrency(),
  });
  return service;
}

export async function ensureLibraryPreparationRuntime(): Promise<void> {
  await getLibraryPreparationStore().ensureSchema();
}

function getLibraryPreparationStore(): PostgresPreparationStore {
  store ??= new PostgresPreparationStore(getLibraryPreparationPool());
  return store;
}

export function getLibraryPreparationPool(): Pool {
  pool ??= new Pool({ connectionString: postgresConnectionString(), max: 4, application_name: "media-track-library-preparation" });
  return pool;
}

export async function closeLibraryPreparationRuntimeForTests(): Promise<void> {
  const current = pool;
  pool = null;
  store = null;
  service = null;
  await current?.end();
}

function boundedEnv(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("PREPARATION_LIMIT_INVALID");
  return value;
}
