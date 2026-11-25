import { createHash } from "node:crypto";
import { isRegisteredStorageProvider, parseGuangYaUid, type ConnectedStorage } from "@media-track/workflow";
import {
  buildOrganizationPlan,
  createStorageOrganizationStorage,
  getGuangYaWriteCoordinator,
  LibraryOrganizer,
  PostgresOrganizationStore,
  PostgresLibraryStore,
  type OrganizationPlan,
  type OrganizationScope,
  type OrganizationStorage,
} from "@media-track/workflow/library";
import { getLibraryPool } from "./library-runtime";
import { getLibraryStorageExecutor, getWorkflowRepository } from "./workflow-runtime";
import { createGuangYaAuthHooks } from "./guangya-auth-runtime";
import { isDemoMode } from "./demo-mode";

const DEFAULT_PREVIEW_FILES = 50;
const MAX_EXECUTE_OPERATIONS = 20;

export class LibraryOrganizationRuntimeError extends Error {
  constructor(readonly code: "storage_not_found" | "storage_frozen" | "credentials_invalid" | "organization_conflict", message: string) { super(message); this.name = "LibraryOrganizationRuntimeError"; }
}

export interface PreviewOrganizationInput {
  fileIds?: readonly string[];
  afterFileId?: string;
  limit?: number;
}

interface OrganizationRuntimeOptions {
  storageFactory: (authorizedRoots: readonly string[]) => Promise<OrganizationStorage>;
}

export class OrganizationRuntimeService {
  readonly store: PostgresOrganizationStore;
  private readonly libraryStore: PostgresLibraryStore;

  constructor(
    readonly scope: OrganizationScope,
    private readonly options: OrganizationRuntimeOptions,
    pool = getLibraryPool(),
    private readonly accountKey: string | null = null,
    private readonly coordinator: ReturnType<typeof getGuangYaWriteCoordinator> | null = null,
  ) {
    this.store = new PostgresOrganizationStore(pool);
    this.libraryStore = new PostgresLibraryStore(pool);
  }

  async preview(taskId: string, selection: PreviewOrganizationInput = {}): Promise<OrganizationPlan> {
    const limit = selection.limit ?? DEFAULT_PREVIEW_FILES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("预览文件批次必须为1至100");
    const provisional = await this.store.derivePlanInput(this.scope,taskId,{...selection,limit,operationKey:"pending"});
    const authorized = await this.store.authorizePlan(provisional);
    const digest = createHash("sha256").update(JSON.stringify({
      scope:this.scope,taskId,sourceRoots:authorized.sourceRoots,targetRoots:authorized.targetRoots,
      templates:authorized.templates,files:authorized.confirmedFiles.map(({fileId,identity}) => ({fileId,identity})),
      skips:authorized.preSkippedFiles,selection:{afterFileId:selection.afterFileId ?? null,limit:selection.fileIds ? null : limit},
    })).digest("hex").slice(0,40);
    const operationKey = `org_${digest}`;
    const candidate=buildOrganizationPlan({...authorized,operationKey});
    if(candidate.operations.length>200) throw new LibraryOrganizationRuntimeError("organization_conflict","该批次会生成超过200个网盘操作，请缩小文件选择后重新预览。");
    const storage = await this.storageFor(authorized.sourceRoots, authorized.targetRoots);
    return new LibraryOrganizer({ store: this.store, storage }).plan({...authorized,operationKey});
  }

  async executeSlice(taskId: string, operationKey: string): Promise<OrganizationPlan> {
    if (process.env.MEDIA_TRACK_REHEARSAL === "1") throw new LibraryOrganizationRuntimeError("organization_conflict","演练模式禁止真实网盘写入。");
    return this.withWriteFence(async () => {
      const existing = await this.store.get(this.scope, taskId, operationKey);
      if (!existing) throw new LibraryOrganizationRuntimeError("organization_conflict","整理清单不存在。");
      await this.store.authorizeExecution(existing);
      const storage = await this.storageFor(existing.sourceRootIds, existing.targetRootIds);
      const organizer = new LibraryOrganizer({ store: this.store, storage });
      const plan = await organizer.execute(this.scope,taskId,operationKey,{maxOperations:MAX_EXECUTE_OPERATIONS});
      await this.assertWriteFence();
      await this.syncVerifiedLocations(plan.plan, storage);
      return (await this.store.get(this.scope,taskId,operationKey)) ?? plan.plan;
    });
  }

