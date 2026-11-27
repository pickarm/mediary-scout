import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import {
  PostgresScanStore,
  LibraryScanner,
  createGuangYaDirectoryReader,
  createGuangYaRequestScheduler,
  createStorageDirectoryReader,
  getGuangYaMinIntervalMs,
  type DirectoryReader,
  type ScanScope,
} from "@media-track/workflow/library";
import {
  GuangYaClient,
  STORAGE_BRANDS,
  getGuangYaAuthCoordinator,
  getStorageBrand,
  isRegisteredStorageProvider,
  parseGuangYaUid,
  type ConnectedStorage,
} from "@media-track/workflow";
import { getLibraryStorageExecutor, getWorkflowRepository } from "./workflow-runtime";
import { getLibraryDatabasePool } from "./library-database";
import { createGuangYaAuthHooks } from "./guangya-auth-runtime";
import {
  createGuangYaTokenPersister as createWorkflowGuangYaTokenPersister,
  type ConnectedStorageCasQuery,
  type GuangYaCredentialSnapshot,
} from "@media-track/workflow";

export type { ConnectedStorageCasQuery, GuangYaCredentialSnapshot } from "@media-track/workflow";

let scanStore: PostgresScanStore | null = null;
const scanners = new Map<string, LibraryScanner>();
const scannerCredentialFingerprints = new Map<string, string>();
const DIRECTORY_TICKET_TTL_MS = 10 * 60_000;
const runtimeGlobals = globalThis as typeof globalThis & { __libraryDirectoryTicketKey?: Buffer };
const directoryTicketKey = runtimeGlobals.__libraryDirectoryTicketKey ?? (runtimeGlobals.__libraryDirectoryTicketKey = randomBytes(32));

export function getLibraryPool() {
  return getLibraryDatabasePool();
}

const REGISTERED_STORAGE_PROVIDERS = STORAGE_BRANDS.map(({ provider }) => provider);

/** Resolves an account-owned registered drive for historical PG reads only. */
export async function getLibraryReadServices(scope: ScanScope, pool?: Pool): Promise<{ pool: Pool; scanStore: PostgresScanStore }> {
  requireScope(scope);
  const pg = pool ?? getLibraryPool();
  const result = await pg.query<{ id: string }>(
    "SELECT id FROM connected_storages WHERE id=$1 AND account_id=$2 AND provider=ANY($3::text[])",
    [scope.connectedStorageId, scope.accountId, REGISTERED_STORAGE_PROVIDERS],
  );
  if (!result.rows[0]) throw new LibraryRuntimeError("storage_not_found", "找不到该账号的网盘连接。");
  return { pool: pg, scanStore: new PostgresScanStore(pg) };
}

function requireScope(scope: ScanScope): void {
  if (!scope.accountId.trim() || !scope.connectedStorageId.trim()) throw new LibraryRuntimeError("storage_not_found", "请先选择有效的网盘连接。");
}

export class LibraryRuntimeError extends Error {
  readonly code: "storage_not_found" | "storage_frozen" | "storage_credentials_invalid";
  constructor(code: LibraryRuntimeError["code"], message: string) { super(message); this.name = "LibraryRuntimeError"; this.code = code; }
}

function credentials(storage: ConnectedStorage): { accessToken: string; refreshToken: string; deviceId: string } {
  const payload = storage.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new LibraryRuntimeError("storage_credentials_invalid", "光鸭连接凭证不可用，请重新绑定。");
  const candidate = payload as Record<string, unknown>;
  const accessToken = typeof candidate.accessToken === "string" ? candidate.accessToken : typeof candidate.access_token === "string" ? candidate.access_token : "";
  const refreshToken = typeof candidate.refreshToken === "string" ? candidate.refreshToken : typeof candidate.refresh_token === "string" ? candidate.refresh_token : "";
  const deviceId = typeof candidate.deviceId === "string" ? candidate.deviceId : typeof candidate.device_id === "string" ? candidate.device_id : "";
  if (!accessToken || !refreshToken) throw new LibraryRuntimeError("storage_credentials_invalid", "光鸭连接凭证不可用，请重新绑定。");
  return { accessToken, refreshToken, deviceId };
}

function connectionMarker(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const meta = (payload as Record<string, unknown>).meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return "";
  const connectedAt = (meta as Record<string, unknown>).connectedAt;
  return typeof connectedAt === "string" ? connectedAt.trim() : "";
}

async function resolveStorage(scope: ScanScope): Promise<{ storage: ConnectedStorage; uid: string }> {
  requireScope(scope);
  const storage = (await getWorkflowRepository().listConnectedStorages(scope.accountId)).find((row) => row.id === scope.connectedStorageId);
  if (!storage || storage.accountId !== scope.accountId || !isRegisteredStorageProvider(storage.provider)) {
    throw new LibraryRuntimeError("storage_not_found", "找不到该账号的网盘连接。");
  }
  if (storage.status !== "active") throw new LibraryRuntimeError("storage_frozen", "该网盘连接已冻结，请重新绑定后再试。");
  let uid = storage.providerUid.trim();
  if (storage.provider === "guangya") {
    const creds = credentials(storage);
    uid ||= parseGuangYaUid(creds.accessToken)?.trim() || creds.deviceId.trim();
    if (!uid) throw new LibraryRuntimeError("storage_credentials_invalid", "光鸭连接身份信息不可用，请重新绑定。");
  }
  return { storage, uid };
}

