import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import type { StorageExecutor } from "../ports.js";

export interface GuangYaWriteClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
  release(error?: Error | boolean): void;
  on?(event: "error", listener: (error: Error) => void): unknown;
  off?(event: "error", listener: (error: Error) => void): unknown;
}

export interface GuangYaWritePool {
  connect(): Promise<GuangYaWriteClient>;
}

interface WriteContext {
  coordinator: GuangYaWriteCoordinator;
  client: GuangYaWriteClient;
  held: Set<string>;
  active: boolean;
}

export type GuangYaWriteCoordinatorHandle = Pick<GuangYaWriteCoordinator, "run" | "assertHeld">;

interface StorageWriteMetadata {
  accountKey: string;
  coordinator: GuangYaWriteCoordinatorHandle;
}

const writeContext = new AsyncLocalStorage<WriteContext>();
const STORAGE_ACCOUNT_KEY = Symbol.for("media-track.guangya-storage-account-key");

export function setStorageWriteAccountKey(
  executor: StorageExecutor,
  accountKey: string,
  coordinator: GuangYaWriteCoordinatorHandle,
): void {
  Object.defineProperty(executor, STORAGE_ACCOUNT_KEY, { value: { accountKey, coordinator } satisfies StorageWriteMetadata });
}

export function getStorageWriteAccountKey(executor: object): string | null {
  return (executor as StorageExecutor & { [STORAGE_ACCOUNT_KEY]?: StorageWriteMetadata })[STORAGE_ACCOUNT_KEY]?.accountKey ?? null;
}

function getStorageWriteMetadata(executor: object): StorageWriteMetadata | null {
  return (executor as StorageExecutor & { [STORAGE_ACCOUNT_KEY]?: StorageWriteMetadata })[STORAGE_ACCOUNT_KEY] ?? null;
}

/** Session advisory locks fence all writes for one physical GuangYa account. */
export class GuangYaWriteCoordinator {
  constructor(private readonly pool: GuangYaWritePool) {}

  async run<T>(accountKeys: readonly string[], fn: () => Promise<T>): Promise<T> {
    const keys = [...new Set(accountKeys.map(normalizeAccountKey))].sort();
    if (keys.length === 0) return fn();

    const current = writeContext.getStore();
    if (current && current.coordinator !== this) {
      throw new Error("GUANGYA_WRITE_COORDINATOR_NESTING: cannot nest a different coordinator instance");
    }
    if (current?.coordinator === this) {
      this.assertContextHealthy(current);
      const missing = keys.filter((key) => !current.held.has(key));
      if (missing.length === 0) return fn();
      const greatest = [...current.held].sort().at(-1);
      if (greatest && missing.some((key) => key < greatest)) {
        throw new Error("GUANGYA_WRITE_LOCK_ORDER: nested task requested an account before an already-held account");
      }
      const acquired: string[] = [];
      try {
        for (const key of missing) {
          try {
            await lockAccount(current.client, key);
          } catch (error) {
            current.active = false;
            throw error;
          }
          current.held.add(key);
          acquired.push(key);
        }
        return await fn();
      } catch (error) {
        throw error;
      } finally {
        await unlockAccounts(current, acquired);
      }
    }

    const client = await this.pool.connect();
    const context: WriteContext = { coordinator: this, client, held: new Set(), active: true };
    const onClientError = () => { context.active = false; };
    client.on?.("error", onClientError);
    try {
      for (const key of keys) {
        try {
          await lockAccount(client, key);
        } catch (error) {
          context.active = false;
          throw error;
        }
        context.held.add(key);
      }
      return await writeContext.run(context, fn);
    } finally {
      await unlockAccounts(context, [...context.held].reverse());
      const destroyClient = !context.active;
      client.release(destroyClient ? new Error("GUANGYA_WRITE_LOCK_CONNECTION_UNHEALTHY") : undefined);
      if (!destroyClient) client.off?.("error", onClientError);
    }
  }

