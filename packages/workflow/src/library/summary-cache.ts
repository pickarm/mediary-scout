import { randomUUID, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createClient, type RedisClientType } from "redis";

export type SummaryCacheKind = "media" | "activity";
export interface SummaryCacheOptions {
  pool: Pool;
  redisUrl?: string;
  namespace?: string;
  /** Stable, credential-free identity for the PostgreSQL database being queried. */
  databaseIdentity?: string;
  mediaTtlMs?: number;
  activityTtlMs?: number;
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
}

const CHANNEL = "media_track_summary_v1";
const SCHEMA_LOCK = 4_011_989_148;
const MAX_TTL_MS = 30_000;
const MAX_INPUT_BYTES = 8_192;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_IN_FLIGHT = 256;
const DEFAULT_COMMAND_TIMEOUT_MS = 250;
const DEFAULT_CONNECT_TIMEOUT_MS = 700;

const TABLES = ["media_titles", "tracked_seasons", "episode_states", "episode_copies", "workflow_runs", "notifications"] as const;

function boundedTtl(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(MAX_TTL_MS, Math.floor(value));
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 25 || value > 5_000) return fallback;
  return value;
}

function canonicalJson(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" && Buffer.byteLength(text, "utf8") <= MAX_INPUT_BYTES ? text : null;
  } catch {
    return null;
  }
}

function triggerDdl(): string {
  const triggers = TABLES.flatMap((table) => ([
    { operation: "INSERT", transition: "NEW TABLE AS new_rows", relation: "new_rows", suffix: "ins" },
    { operation: "UPDATE", transition: "OLD TABLE AS old_rows NEW TABLE AS new_rows", relation: "new_rows", suffix: "upd" },
    { operation: "DELETE", transition: "OLD TABLE AS old_rows", relation: "old_rows", suffix: "del" },
  ] as const).map(({ operation, transition, relation, suffix }) => {
    const name = `media_track_summary_${table}_${suffix}`;
    return `
      DO $trigger$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgrelid = '${table}'::regclass AND tgname = '${name}' AND NOT tgisinternal
        ) THEN
          CREATE TRIGGER ${name}
          AFTER ${operation} ON ${table}
          REFERENCING ${transition}
          FOR EACH STATEMENT
          EXECUTE FUNCTION media_track_summary_invalidate('${relation}');
        END IF;
      END
      $trigger$;
    `;
  })).join("\n");
  return `
    CREATE OR REPLACE FUNCTION media_track_summary_invalidate() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    DECLARE affected boolean := false;
    BEGIN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I)', TG_ARGV[0]) INTO affected;
      IF affected THEN PERFORM pg_notify('${CHANNEL}', 'v1'); END IF;
      RETURN NULL;
    END
    $function$;
    ${triggers}
  `;
}

/** Installs statement triggers that notify only when transition rows exist. */
export async function initializePostgresSummaryCache(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK]);
    await client.query(triggerDdl());
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the DDL failure */ }
    throw error;
  } finally {
    client.release();
  }
}

function normalizedNamespace(value: string | undefined): string {
  const candidate = value?.trim() || "mediary-scout";
  if (candidate.length > 100 || !/^[a-zA-Z0-9._:-]+$/.test(candidate)) return "mediary-scout";
  return candidate;
}

/**
 * Optional cache-aside for bounded, read-only PostgreSQL summaries.
 * Cache use is gated on a live PG LISTEN connection and a ready Redis client.
 */
export class PostgresSummaryCache {
  private readonly pool: Pool;
  private readonly redisUrl: string;
  private readonly namespace: string;
  private readonly mediaTtlMs: number;
  private readonly activityTtlMs: number;
  private readonly commandTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private redis: RedisClientType | null = null;
  private listener: PoolClient | null = null;
  private generation: string | null = null;
  private starting: Promise<boolean> | null = null;
  private lastStartFailureAt = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 250;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly subscribers = new Set<() => void>();

