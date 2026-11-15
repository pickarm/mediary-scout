export interface GuangYaCredentialSnapshot {
  accountId: string;
  connectedStorageId: string;
  providerUid: string;
  /** Raw persisted tuple. null deviceId represents legacy rows without Did. */
  credentials: { accessToken: string; refreshToken: string; deviceId: string | null };
  /** The connection generation from payload.meta.connectedAt. */
  connectionMarker?: string;
  /** Status observed with this snapshot. Frozen is allowed only for explicit probes. */
  expectedStatus?: "active" | "frozen";
}

export type ConnectedStorageCasQuery = (
  sql: string,
  values: readonly unknown[],
) => Promise<{ rowCount: number | null }>;

/**
 * Persist a refresh only if this connection row still has the exact
 * identity, connection marker, and credential tuple observed by the caller.
 * Returns false if the CAS lost to a rebind, unbind, or another refresh.
 */
export function createGuangYaTokenPersister(
  query: ConnectedStorageCasQuery,
  snapshot: GuangYaCredentialSnapshot,
): (tokens: { accessToken: string; refreshToken: string; deviceId: string }, expectedSnapshot?: GuangYaCredentialSnapshot) => Promise<boolean> {
  let expected = { ...snapshot };
  return async (tokens, observed = expected): Promise<boolean> => {
    const result = await query(
      "UPDATE connected_storages SET payload = (payload - 'access_token' - 'refresh_token' - 'device_id') || " +
        "jsonb_build_object('accessToken',$9::text,'refreshToken',$10::text,'deviceId',$11::text), " +
        "status=status " +
        "WHERE id=$1 AND account_id=$2 AND provider='guangya' AND provider_uid=$3 AND status=$8 " +
        "AND COALESCE(payload->>'accessToken',payload->>'access_token','')=$4 " +
        "AND COALESCE(payload->>'refreshToken',payload->>'refresh_token','')=$5 " +
        "AND COALESCE(payload->>'deviceId',payload->>'device_id') IS NOT DISTINCT FROM $6::text " +
        "AND COALESCE(payload->'meta'->>'connectedAt','')=$7",
      [observed.connectedStorageId, observed.accountId, observed.providerUid,
        observed.credentials.accessToken, observed.credentials.refreshToken,
        observed.credentials.deviceId, observed.connectionMarker ?? "", observed.expectedStatus ?? "active",
        tokens.accessToken, tokens.refreshToken, tokens.deviceId],
    );
    if (result.rowCount !== 1) return false;
    expected = { ...observed, credentials: { ...tokens } };
    return true;
  };
}