  /** Must be called immediately before every provider mutation request. */
  async assertHeld(accountKey: string): Promise<void> {
    const key = normalizeAccountKey(accountKey);
    const context = writeContext.getStore();
    if (!context || context.coordinator !== this || !context.held.has(key)) {
      throw new Error(`GUANGYA_WRITE_LOCK_REQUIRED: ${key}`);
    }
    this.assertContextHealthy(context);
    try {
      await context.client.query("SELECT 1");
    } catch (error) {
      context.active = false;
      throw new Error(`GUANGYA_WRITE_LOCK_LOST: ${key}`, { cause: error });
    }
    this.assertContextHealthy(context);
  }

  private assertContextHealthy(context: WriteContext): void {
    if (!context.active) throw new Error("GUANGYA_WRITE_LOCK_LOST: task connection is no longer fenced");
  }
}

const DISABLED_COORDINATOR = {
  async run<T>(_keys: readonly string[], fn: () => Promise<T>): Promise<T> { return fn(); },
  async assertHeld(_key: string): Promise<void> {},
} satisfies Pick<GuangYaWriteCoordinator, "run" | "assertHeld">;

const SHARED_COORDINATOR = Symbol.for("media-track.guangya-write-coordinator");
type CoordinatorRegistry = { byConnectionString: Map<string, GuangYaWriteCoordinator> };
type GlobalRegistry = typeof globalThis & { [SHARED_COORDINATOR]?: CoordinatorRegistry };

/** Shared across duplicate package/module copies within the same Node process. */
export function getGuangYaWriteCoordinator(
  env: Record<string, string | undefined> = process.env,
): Pick<GuangYaWriteCoordinator, "run" | "assertHeld"> {
  const registry = globalThis as GlobalRegistry;
  const connectionString = env.MEDIA_TRACK_POSTGRES_URL?.trim();
  if (!connectionString) return DISABLED_COORDINATOR;
  const coordinators = registry[SHARED_COORDINATOR] ?? { byConnectionString: new Map() };
  registry[SHARED_COORDINATOR] = coordinators;
  const existing = coordinators.byConnectionString.get(connectionString);
  if (existing) return existing;
  const pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000 });
  const coordinator = new GuangYaWriteCoordinator(pool);
  coordinators.byConnectionString.set(connectionString, coordinator);
  return coordinator;
}

export async function withStorageWriteTask<T>(
  executors: readonly (object | null | undefined)[],
  fn: () => Promise<T>,
  coordinator?: Pick<GuangYaWriteCoordinator, "run">,
): Promise<T> {
  const metadata = executors.flatMap((executor) => executor ? [getStorageWriteMetadata(executor)].filter((entry): entry is StorageWriteMetadata => entry !== null) : []);
  const executorCoordinators = new Set(metadata.map((entry) => entry.coordinator));
  if (executorCoordinators.size > 1 || (coordinator && [...executorCoordinators].some((entry) => entry !== coordinator))) {
    throw new Error("GUANGYA_WRITE_COORDINATOR_MISMATCH: executors do not share the selected PostgreSQL coordinator");
  }
  const selected = coordinator ?? metadata[0]?.coordinator ?? getGuangYaWriteCoordinator();
  return selected.run(metadata.map((entry) => entry.accountKey), fn);
}

function normalizeAccountKey(value: string): string {
  const key = value.trim();
  if (!key) throw new Error("GUANGYA_ACCOUNT_KEY_REQUIRED");
  return key;
}

async function lockAccount(client: GuangYaWriteClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
}

async function unlockAccounts(context: WriteContext, keys: readonly string[]): Promise<void> {
  if (!context.active) return;
  for (const key of keys) {
    if (!context.held.has(key)) continue;
    try {
      const result = await context.client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      if (unlockResultIsFalse(result)) throw new Error("GUANGYA_WRITE_UNLOCK_FAILED");
      context.held.delete(key);
    } catch {
      context.active = false;
      return;
    }
  }
}

function unlockResultIsFalse(result: unknown): boolean {
  if (!result || typeof result !== "object" || !("rows" in result)) return false;
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length === 0) return true;
  const first = rows[0];
  if (!first || typeof first !== "object") return true;
  return Object.values(first as Record<string, unknown>)[0] !== true;
}

