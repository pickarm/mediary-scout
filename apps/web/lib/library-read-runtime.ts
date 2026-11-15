import {
  PostgresIdentificationStore,
  PostgresLibraryStore,
  PostgresOrganizationStore,
  PostgresScanStore,
  listIdentificationResults,
  type ScanScope,
} from "@media-track/workflow/library";
import { getLibraryReadServices } from "./library-runtime";

export async function getLibraryReadOrganizationService(accountId: string, connectedStorageId: string): Promise<{
  scope: ScanScope;
  store: PostgresOrganizationStore;
}> {
  const scope = { accountId, connectedStorageId };
  const { pool } = await getLibraryReadServices(scope);
  return { scope, store: new PostgresOrganizationStore(pool) };
}

export async function getLibraryReadIdentificationService(scope: ScanScope) {
  const { pool, scanStore } = await getLibraryReadServices(scope);
  const identificationStore = new PostgresIdentificationStore(pool);
  const libraryStore = new PostgresLibraryStore(pool);
  return {
    list: (taskId: string, input: { limit: number; afterFileId?: string; status?: "confirmed" | "pending" | "ignored" | "failed" }) =>
      listIdentificationResults({ scope, taskId, input, scans: scanStore, identifications: identificationStore, library: libraryStore }),
  };
}