  async drainRequested(limit = 1): Promise<number> {
    await this.recoverVerifiedBindings(1);
    const requested = await this.store.listRequested(this.scope,Math.min(20,Math.max(1,limit)));
    let processed = 0;
    for (const item of requested) {
      const plan = await this.executeSlice(item.taskId,item.operationKey);
      processed += 1;
      if (plan.status === "completed" || !plan.executeRequested) continue;
    }
    return processed;
  }

  async recoverVerifiedBindings(limit = 1): Promise<number> {
    const keys=await this.store.listVerifiedLocationPlanKeys(this.scope,Math.min(20,Math.max(1,limit)));
    let recovered=0;
    for (const key of keys) {
      await this.withWriteFence(async()=>{
        const plan=await this.store.get(this.scope,key.taskId,key.operationKey);
        if (plan) {
          await this.store.authorizeExecution(plan);
          const storage = await this.storageFor(plan.sourceRootIds, plan.targetRootIds);
          await this.syncVerifiedLocations(plan, storage);
        }
        await this.assertWriteFence();
      });
      recovered+=1;
    }
    return recovered;
  }

  private async syncVerifiedLocations(plan: OrganizationPlan, storage: OrganizationStorage): Promise<void> {
    const pending=await this.store.listVerifiedLocationsToSync(this.scope,plan.taskId,plan.operationKey,200);
    for (const operation of pending) {
      const current=await storage.read(operation.fileId,[operation.parentId]);
      if (!current || current.fileId!==operation.fileId || current.parentId!==operation.parentId || current.name!==operation.name || current.isDirectory) continue;
      const parentOfTargetDirectoryId=await this.resolveTargetDirectoryParent(storage,operation.targetRootId,operation.relativePath,operation.parentId);
      await this.libraryStore.updateVerifiedOrganizationLocation({
        accountId:this.scope.accountId,connectedStorageId:this.scope.connectedStorageId,taskId:plan.taskId,
        operationKey:plan.operationKey,fileId:operation.fileId,parentDirectoryId:operation.parentId,name:operation.name,
        ...(parentOfTargetDirectoryId!==undefined?{parentOfTargetDirectoryId}:{}),
      });
    }
  }

  private async resolveTargetDirectoryParent(storage: OrganizationStorage,targetRootId:string,relativePath:string,targetParentId:string):Promise<string|undefined> {
    const segments=relativePath.split("/").slice(0,-1);
    let parent=targetRootId;
    if (!segments.length) return undefined;
    for (const name of segments) {
      const matches=(await storage.list(parent)).filter((item)=>item.name===name&&item.isDirectory&&item.parentId===parent);
      if (matches.length!==1) return undefined;
      const directory=matches[0]!;
      if (directory.fileId===targetParentId) return parent;
      parent=directory.fileId;
    }
    return undefined;
  }

  private async storageFor(sourceRoots: readonly string[], targetRoots: readonly string[]): Promise<OrganizationStorage> {
    return this.options.storageFactory([...new Set([...sourceRoots, ...targetRoots])]);
  }

  private async withWriteFence<T>(run: () => Promise<T>): Promise<T> {
    if (!this.accountKey || !this.coordinator) return run();
    return this.coordinator.run([this.accountKey], async () => {
      await this.assertWriteFence();
      const result = await run();
      await this.assertWriteFence();
      return result;
    });
  }

  private async assertWriteFence(): Promise<void> {
    if (this.accountKey && this.coordinator) await this.coordinator.assertHeld(this.accountKey);
  }
}

