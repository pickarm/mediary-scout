import { isDemoMode } from "./demo-mode";
import { getLibraryPool } from "./library-runtime";
import { getLibraryOrganizationService } from "./library-organization-runtime";
import { isUpdateHoldActive, whileInFlight } from "./update-hold";
import { STORAGE_BRANDS } from "@media-track/workflow";

const POLL_MS=boundedEnv("MEDIA_TRACK_LIBRARY_ORGANIZATION_WORKER_POLL_MS",3_000,1_000,60_000);
const MAX_SCOPES_PER_TICK=4;
const REGISTERED_STORAGE_PROVIDERS=STORAGE_BRANDS.map(({provider})=>provider);
let started=false;
let ticking=false;
let cursor: {accountId:string;connectedStorageId:string}|null=null;
let triggerImmediateTick: (() => void) | null = null;

/** 重试失败整理计划后立即唤醒一轮执行调度，无需等待下一轮 3 秒轮询。 */
export function wakeLibraryOrganizationWorker(): void {
  triggerImmediateTick?.();
}

/** Drains only explicit persisted execute intents; preview records never enter this query. */
export function startLibraryOrganizationWorker(): void {
  if (started || process.env.MEDIA_TRACK_INPROCESS_WORKER==="0" || process.env.MEDIA_TRACK_REHEARSAL==="1" || isDemoMode()) return;
  started=true;
  const tick=async()=>{
    if (ticking || isUpdateHoldActive(Date.now())) return;
    ticking=true;
    try {
      await whileInFlight(async()=>{
        if (isUpdateHoldActive(Date.now())) return;
        const scopes=await queryRunnableScopes(cursor,MAX_SCOPES_PER_TICK);
        if (!scopes.length && cursor) { cursor=null; return; }
        for (const scope of scopes) {
          if (isUpdateHoldActive(Date.now())) break;
          cursor=scope;
          try { await (await getLibraryOrganizationService(scope.accountId,scope.connectedStorageId)).drainRequested(1); }
          catch(error) { console.error(`[library-organization-worker] drain failed for storage ${scope.connectedStorageId}: ${safeError(error)}`); }
        }
      });
    } catch(error) { console.error(`[library-organization-worker] tick failed: ${safeError(error)}`); }
    finally { ticking=false; }
  };
  triggerImmediateTick = () => {
    void tick();
  };
  console.log(`[library-organization-worker] started (poll ${POLL_MS}ms)`);
  void tick(); setInterval(()=>{void tick();},POLL_MS);
}

interface ScopeRow {account_id:string;connected_storage_id:string}
async function queryRunnableScopes(after:{accountId:string;connectedStorageId:string}|null,limit:number):Promise<Array<{accountId:string;connectedStorageId:string}>> {
  const pool=getLibraryPool();
  const cursorSql=after?"AND (s.account_id,s.id)>($1,$2)":"";
  const providerIndex=after?3:1;
  const limitIndex=providerIndex+1;
  const params=after?[after.accountId,after.connectedStorageId,REGISTERED_STORAGE_PROVIDERS,limit]:[REGISTERED_STORAGE_PROVIDERS,limit];
  const result=await pool.query<ScopeRow>(
    `SELECT s.account_id,s.id AS connected_storage_id FROM connected_storages s
      WHERE s.provider=ANY($${providerIndex}::text[]) AND s.status='active' ${cursorSql}
        AND (EXISTS(SELECT 1 FROM library_organization_plans p WHERE p.account_id=s.account_id AND p.connected_storage_id=s.id
          AND p.execute_requested=true AND p.status IN ('planned','paused','failed','running') AND (p.lease_id IS NULL OR p.lease_expires_at<=now()))
          OR EXISTS(SELECT 1 FROM library_organization_operations o JOIN library_file_bindings b
            ON b.account_id=o.account_id AND b.connected_storage_id=o.connected_storage_id AND b.file_id=o.file_id
            WHERE o.account_id=s.account_id AND o.connected_storage_id=s.id AND o.status='verified'
              AND o.target_parent_id IS NOT NULL AND b.parent_directory_id<>o.target_parent_id))
      ORDER BY s.account_id,s.id LIMIT $${limitIndex}`,
    params,
  );
  return result.rows.map((row)=>({accountId:row.account_id,connectedStorageId:row.connected_storage_id}));
}
function boundedEnv(name:string,fallback:number,min:number,max:number):number { const raw=process.env[name]; if(!raw)return fallback; const value=Number(raw); return Number.isSafeInteger(value)&&value>=min&&value<=max?value:fallback; }
function safeError(error:unknown):string {return error instanceof Error?error.message.slice(0,300):"unknown error";}
