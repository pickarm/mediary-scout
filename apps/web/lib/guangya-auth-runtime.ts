import {
  createGuangYaTokenPersister,
  getGuangYaAuthCoordinator,
  parseGuangYaUid,
  generateGuangYaDeviceId,
  type GuangYaTokens,
  type GuangYaCredentialSnapshot,
} from "@media-track/workflow";
import { getLibraryDatabasePool } from "./library-database";

export interface GuangYaAuthScope {
  accountId: string;
  connectedStorageId: string;
  providerUid: string;
  credentials: GuangYaTokens;
  /** Raw persisted Did; null preserves the legacy no-deviceId representation. */
  rawCredentialDeviceId?: string | null;
  connectionMarker: string;
  /** Permit a frozen row only for the explicit Test Connection probe. */
  allowFrozenForProbe?: boolean;
}

export interface GuangYaAuthRow {
  provider_uid: string | null;
  status: string;
  payload: unknown;
}

export type GuangYaAuthQuery = (
  sql: string,
  values: readonly unknown[],
) => Promise<{ rows: readonly GuangYaAuthRow[]; rowCount: number | null }>;

/** Freeze only the exact connection generation and credentials that failed an authenticated request. */
export async function freezeGuangYaStorageIfUnchanged(
  snapshot: GuangYaCredentialSnapshot,
  reason: string,
  query?: GuangYaAuthQuery,
): Promise<boolean> {
  const databaseQuery: GuangYaAuthQuery = query ?? ((sql, values) =>
    getLibraryDatabasePool().query(sql, [...values]));
  const result = await databaseQuery(
    "UPDATE connected_storages SET status='frozen', frozen_reason=$8, frozen_at=$9 " +
      "WHERE id=$1 AND account_id=$2 AND provider='guangya' AND provider_uid=$3 AND status=$10 " +
      "AND COALESCE(payload->>'accessToken',payload->>'access_token','')=$4 " +
      "AND COALESCE(payload->>'refreshToken',payload->>'refresh_token','')=$5 " +
      "AND COALESCE(payload->>'deviceId',payload->>'device_id') IS NOT DISTINCT FROM $6::text " +
      "AND COALESCE(payload->'meta'->>'connectedAt','')=$7",
    [snapshot.connectedStorageId, snapshot.accountId, snapshot.providerUid,
      snapshot.credentials.accessToken, snapshot.credentials.refreshToken, snapshot.credentials.deviceId,
      snapshot.connectionMarker ?? "", reason, new Date().toISOString(), snapshot.expectedStatus ?? "active"],
  );
  return result.rowCount === 1;
}

/** Bind a client to one exact active connection row and the shared account lock. */
export function createGuangYaAuthHooks(scope: GuangYaAuthScope, query?: GuangYaAuthQuery): {
  accountKey: string;
  credentials: GuangYaTokens;
  loadCurrentCredentials: () => Promise<{ tokens: GuangYaTokens; snapshot: GuangYaCredentialSnapshot } | null>;
  onTokensRefreshed: (tokens: GuangYaTokens, expected?: GuangYaCredentialSnapshot) => Promise<boolean>;
  reactivateIfUnchanged: () => Promise<boolean>;
} {
  const providerUid = scope.providerUid.trim();
  if (!providerUid) throw new Error("GUANGYA_PROVIDER_UID_REQUIRED");
  const runtimeDid = scope.credentials.deviceId.trim() || generateGuangYaDeviceId();
  const snapshot: GuangYaCredentialSnapshot = {
    ...scope,
    providerUid,
    credentials: { ...scope.credentials, deviceId: scope.rawCredentialDeviceId === undefined ? scope.credentials.deviceId : scope.rawCredentialDeviceId },
    connectionMarker: scope.connectionMarker.trim(),
  };
  const databaseQuery: GuangYaAuthQuery = query ?? ((sql, values) =>
    getLibraryDatabasePool().query(sql, [...values]));
  const persist = createGuangYaTokenPersister(async (sql, values) => ({
    rowCount: (await databaseQuery(sql, values)).rowCount,
  }), snapshot);
  let validatedProbeCredentials = { ...snapshot.credentials };

  return {
    accountKey: `guangya:${providerUid}`,
    credentials: { ...scope.credentials, deviceId: runtimeDid },
    async loadCurrentCredentials(): Promise<{ tokens: GuangYaTokens; snapshot: GuangYaCredentialSnapshot } | null> {
      const result = await databaseQuery(
        "SELECT provider_uid, status, payload FROM connected_storages " +
          "WHERE id=$1 AND account_id=$2 AND provider='guangya'",
        [snapshot.connectedStorageId, snapshot.accountId],
      );
      const row = result.rows[0];
      if (!row || (row.status !== "active" && !(scope.allowFrozenForProbe && row.status === "frozen"))) return null;
      const raw = readCredentials(row.payload);
      if (!raw) return null;
      if (scope.allowFrozenForProbe) validatedProbeCredentials = { ...raw };
      const marker = readConnectionMarker(row.payload);
      if (marker !== snapshot.connectionMarker) return null;
      const storedUid = typeof row.provider_uid === "string" ? row.provider_uid.trim() : "";
      const tokenUid = parseGuangYaUid(raw.accessToken);
      const currentUid = storedUid || tokenUid || raw.deviceId || runtimeDid;
      if (currentUid !== providerUid || (tokenUid && tokenUid !== providerUid)) return null;
      const currentSnapshot: GuangYaCredentialSnapshot = {
        ...snapshot,
        credentials: raw,
        connectionMarker: marker,
        expectedStatus: row.status === "frozen" ? "frozen" : "active",
      };
      return { tokens: { ...raw, deviceId: raw.deviceId?.trim() || runtimeDid }, snapshot: currentSnapshot };
    },
    async onTokensRefreshed(tokens, expected): Promise<boolean> {
      const saved = await persist(tokens, expected);
      if (saved) validatedProbeCredentials = { ...tokens };
      return saved;
    },
    async reactivateIfUnchanged(): Promise<boolean> {
      if (!scope.allowFrozenForProbe) return false;
      const result = await databaseQuery(
        "UPDATE connected_storages SET status='active', frozen_reason=NULL, frozen_at=NULL " +
        "WHERE id=$1 AND account_id=$2 AND provider='guangya' AND provider_uid=$3 " +
          "AND status IN ('active','frozen') AND COALESCE(payload->'meta'->>'connectedAt','')=$4 " +
          "AND COALESCE(payload->>'accessToken',payload->>'access_token','')=$5 " +
          "AND COALESCE(payload->>'refreshToken',payload->>'refresh_token','')=$6 " +
          "AND COALESCE(payload->>'deviceId',payload->>'device_id') IS NOT DISTINCT FROM $7::text",
        [snapshot.connectedStorageId, snapshot.accountId, providerUid, snapshot.connectionMarker,
          validatedProbeCredentials.accessToken, validatedProbeCredentials.refreshToken,
          validatedProbeCredentials.deviceId],
      );
      return result.rowCount === 1;
    },
  };
}

function readCredentials(payload: unknown): GuangYaCredentialSnapshot["credentials"] | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  const accessToken = text(value.accessToken) || text(value.access_token);
  const refreshToken = text(value.refreshToken) || text(value.refresh_token);
  const deviceId = typeof value.deviceId === "string" ? value.deviceId : typeof value.device_id === "string" ? value.device_id : null;
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken, deviceId };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readConnectionMarker(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "";
  const meta = (payload as Record<string, unknown>).meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return "";
  return text((meta as Record<string, unknown>).connectedAt);
}