export async function getLibraryOrganizationService(accountId: string, connectedStorageId: string): Promise<OrganizationRuntimeService> {
  if (isDemoMode()) throw new LibraryOrganizationRuntimeError("storage_not_found","演示模式不提供真实网盘整理操作");
  if (!accountId.trim() || !connectedStorageId.trim()) throw new LibraryOrganizationRuntimeError("storage_not_found","请先选择有效的网盘连接。");
  const scope = {accountId,connectedStorageId};
  const storage = (await getWorkflowRepository().listConnectedStorages(accountId)).find((row) => row.id === connectedStorageId);
  if (!storage || storage.accountId !== accountId || !isRegisteredStorageProvider(storage.provider)) {
    throw new LibraryOrganizationRuntimeError("storage_not_found","找不到该账号的网盘连接。");
  }
  if (storage.status !== "active") throw new LibraryOrganizationRuntimeError("storage_frozen","该网盘连接已冻结，请重新绑定后再试。");

  let accountKey: string | null = null;
  let coordinator: ReturnType<typeof getGuangYaWriteCoordinator> | null = null;
  let guangyaAuth: ReturnType<typeof createGuangYaAuthHooks> | null = null;
  if (storage.provider === "guangya") {
    const creds = credentials(storage);
    const providerUid = storage.providerUid.trim() || parseGuangYaUid(creds.accessToken)?.trim() || creds.deviceId.trim();
    if (!providerUid) throw new LibraryOrganizationRuntimeError("credentials_invalid","光鸭连接身份信息不可用，请重新绑定。");
    guangyaAuth = createGuangYaAuthHooks({accountId,connectedStorageId,providerUid,credentials:creds,rawCredentialDeviceId:creds.deviceId,connectionMarker:connectionMarker(storage.payload)});
    accountKey = `guangya:${providerUid}`;
    coordinator = getGuangYaWriteCoordinator();
  }

  const auth = guangyaAuth;
  const fence = coordinator;
  const storageFactory = async (authorizedRoots: readonly string[]): Promise<OrganizationStorage> => {
    const executor = await getLibraryStorageExecutor(accountId, connectedStorageId, authorizedRoots);
    const organizationStorage = createStorageOrganizationStorage(executor);
    if (!auth || !accountKey || !fence) return organizationStorage;
    return checkedGuangYaStorage(organizationStorage, async () => {
      await fence.assertHeld(accountKey);
      if (!(await auth.loadCurrentCredentials())) {
        throw new LibraryOrganizationRuntimeError("storage_frozen","光鸭连接已冻结或凭证已变更，整理已停止。");
      }
      await fence.assertHeld(accountKey);
    });
  };
  return new OrganizationRuntimeService(scope,{storageFactory},getLibraryPool(),accountKey,coordinator);
}

function checkedGuangYaStorage(storage: OrganizationStorage, beforeWrite: () => Promise<void>): OrganizationStorage {
  return {
    list: (parentId) => storage.list(parentId),
    read: (fileId, knownParentIds) => storage.read(fileId, knownParentIds),
    async createDir(parentId, name) {
      await beforeWrite();
      return storage.createDir(parentId, name);
    },
    async rename(fileId, name) {
      await beforeWrite();
      await storage.rename(fileId, name);
    },
    async move(fileId, parentId) {
      await beforeWrite();
      await storage.move(fileId, parentId);
    },
  };
}

function credentials(storage: ConnectedStorage): {accessToken:string;refreshToken:string;deviceId:string} {
  if (!storage.payload || typeof storage.payload !== "object" || Array.isArray(storage.payload)) throw new LibraryOrganizationRuntimeError("credentials_invalid","光鸭连接凭证不可用，请重新绑定。");
  const value=storage.payload as Record<string,unknown>;
  const accessToken=read(value,"accessToken","access_token"); const refreshToken=read(value,"refreshToken","refresh_token");
  const deviceId=read(value,"deviceId","device_id");
  if (!accessToken || !refreshToken) throw new LibraryOrganizationRuntimeError("credentials_invalid","光鸭连接凭证不可用，请重新绑定。");
  return {accessToken,refreshToken,deviceId};
}
function read(value:Record<string,unknown>,camel:string,snake:string):string { return typeof value[camel]==="string"?String(value[camel]):typeof value[snake]==="string"?String(value[snake]):""; }
function connectionMarker(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const meta=(payload as Record<string,unknown>).meta;
  return meta && typeof meta === "object" && !Array.isArray(meta) && typeof (meta as Record<string,unknown>).connectedAt === "string" ? String((meta as Record<string,unknown>).connectedAt).trim() : "";
}
