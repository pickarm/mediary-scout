import { Pool } from "pg";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  PostgresScanStore,
  LibraryScanner,
  createGuangYaDirectoryReader,
  createGuangYaRequestScheduler,
  getGuangYaMinIntervalMs,
  type DirectoryReader,
  type ScanScope,
} from "@media-track/workflow/library";
import { GuangYaClient, parseGuangYaUid, type ConnectedStorage } from "@media-track/workflow";
import { getWorkflowRepository, postgresConnectionString } from "./workflow-runtime";

let pool: Pool | null = null;
let scanStore: PostgresScanStore | null = null;
const scanners = new Map<string, LibraryScanner>();
const scannerCredentialFingerprints = new Map<string, string>();
const DIRECTORY_TICKET_TTL_MS = 10 * 60_000;
const runtimeGlobals = globalThis as typeof globalThis & { __libraryDirectoryTicketKey?: Buffer };
const directoryTicketKey = runtimeGlobals.__libraryDirectoryTicketKey ?? (runtimeGlobals.__libraryDirectoryTicketKey = randomBytes(32));

export function getLibraryPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: postgresConnectionString(), max: 4, application_name: "mediary-library-api" });
  return pool;
}

function requireScope(scope: ScanScope): void {
  if (!scope.accountId.trim() || !scope.connectedStorageId.trim()) throw new LibraryRuntimeError("storage_not_found", "请先选择有效的光鸭网盘连接。");
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

async function resolveStorage(scope: ScanScope): Promise<{ storage: ConnectedStorage; uid: string }> {
  requireScope(scope);
  const storage = (await getWorkflowRepository().listConnectedStorages(scope.accountId)).find((row) => row.id === scope.connectedStorageId);
  if (!storage || storage.accountId !== scope.accountId || storage.provider !== "guangya") throw new LibraryRuntimeError("storage_not_found", "找不到该账号的光鸭连接。");
  if (storage.status !== "active") throw new LibraryRuntimeError("storage_frozen", "该光鸭连接已冻结，请重新绑定后再试。");
  const creds = credentials(storage);
  const uid = storage.providerUid || parseGuangYaUid(creds.accessToken) || creds.deviceId;
  if (!uid) throw new LibraryRuntimeError("storage_credentials_invalid", "光鸭连接身份信息不可用，请重新绑定。");
  return { storage, uid };
}

export interface GuangYaCredentialSnapshot {
  accountId: string;
  connectedStorageId: string;
  providerUid: string;
  credentials: { accessToken: string; refreshToken: string; deviceId: string };
}

export type ConnectedStorageCasQuery = (sql: string, values: readonly unknown[]) => Promise<{ rowCount: number | null }>;

/** Persists refreshes only while the active row still has this client's latest credentials. */
export function createGuangYaTokenPersister(query: ConnectedStorageCasQuery, snapshot: GuangYaCredentialSnapshot) {
  let expected = { ...snapshot.credentials };
  return async (tokens: { accessToken: string; refreshToken: string; deviceId: string }): Promise<void> => {
    const result = await query(
      "UPDATE connected_storages SET payload = (payload - 'access_token' - 'refresh_token' - 'device_id') || " +
        "jsonb_build_object('accessToken',$7::text,'refreshToken',$8::text,'deviceId',$9::text) " +
        "WHERE id=$1 AND account_id=$2 AND provider='guangya' AND provider_uid=$3 AND status='active' " +
        "AND COALESCE(payload->>'accessToken',payload->>'access_token','')=$4 " +
        "AND COALESCE(payload->>'refreshToken',payload->>'refresh_token','')=$5 " +
        "AND COALESCE(payload->>'deviceId',payload->>'device_id','')=$6",
      [snapshot.connectedStorageId, snapshot.accountId, snapshot.providerUid, expected.accessToken, expected.refreshToken,
        expected.deviceId, tokens.accessToken, tokens.refreshToken, tokens.deviceId],
    );
    if (result.rowCount === 1) expected = { ...tokens };
  };
}

function tokenPersister(accountId: string, storage: ConnectedStorage, creds: { accessToken: string; refreshToken: string; deviceId: string }) {
  const persist = createGuangYaTokenPersister((sql, values) => getLibraryPool().query(sql, [...values]), {
    accountId,
    connectedStorageId: storage.id,
    providerUid: storage.providerUid,
    credentials: creds,
  });
  return async (tokens: { accessToken: string; refreshToken: string; deviceId: string }): Promise<void> => {
    try { await persist(tokens); }
    catch { /* Refresh persistence is best-effort; never return credential details. */ }
  };
}

export async function getLibraryGuangYaClient(accountId: string, connectedStorageId: string): Promise<{ client: GuangYaClient; providerUid: string }> {
  const scope = { accountId, connectedStorageId };
  const { storage, uid } = await resolveStorage(scope);
  const creds = credentials(storage);
  const scheduler = createGuangYaRequestScheduler({ accountKey: `guangya:${uid}`, minIntervalMs: getGuangYaMinIntervalMs() });
  const client = new GuangYaClient({ ...creds, requestScheduler: scheduler, onTokensRefreshed: tokenPersister(accountId, storage, creds) });
  return { client, providerUid: uid };
}

export async function getLibraryServices(scope: ScanScope): Promise<{
  pool: Pool; scanStore: PostgresScanStore; scanner: LibraryScanner; client: GuangYaClient;
  storage: Pick<ConnectedStorage, "id" | "accountId" | "provider" | "providerUid" | "label" | "status">;
}> {
  const { storage } = await resolveStorage(scope);
  const { client } = await getLibraryGuangYaClient(scope.accountId, scope.connectedStorageId);
  const pg = getLibraryPool();
  const store = scanStore ?? (scanStore = new PostgresScanStore(pg));
  const key = `${scope.accountId}\0${scope.connectedStorageId}`;
  const payload = storage.payload as Record<string, unknown>;
  const fingerprint = createHmac("sha256", directoryTicketKey).update(`${String(payload.accessToken ?? payload.access_token)}\0${String(payload.refreshToken ?? payload.refresh_token)}\0${String(payload.deviceId ?? payload.device_id)}`).digest("hex");
  let scanner = scanners.get(key);
  if (!scanner || scannerCredentialFingerprints.get(key) !== fingerprint) {
    const reader: DirectoryReader = {
      async listPage(input) {
        // Long-running scans revalidate the account, provider and active credentials
        // before every remote page so a freeze or rebind cannot keep using a stale client.
        const { client: currentClient } = await getLibraryGuangYaClient(scope.accountId, scope.connectedStorageId);
        return createGuangYaDirectoryReader(currentClient).listPage(input);
      },
    };
    scanner = new LibraryScanner({ store, reader });
    scanners.set(key, scanner);
    scannerCredentialFingerprints.set(key, fingerprint);
  }
  return { pool: pg, scanStore: store, scanner, client, storage: { id: storage.id, accountId: storage.accountId, provider: storage.provider, providerUid: storage.providerUid, label: storage.label, status: storage.status } };
}

export interface DirectorySelectionTicket {
  accountId: string;
  connectedStorageId: string;
  directoryId: string;
  parentId: string;
  name: string;
  page: number;
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
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<DirectorySelectionTicket>;
    if (decoded.accountId !== scope.accountId || decoded.connectedStorageId !== scope.connectedStorageId ||
        typeof decoded.directoryId !== "string" || !decoded.directoryId || typeof decoded.parentId !== "string" ||
        typeof decoded.name !== "string" || !decoded.name || !Number.isSafeInteger(decoded.page) || (decoded.page ?? -1) < 0 ||
        !Number.isSafeInteger(decoded.expiresAt) || (decoded.expiresAt ?? 0) <= now) return null;
    return decoded as DirectorySelectionTicket;
  } catch { return null; }
}