  constructor(options: SummaryCacheOptions) {
    this.pool = options.pool;
    const identity = options.databaseIdentity?.trim() ?? "";
    this.redisUrl = identity ? options.redisUrl?.trim() ?? "" : "";
    const identityHash = identity ? createHash("sha256").update(identity).digest("hex").slice(0, 24) : "disabled";
    this.namespace = `${normalizedNamespace(options.namespace)}:${identityHash}`;
    this.mediaTtlMs = boundedTtl(options.mediaTtlMs, 5_000);
    this.activityTtlMs = boundedTtl(options.activityTtlMs, 1_000);
    this.commandTimeoutMs = boundedTimeout(options.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
    this.connectTimeoutMs = boundedTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
  }

  isReady(): boolean {
    return !this.stopped && this.generation !== null && this.listener !== null && this.redis?.isReady === true;
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private emitWake(): void {
    for (const listener of this.subscribers) {
      try { listener(); } catch { /* a subscriber cannot affect cache invalidation */ }
    }
  }

  private createRedis(): RedisClientType {
    const client = createClient<{}, {}, {}, 3, {}>({
      url: this.redisUrl,
      name: `${this.namespace}-summary-cache`,
      disableOfflineQueue: true,
      commandOptions: { timeout: this.commandTimeoutMs },
      socket: {
        connectTimeout: this.connectTimeoutMs,
        reconnectStrategy: (retries) => Math.min(5_000, 250 * Math.max(1, retries)),
      },
    });
    client.on("error", () => { this.generation = null; });
    client.on("reconnecting", () => { this.generation = null; });
    client.on("ready", () => {
      this.generation = null;
      if (this.listener) void this.rotateGeneration(true);
    });
    return client;
  }

  private async rotateGeneration(emitWake: boolean): Promise<boolean> {
    const redis = this.redis;
    if (!redis?.isReady || !this.listener || this.stopped) return false;
    this.generation = null;
    try {
      const key = `${this.namespace}:summary:generation`;
      await redis.sendCommand(["SET", key, randomUUID()]);
      const generation = await redis.get(key);
      if (!generation || this.stopped || !redis.isReady || !this.listener) return false;
      this.generation = generation;
      this.reconnectDelayMs = 250;
      if (emitWake) this.emitWake();
      return true;
    } catch {
      this.generation = null;
      return false;
    }
  }

  private async attachListener(): Promise<boolean> {
    if (this.listener || this.stopped) return this.listener !== null;
    const client = await this.pool.connect();
    let lost = false;
    const lose = () => {
      if (lost) return;
      lost = true;
      this.generation = null;
      if (this.listener === client) this.listener = null;
      try { client.release(true); } catch { /* the connection is already gone */ }
      this.scheduleReconnect();
    };
    client.on("notification", (notification) => {
      if (notification.channel !== CHANNEL || notification.payload !== "v1") return;
      this.generation = null;
      void this.rotateGeneration(true);
    });
    client.on("error", lose);
    client.on("end", lose);
    try {
      await client.query(`LISTEN ${CHANNEL}`);
      if (this.stopped) { client.release(); return false; }
      this.listener = client;
      return true;
    } catch (error) {
      lose();
      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(5_000, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureStarted(true);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private ensureStarted(force = false): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (this.isReady()) return Promise.resolve(true);
    if (this.starting) return this.starting;
    if (!this.redisUrl) return Promise.resolve(false);
    if (!force && Date.now() - this.lastStartFailureAt < 5_000) return Promise.resolve(false);
    this.starting = (async () => {
      try {
        if (!this.redis) this.redis = this.createRedis();
        if (!this.redis.isOpen) await this.redis.connect();
        await initializePostgresSummaryCache(this.pool);
        if (!await this.attachListener()) throw new Error("summary listener unavailable");
        const ready = await this.rotateGeneration(true);
        if (!ready) throw new Error("summary cache generation unavailable");
        return true;
      } catch {
        this.lastStartFailureAt = Date.now();
        this.generation = null;
        if (!this.listener) this.scheduleReconnect();
        return false;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** Explicit warm-up for integration tests or controlled server initialization. */
  start(): Promise<boolean> {
    return this.ensureStarted(true);
  }

  private async loadWithCache<T>(kind: SummaryCacheKind, input: unknown, loader: () => Promise<T>): Promise<T> {
    if (!this.isReady()) {
      void this.ensureStarted();
      return loader();
    }
    const redis = this.redis;
    if (!redis?.isReady) return loader();
    const canonical = canonicalJson(input);
    if (canonical === null) return loader();
    const hash = createHash("sha256").update(canonical).digest("hex");
    let generation: string;
    try {
      const shared = await redis.get(`${this.namespace}:summary:generation`);
      if (!shared) {
        this.generation = null;
        await this.rotateGeneration(true);
        return loader();
      }
      if (!redis.isReady || !this.listener) { this.generation = null; return loader(); }
      generation = shared;
      this.generation = shared;
    } catch {
      this.generation = null;
      return loader();
    }
    const key = `${this.namespace}:summary:v1:${generation}:${kind}:${hash}`;
    try {
      const raw = await redis.get(key);
      if (raw && Buffer.byteLength(raw, "utf8") <= MAX_VALUE_BYTES) {
        const envelope: unknown = JSON.parse(raw);
        if (envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
          const candidate = envelope as { version?: unknown; generation?: unknown; kind?: unknown; payload?: unknown };
          if (candidate.version === 1 && candidate.generation === generation && candidate.kind === kind && "payload" in candidate) {
            return candidate.payload as T;
          }
        }
      }
    } catch {
      this.generation = null;
      return loader();
    }

    const inflightKey = `${generation}:${kind}:${hash}`;
    const existing = this.inFlight.get(inflightKey);
    if (existing) return existing as Promise<T>;
    const pending = (async () => {
      const result = await loader();
      try {
        const serialized = JSON.stringify({ version: 1, generation, kind, payload: result });
        if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") <= MAX_VALUE_BYTES &&
            this.isReady() && this.generation === generation && redis.isReady) {
          try {
            const ttl = kind === "media" ? this.mediaTtlMs : this.activityTtlMs;
            await redis.sendCommand(["SET", key, serialized, "PX", String(ttl)]);
          } catch {
            this.generation = null;
          }
        }
      } catch { /* serialization is optional; preserve the PostgreSQL result */ }
      return result;
    })();
    if (this.inFlight.size < MAX_IN_FLIGHT) {
      this.inFlight.set(inflightKey, pending);
      void pending.finally(() => { this.inFlight.delete(inflightKey); }).catch(() => undefined);
    }
    return pending;
  }

  getOrLoad<T>(kind: SummaryCacheKind, normalizedInput: unknown, loader: () => Promise<T>): Promise<T> {
    return this.loadWithCache(kind, normalizedInput, loader);
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.generation = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const listener = this.listener;
    this.listener = null;
    if (listener) {
      try { await listener.query(`UNLISTEN ${CHANNEL}`); } catch { /* closing is best effort */ }
      try { listener.release(); } catch { /* already released */ }
    }
    const redis = this.redis;
    this.redis = null;
    redis?.destroy();
    this.inFlight.clear();
    this.subscribers.clear();
  }
}
