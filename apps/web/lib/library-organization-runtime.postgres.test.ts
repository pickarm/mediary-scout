import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { getStorageBrand } from "@media-track/workflow";
import { DEFAULT_NAMING_TEMPLATES, PostgresLibraryStore, PostgresScanStore } from "@media-track/workflow/library";
import { OrganizationRuntimeService } from "./library-organization-runtime";

const adminURL=process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;

describe.skipIf(!adminURL)("F08c PostgreSQL runtime recovery with a fake cloud",()=>{
  it("previews without writes, executes under the account fence, and repairs a verified move after restart",async()=>{
    const dbName=`organization_runtime_${randomUUID().replaceAll("-","")}`;
    const adminPool=new Pool({connectionString:adminURL});
    let pool:Pool|null=null;
    const fence=new TestFence();
    const cloud=new FakeCloud(fence);
    const authorizedRootCalls:string[][]=[];
    try {
      await adminPool.query(`CREATE DATABASE ${dbName}`);
      const url=new URL(adminURL!); url.pathname=`/${dbName}`;
      pool=new Pool({connectionString:url.toString()});
      pool.on("error", () => {});
      const provider=getStorageBrand("quark").provider;
      const scanStore=new PostgresScanStore(pool); await scanStore.ensureSchema();
      await pool.query("INSERT INTO connected_storages(id,account_id,provider,provider_uid,payload,created_at) VALUES('drive','acct',$1,'uid','{}'::jsonb,'now')",[provider]);
      const scope={accountId:"acct",connectedStorageId:"drive"};
      const configuration={
        configId:"config",scope,sourceRoots:[{directoryId:"src",name:"Source"},{directoryId:"target",name:"Library"}],
        movieTargetDirectoryId:"target",tvTargetDirectoryId:"target",mediaKind:"mixed" as const,
        dailyScheduleEnabled:false,dailyScheduleTime:null,dailyScheduleTimezone:"Asia/Shanghai" as const,
        autoOrganize:false,autoAcquire:false as const,templates:DEFAULT_NAMING_TEMPLATES,
      };
      await scanStore.saveConfiguration(configuration);
      await scanStore.createTask({taskId:"task",scope,configuration,roots:configuration.sourceRoots,now:"2026-11-14T00:00:00.000Z"});
      expect(await scanStore.claimTask(scope,"task","scan-lease","2026-11-14T00:00:00.000Z","2026-11-14T00:02:00.000Z")).toBe(true);
      await pool.query("INSERT INTO library_scan_files(account_id,connected_storage_id,file_id,parent_directory_id,name,is_directory,path) VALUES('acct','drive','file','src','raw.mkv',false,'Source/raw.mkv')");
      await pool.query("INSERT INTO library_scan_task_files(account_id,connected_storage_id,task_id,file_id,parent_directory_id,name,is_directory,path) VALUES('acct','drive','task','file','src','raw.mkv',false,'Source/raw.mkv')");
      expect(await scanStore.finishTask({scope,taskId:"task",leaseId:"scan-lease",status:"completed",now:"2026-11-14T00:00:01.000Z"})).toBe(true);
      const title={id:"tmdb_movie_123",tmdbId:123,type:"movie" as const,title:"Film",originalTitle:"Film Original",year:2024,aliases:[]};
      const season={id:"tmdb_movie_123_movie",mediaTitleId:title.id,seasonNumber:1,status:"active" as const,qualityPreference:"",storageDirectoryId:"src",totalEpisodes:1,latestAiredEpisode:0,latestAiredSource:"unknown" as const};
      const libraryStore=new PostgresLibraryStore(pool);
      await libraryStore.importExistingMedia({accountId:"acct",connectedStorageId:"drive",title,season,episodes:[],files:[{fileId:"file",parentDirectoryId:"src",episodeCode:"S01E01"}],directories:[{directoryId:"src",parentDirectoryId:null}],now:"2026-11-14T00:00:02.000Z"});

      const service=new OrganizationRuntimeService(
        scope,
        { storageFactory: async (roots) => { authorizedRootCalls.push([...roots]); return cloud; } },
        pool,
        "quark:uid",
        fence,
      );
      const plan=await service.preview("task",{fileIds:["file"]});
      expect(cloud.writeCount).toBe(0);
      expect(plan.operations).toHaveLength(1);
      expect(authorizedRootCalls[0]).toEqual(["src","target"]);
      expect(await service.store.requestExecution(scope,"task",plan.operationKey,"2026-11-14T00:00:03.000Z")).toBe(true);
      const completed=await service.executeSlice("task",plan.operationKey);
      expect(completed.status).toBe("completed");
      expect(cloud.writeCount).toBe(3);
      expect(authorizedRootCalls[1]).toEqual(["src","target"]);
      expect((await libraryStore.listPhysicalFileBindings({accountId:"acct",connectedStorageId:"drive",limit:10})).find(({fileId})=>fileId==="file")?.parentDirectoryId).toBe("dir-1");

      // Simulate process exit after F06 persisted verified but before F02 sync.
      await pool.query("UPDATE library_file_bindings SET parent_directory_id='src' WHERE account_id='acct' AND connected_storage_id='drive' AND file_id='file'");
      expect(await service.store.listVerifiedLocationPlanKeys(scope,10)).toEqual([{taskId:"task",operationKey:plan.operationKey}]);
      expect(await service.recoverVerifiedBindings()).toBe(1);
      expect(authorizedRootCalls[2]).toEqual(["src","target"]);
      expect((await libraryStore.listPhysicalFileBindings({accountId:"acct",connectedStorageId:"drive",limit:10})).find(({fileId})=>fileId==="file")?.parentDirectoryId).toBe("dir-1");
      expect(cloud.writeCount).toBe(3);
      expect(await service.store.listVerifiedLocationPlanKeys(scope,10)).toEqual([]);

      expect(await service.store.getTaskOrganizeConcurrency(scope, "task")).toBe(3);
      const historyPage = await service.store.listOperationHistory(scope, { page: 1, pageSize: 20, status: "verified" });
      expect(historyPage).toMatchObject({
        page: 1,
        pageSize: 20,
        total: 1,
        totalPages: 1,
        counts: { all: 1, running: 0, planned: 0, verified: 1, failed: 0 },
      });
      expect(historyPage.items[0]?.fileId).toBe("file");

      fence.failNextAssertion=true;
      await expect(service.executeSlice("task",plan.operationKey)).rejects.toThrow("FENCE_LOST");
      expect(cloud.writeCount).toBe(3);
      const previousRehearsal=process.env.MEDIA_TRACK_REHEARSAL;
      process.env.MEDIA_TRACK_REHEARSAL="1";
      try { await expect(service.executeSlice("task",plan.operationKey)).rejects.toThrow(/演练模式/); }
      finally { if(previousRehearsal===undefined) delete process.env.MEDIA_TRACK_REHEARSAL; else process.env.MEDIA_TRACK_REHEARSAL=previousRehearsal; }
      expect(cloud.writeCount).toBe(3);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(()=>undefined);
      await adminPool.end();
    }
  },30_000);
});

