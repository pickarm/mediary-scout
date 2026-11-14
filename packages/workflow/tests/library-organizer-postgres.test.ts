import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getStorageBrand } from "../src/storage-brands.js";
import { PostgresLibraryStore } from "../src/library/store.js";
import { PostgresScanStore } from "../src/library/scan-store.js";
import { PostgresOrganizationStore } from "../src/library/organization-store.js";
import { LibraryOrganizer, type OrganizationPlanInput, type OrganizationStorage } from "../src/library/organizer.js";

const adminURL = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;

describe.skipIf(!adminURL)("Postgres organization authorization (isolated database)", () => {
  it("uses registered guangya, saved templates, and completes a zero-operation plan without touching storage twice", async () => {
    const dbName = `organizer_${randomUUID().replaceAll("-","")}`;
    const adminPool = new Pool({ connectionString:adminURL });
    let testPool: Pool | null = null;
    try {
      await adminPool.query(`CREATE DATABASE ${dbName}`);
      const url = new URL(adminURL!);
      url.pathname = `/${dbName}`;
      testPool = new Pool({ connectionString:url.toString() });

      // Use the provider registry and native connected_storages shape, then let
      // F04/F02 initialize their real schemas and foreign keys.
      const guangyaProvider = getStorageBrand("guangya").provider;
      expect(guangyaProvider).toBe("guangya");
      const scanStore = new PostgresScanStore(testPool);
      await scanStore.ensureSchema();
      await testPool.query(
        "INSERT INTO connected_storages(id,account_id,provider,provider_uid,payload,created_at) VALUES('drive','acct',$1,'uid','{}'::jsonb,'now')",
        [guangyaProvider],
      );

      const scope = { accountId:"acct", connectedStorageId:"drive" };
      const configuration = {
        configId:"config",scope,sourceRoots:[{directoryId:"src",name:"Source"},{directoryId:"target",name:"Library"}],
        movieTargetDirectoryId:"target",tvTargetDirectoryId:"target",mediaKind:"mixed" as const,
        dailyScheduleEnabled:false,dailyScheduleTime:null,dailyScheduleTimezone:"Asia/Shanghai" as const,
        autoOrganize:false,autoAcquire:false as const,
        templates:{movieFile:"{title} [{year}]{ext}"},
      };
      await scanStore.saveConfiguration(configuration);
      await scanStore.createTask({taskId:"task",scope,configuration,roots:configuration.sourceRoots,now:"2026-11-14T00:00:00.000Z"});
      const leaseId = "scan-lease";
      expect(await scanStore.claimTask(scope,"task",leaseId,"2026-11-14T00:00:00.000Z","2026-11-14T00:02:00.000Z")).toBe(true);
      await testPool.query(
        "INSERT INTO library_scan_files(account_id,connected_storage_id,file_id,parent_directory_id,name,is_directory,path) VALUES('acct','drive','file','src','raw.mkv',false,'Source/raw.mkv')",
      );
      await testPool.query(
        "INSERT INTO library_scan_task_files(account_id,connected_storage_id,task_id,file_id,parent_directory_id,name,is_directory,path) VALUES('acct','drive','task','file','src','raw.mkv',false,'Source/raw.mkv')",
      );
      expect(await scanStore.finishTask({scope,taskId:"task",leaseId,status:"completed",now:"2026-11-14T00:00:01.000Z"})).toBe(true);

      const title = {id:"tmdb_movie_123",tmdbId:123,type:"movie" as const,title:"Film",originalTitle:"Film Original",year:2024,aliases:[]};
      const season = {id:"tmdb_movie_123_movie",mediaTitleId:"tmdb_movie_123",seasonNumber:1,status:"active" as const,qualityPreference:"",storageDirectoryId:"src",totalEpisodes:1,latestAiredEpisode:0,latestAiredSource:"unknown" as const};
      await new PostgresLibraryStore(testPool).importExistingMedia({
        accountId:"acct",connectedStorageId:"drive",title,season,episodes:[],
        files:[{fileId:"file",parentDirectoryId:"src",episodeCode:"S01E01"}],
        directories:[{directoryId:"src",parentDirectoryId:null}],now:"2026-11-14T00:00:00.000Z",
      });

      const store = new PostgresOrganizationStore(testPool);
      const baseInput: OrganizationPlanInput = {
        scope,taskId:"task",operationKey:"once",sourceRoots:["src","target"],targetRoots:["target"],
        targetRootByMediaType:{movie:"target"},
        graph:{directories:[{directoryId:"src",parentDirectoryId:null,name:"Source"},{directoryId:"target",parentDirectoryId:null,name:"Library"}],files:[{fileId:"file",parentDirectoryId:"src",name:"raw.mkv",isDirectory:false}]},
        confirmedFiles:[{fileId:"file",parentDirectoryId:"src",name:"raw.mkv",isDirectory:false,confirmed:true,identity:{mediaTitleId:"tmdb_movie_123",trackedSeasonId:"tmdb_movie_123_movie",mediaType:"movie",title:"Film",originalTitle:"Film Original",year:2024,tmdbId:123}}],
      };
      const authorized = await store.authorizePlan(baseInput);
      expect(authorized.templates?.movieFile).toBe("{title} [{year}]{ext}");
      const plan = await new LibraryOrganizer({store,storage:{} as OrganizationStorage}).plan(baseInput);
      expect(plan.operations[0]?.targetName).toBe("Film [2024].mkv");
      await expect(store.authorizeExecution({...plan,targetRootByMediaType:{movie:"target",tv:"target"}})).resolves.toBeUndefined();
      await expect(store.authorizePlan({...baseInput,templates:{movieFile:"{title} ({year}){ext}"}})).rejects.toThrow(/持久化扫描配置/);

      // A saved plan with no operations still carries the authorized media target.
      // The executor must complete it and subsequent execute calls must not touch
      // the provider after the completed status has been persisted.
      await testPool.query(
        "INSERT INTO library_scan_directories(account_id,connected_storage_id,task_id,directory_id,parent_directory_id,path,next_page,status) VALUES('acct','drive','task','film-dir','target','Library/Film (2024)',0,'done')",
      );
      await testPool.query(
        "INSERT INTO library_scan_files(account_id,connected_storage_id,file_id,parent_directory_id,name,is_directory,path) VALUES('acct','drive','compliant-file','film-dir','Film [2024].mkv',false,'Library/Film (2024)/Film [2024].mkv')",
      );
      await testPool.query(
        "INSERT INTO library_scan_task_files(account_id,connected_storage_id,task_id,file_id,parent_directory_id,name,is_directory,path) VALUES('acct','drive','task','compliant-file','film-dir','Film [2024].mkv',false,'Library/Film (2024)/Film [2024].mkv')",
      );
      await new PostgresLibraryStore(testPool).importExistingMedia({
        accountId:"acct",connectedStorageId:"drive",title,season,episodes:[],
        files:[{fileId:"compliant-file",parentDirectoryId:"film-dir",episodeCode:"S01E01"}],
        directories:[{directoryId:"film-dir",parentDirectoryId:"target"}],now:"2026-11-14T00:00:02.000Z",
      });
      const compliantInput: OrganizationPlanInput = {
        ...baseInput,operationKey:"already-compliant",
        graph:{...baseInput.graph,directories:[...baseInput.graph.directories,{directoryId:"film-dir",parentDirectoryId:"target",name:"Film (2024)"}],files:[{fileId:"compliant-file",parentDirectoryId:"film-dir",name:"Film [2024].mkv",isDirectory:false}]},
        confirmedFiles:[{...baseInput.confirmedFiles[0]!,fileId:"compliant-file",parentDirectoryId:"film-dir",name:"Film [2024].mkv"}],
      };
      const noOpPlan = await new LibraryOrganizer({store,storage:{} as OrganizationStorage}).plan(compliantInput);
      expect(noOpPlan.operations).toHaveLength(0);
      expect(noOpPlan.targetRootByMediaType).toEqual({movie:"target"});
      expect(noOpPlan.targetRootIds).toEqual(["target"]);

      let providerCalls = 0;
      const noWriteStorage: OrganizationStorage = {
        async list() { providerCalls += 1; throw new Error("completed plan must not list storage"); },
        async read() { providerCalls += 1; throw new Error("completed plan must not read storage"); },
        async createDir() { providerCalls += 1; throw new Error("completed plan must not create directories"); },
        async rename() { providerCalls += 1; throw new Error("completed plan must not rename"); },
        async move() { providerCalls += 1; throw new Error("completed plan must not move"); },
      };
      const organizer = new LibraryOrganizer({store,storage:noWriteStorage});
      expect((await organizer.execute(scope,"task","already-compliant")).plan.status).toBe("completed");
      expect((await organizer.execute(scope,"task","already-compliant")).plan.status).toBe("completed");
      expect(providerCalls).toBe(0);
    } finally {
      await testPool?.end();
      await adminPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
      await adminPool.end();
    }
  }, 30_000);
});