/** Persists refreshes only while the active row still has this client's latest credentials. */
export function createGuangYaTokenPersister(query: ConnectedStorageCasQuery, snapshot: GuangYaCredentialSnapshot) {
  const persist = createWorkflowGuangYaTokenPersister(query, snapshot);
  return async (tokens: { accessToken: string; refreshToken: string; deviceId: string }): Promise<void> => {
    await persist(tokens);
  };
}

export async function getLibraryGuangYaClient(accountId: string, connectedStorageId: string): Promise<{ client: GuangYaClient; providerUid: string }> {
  const scope = { accountId, connectedStorageId };
  const { storage, uid } = await resolveStorage(scope);
  if (storage.provider !== "guangya") throw new LibraryRuntimeError("storage_not_found", "找不到该账号的光鸭连接。");
  const creds = credentials(storage);
  const accountKey = `guangya:${uid}`;
  const authHooks = createGuangYaAuthHooks({
    accountId,
    connectedStorageId,
    providerUid: uid,
    credentials: creds,
    connectionMarker: connectionMarker(storage.payload),
  });
  const scheduler = createGuangYaRequestScheduler({ accountKey, minIntervalMs: getGuangYaMinIntervalMs() });
  const client = new GuangYaClient({
    ...authHooks.credentials,
    requestScheduler: scheduler,
    authCoordinator: getGuangYaAuthCoordinator(),
    authAccountKey: authHooks.accountKey,
    loadCurrentCredentials: authHooks.loadCurrentCredentials,
    onTokensRefreshed: authHooks.onTokensRefreshed,
  });
  return { client, providerUid: uid };
}

export async function getLibraryServices(scope: ScanScope): Promise<{
  pool: Pool; scanStore: PostgresScanStore; scanner: LibraryScanner; reader: DirectoryReader; client: GuangYaClient | null;
  storage: Pick<ConnectedStorage, "id" | "accountId" | "provider" | "providerUid" | "label" | "status" | "moviesCid" | "tvCid">;
}> {
  const { storage } = await resolveStorage(scope);
  const pg = getLibraryPool();
  const store = scanStore ?? (scanStore = new PostgresScanStore(pg));
  const key = `${scope.accountId}\0${scope.connectedStorageId}`;
  const fingerprint = createHmac("sha256", directoryTicketKey)
    .update(`${storage.provider}\0${JSON.stringify(storage.payload)}\0${storage.providerUid}\0${storage.status}`)
    .digest("hex");
  const reader = createLibraryDirectoryReader(scope, storage.provider);
  let scanner = scanners.get(key);
  if (!scanner || scannerCredentialFingerprints.get(key) !== fingerprint) {
    scanner = new LibraryScanner({ store, reader });
    scanners.set(key, scanner);
    scannerCredentialFingerprints.set(key, fingerprint);
  }
  const client = storage.provider === "guangya"
    ? (await getLibraryGuangYaClient(scope.accountId, scope.connectedStorageId)).client
    : null;
  return { pool: pg, scanStore: store, scanner, reader, client, storage: { id: storage.id, accountId: storage.accountId, provider: storage.provider, providerUid: storage.providerUid, label: storage.label, status: storage.status, moviesCid: storage.moviesCid, tvCid: storage.tvCid } };
}

function createLibraryDirectoryReader(scope: ScanScope, provider: string): DirectoryReader {
  if (!isRegisteredStorageProvider(provider)) throw new LibraryRuntimeError("storage_not_found", "网盘品牌不受支持。");
  if (getStorageBrand(provider).provider === "guangya") {
    return {
      async listPage(input) {
        // Re-resolve on every remote page so freeze or rebind cannot reuse a stale client.
        const { client } = await getLibraryGuangYaClient(scope.accountId, scope.connectedStorageId);
        return createGuangYaDirectoryReader(client).listPage(input);
      },
    };
  }
  return {
    async listPage(input) {
      await resolveStorage(scope);
      const executor = await getLibraryStorageExecutor(scope.accountId, scope.connectedStorageId);
      return createStorageDirectoryReader(executor).listPage(input);
    },
  };
}

export interface DirectorySelectionTicket {
  accountId: string;
  connectedStorageId: string;
  directoryId: string;
  parentId: string;
  name: string;
  page: number;
  cursor?: string;
  expiresAt: number;
}

export function issueDirectorySelectionTicket(input: Omit<DirectorySelectionTicket, "expiresAt">, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...input, expiresAt: now + DIRECTORY_TICKET_TTL_MS }), "utf8").toString("base64url");
  const signature = createHmac("sha256", directoryTicketKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyDirectorySelectionTicket(ticket: string, scope: ScanScope, now = Date.now()): DirectorySelectionTicket | null {
  if (ticket.length > 4096) return null;
  const [payload, signature, extra] = ticket.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", directoryTicketKey).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); } catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || supplied.toString("base64url") !== signature) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<DirectorySelectionTicket>;
    if (decoded.accountId !== scope.accountId || decoded.connectedStorageId !== scope.connectedStorageId ||
        typeof decoded.directoryId !== "string" || !decoded.directoryId || typeof decoded.parentId !== "string" ||
        typeof decoded.name !== "string" || !decoded.name || !Number.isSafeInteger(decoded.page) || (decoded.page ?? -1) < 0 ||
        (decoded.cursor !== undefined && (typeof decoded.cursor !== "string" || !decoded.cursor || decoded.cursor.length > 4096)) ||
        !Number.isSafeInteger(decoded.expiresAt) || (decoded.expiresAt ?? 0) <= now) return null;
    return decoded as DirectorySelectionTicket;
  } catch { return null; }
}
