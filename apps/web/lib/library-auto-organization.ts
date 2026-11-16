import {
  LibraryAutoOrganizationScheduler,
  PostgresOrganizationStore,
  PostgresAutoOrganizationStore,
  type AutoOrganizationExecutionPort,
  type AutoOrganizationPlanState,
  type AutoOrganizationSchedulerOptions,
  type OrganizationScope,
} from "@media-track/workflow/library";
import { getLibraryPool, getLibraryReadServices } from "./library-runtime";
import { getLibraryOrganizationService } from "./library-organization-runtime";

const readOrganizationStores = new WeakMap<object, PostgresOrganizationStore>();

/**
 * F08f production adapter. It only reads plan state and registers execution intent through F08c;
 * preview/authorization/write locks/read-back remain inside F08c and are never reimplemented here.
 */
export class LibraryAutoOrganizationExecutionPort implements AutoOrganizationExecutionPort {
  async preview(scope: OrganizationScope, taskId: string, fileIds: readonly string[], _now: string): Promise<{ operationKey: string }> {
    const service = await getLibraryOrganizationService(scope.accountId, scope.connectedStorageId);
    const plan = await service.preview(taskId, { fileIds });
    return { operationKey: plan.operationKey };
  }

  async getPlan(scope: OrganizationScope, taskId: string, operationKey: string): Promise<AutoOrganizationPlanState | null> {
    // Historical plan status stays readable when credentials are frozen; no storage client is built.
    // Account ownership is still verified on every call, while the schema-ready store is reused per
    // pool so repeated ticks do not run the DDL advisory lock again.
    const { pool } = await getLibraryReadServices(scope);
    let store = readOrganizationStores.get(pool);
    if (!store) {
      store = new PostgresOrganizationStore(pool);
      readOrganizationStores.set(pool, store);
    }
    const plan = await store.get(scope, taskId, operationKey);
    return plan ? { status: plan.status, executeRequested: plan.executeRequested === true } : null;
  }

  async requestExecution(scope: OrganizationScope, taskId: string, operationKey: string, now: string, authorization: { batchId: string; leaseId: string }): Promise<boolean> {
    const service = await getLibraryOrganizationService(scope.accountId, scope.connectedStorageId);
    return service.store.requestExecution(service.scope, taskId, operationKey, now, { autoOrganization: authorization });
  }
}

let scheduler: LibraryAutoOrganizationScheduler | null = null;

export function createLibraryAutoOrganizationScheduler(overrides: Partial<Omit<AutoOrganizationSchedulerOptions, "store" | "execution">> = {}): LibraryAutoOrganizationScheduler {
  return new LibraryAutoOrganizationScheduler({
    store: new PostgresAutoOrganizationStore(getLibraryPool()),
    execution: new LibraryAutoOrganizationExecutionPort(),
    ...overrides,
  });
}

export function getLibraryAutoOrganizationScheduler(): LibraryAutoOrganizationScheduler {
  scheduler ??= createLibraryAutoOrganizationScheduler();
  return scheduler;
}