class TestFence {
  held=false;
  failNextAssertion=false;
  async run<T>(_keys:readonly string[],fn:()=>Promise<T>):Promise<T> { this.held=true; try{return await fn();}finally{this.held=false;} }
  async assertHeld():Promise<void> { if(this.failNextAssertion){this.failNextAssertion=false;throw new Error("FENCE_LOST");} if(!this.held)throw new Error("FENCE_NOT_HELD"); }
}

class FakeCloud {
  writeCount=0;
  private nextDirectory=0;
  private readonly items=new Map<string,{fileId:string;parentId:string;name:string;isDirectory:boolean}>();
  constructor(private readonly fence:TestFence) { this.items.set("file",{fileId:"file",parentId:"src",name:"raw.mkv",isDirectory:false}); }
  async list(parentId:string) {
    return [...this.items.values()].filter((item)=>item.parentId===parentId);
  }
  async read(fileId:string,knownParentIds:readonly string[]) {
    return [...this.items.values()].find((item)=>item.fileId===fileId&&knownParentIds.includes(item.parentId)) ?? null;
  }
  async createDir(parentId:string,name:string):Promise<string> {
    await this.fence.assertHeld(); this.writeCount+=1;
    const fileId=`dir-${++this.nextDirectory}`; this.items.set(fileId,{fileId,parentId,name,isDirectory:true}); return fileId;
  }
  async rename(fileId:string,name:string):Promise<void> { await this.fence.assertHeld(); this.writeCount+=1; const current=this.items.get(fileId)!; this.items.set(fileId,{...current,name}); }
  async move(fileId:string,parentId:string):Promise<void> { await this.fence.assertHeld(); this.writeCount+=1; const current=this.items.get(fileId)!;this.items.set(fileId,{...current,parentId}); }
}
