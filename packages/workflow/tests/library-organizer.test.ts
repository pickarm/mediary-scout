import { describe, expect, it, vi } from "vitest";
import {
  LibraryOrganizer,
  buildOrganizationPlan,
  computeNamingTemplatesFingerprint,
  createGuangYaOrganizationStorage,
  renderExpectedVideoTarget,
  type OrganizationFileFact,
  type OrganizationPlan,
  type OrganizationScope,
  type OrganizationOperation,
  type OrganizationAuthorizedFile,
  type OrganizationStorage,
} from "../src/library/organizer.js";
import type { OrganizationStore } from "../src/library/organization-store.js";

const scope: OrganizationScope = { accountId:"acct",connectedStorageId:"drive" };
const baseGraph = () => ({
  directories:[
    {directoryId:"src",parentDirectoryId:null,name:"Source"},
    {directoryId:"target",parentDirectoryId:null,name:"Library"},
    {directoryId:"movie-dir",parentDirectoryId:"target",name:"Film (2024) [tmdbid=123]"},
    {directoryId:"season-dir",parentDirectoryId:"target",name:"Show (2024)"},
    {directoryId:"season-01",parentDirectoryId:"season-dir",name:"Season 01"},
  ],
  files:[] as OrganizationFileFact[],
});
const identity = {mediaTitleId:"title-1",trackedSeasonId:"season-1",mediaType:"movie" as const,title:"Film",originalTitle:"Film Original",year:2024,tmdbId:123};
function confirmed(fileId: string, parentDirectoryId: string, name: string, extra: Partial<OrganizationAuthorizedFile> = {}): OrganizationAuthorizedFile {
  return {fileId,parentDirectoryId,name,isDirectory:false,confirmed:true,identity,...extra};
}
function input(files: OrganizationAuthorizedFile[], graph = baseGraph()) {
  graph.files.push(...files.map(({fileId,parentDirectoryId,name}) => ({fileId,parentDirectoryId,name,isDirectory:false as const})));
  return {scope,taskId:"task",operationKey:"organize-1",sourceRoots:["src"],targetRoots:["target"],graph,confirmedFiles:files,now:"2026-11-14T00:00:00.000Z"};
}

class MemoryStore implements OrganizationStore {
  planValue: OrganizationPlan | null = null;
  createCalls = 0;
  lease: string | null = null;
  async ensureSchema() {}
  async authorizePlan(value:Parameters<OrganizationStore["authorizePlan"]>[0]) { return value; }
  async authorizeExecution() {}
  async requestExecution() { return false; }
  async pause() { return false; }
  async listRequested() { return []; }
  async listPlans() { return []; }
  async getPlanSummary() { return null; }
  async listVerifiedLocationsToSync() { return []; }
  async listVerifiedLocationPlanKeys() { return []; }
  async listOperations() { return []; }
  async derivePlanInput(): Promise<Awaited<ReturnType<OrganizationStore["derivePlanInput"]>>> { throw new Error("not implemented in organizer unit fixture"); }
  async createOrGet({plan}: {plan:OrganizationPlan; operationKey:string}): Promise<OrganizationPlan> { this.createCalls += 1; this.planValue ??= structuredClone(plan); return structuredClone(this.planValue); }
  async get(): Promise<OrganizationPlan | null> { return this.planValue ? structuredClone(this.planValue) : null; }
  async claim(_scope:OrganizationScope,_taskId:string,_key:string,lease:string): Promise<boolean> { if (this.lease) return false; this.lease = lease; return true; }
  async renew(): Promise<boolean> { return this.lease !== null; }
  async updateOperation(_scope:OrganizationScope,_taskId:string,_key:string,lease:string,operation:OrganizationOperation): Promise<boolean> {
    if (this.lease !== lease || !this.planValue) return false;
    this.planValue.operations = this.planValue.operations.map((item) => item.operationId === operation.operationId ? structuredClone(operation) : item);
    return true;
  }
  async finish(_scope:OrganizationScope,_taskId:string,_key:string,lease:string,status:OrganizationPlan["status"]): Promise<boolean> { if (this.lease !== lease || !this.planValue) return false; this.planValue.status = status; this.lease = null; return true; }
}

class MemoryStorage implements OrganizationStorage {
  items = new Map<string,{fileId:string;parentId:string;name:string;isDirectory:boolean}>();
  dirSequence = 0;
  moveEffect: "success"|"timeout-after-success"|"timeout-before-success"|"lie" = "success";
  renameEffect: "success"|"lie" = "success";
  async list(parentId:string) { return [...this.items.values()].filter((item) => item.parentId === parentId).map((item) => ({...item})); }
  async read(fileId:string, parents:readonly string[]) { const matches = [...this.items.values()].filter((item) => item.fileId === fileId && parents.includes(item.parentId)); return matches.length === 1 ? {...matches[0]!} : null; }
  async createDir(parentId:string,name:string) { const fileId = `dir-${++this.dirSequence}`; this.items.set(fileId,{fileId,parentId,name,isDirectory:true}); return fileId; }
  async rename(fileId:string,name:string) { if (this.renameEffect === "success") { const item = this.items.get(fileId)!; this.items.set(fileId,{...item,name}); } }
  async move(fileId:string,parentId:string) {
    if (this.moveEffect === "timeout-before-success") throw new Error("timeout");
    if (this.moveEffect !== "lie") { const item = this.items.get(fileId)!; this.items.set(fileId,{...item,parentId}); }
    if (this.moveEffect === "timeout-after-success") throw new Error("timeout");
  }
}

describe("safe library organizer", () => {
  it("persists a skip-only plan when a multi-episode file cannot be represented safely", () => {
    const base=input([],baseGraph());
    base.targetRoots=[];
    const plan=buildOrganizationPlan({...base,preSkippedFiles:[{fileId:"double-episode",reason:"当前模板不能安全表达完整多集身份，已保留原位"}]});
    expect(plan.operations).toEqual([]);
    expect(plan.skippedFiles).toEqual([{fileId:"double-episode",reason:"当前模板不能安全表达完整多集身份，已保留原位"}]);
    expect(plan.targetRootIds).toEqual([]);
  });

  it("skips an already compliant movie and preserves the original extension case", () => {
    const compliant = confirmed("m1","movie-dir","Film (2024).MKV");
    const graph = baseGraph();
    const compliantInput = input([compliant],graph);
    compliantInput.sourceRoots = ["src","target"];
    const plan = buildOrganizationPlan(compliantInput);
    expect(plan.operations).toHaveLength(0);
    expect(plan.targetRootByMediaType).toEqual({movie:"target"});
    expect(plan.targetRootIds).toEqual(["target"]);
    const planned = buildOrganizationPlan({...input([confirmed("m2","src","raw.MKV")]),templates:{movieFile:"{title} ({year}){ext}"}});
    expect(planned.operations[0]?.targetName).toBe("Film (2024).MKV");
  });

  it("keeps subtitle language and forced suffixes with exact extensions", () => {
    const video = confirmed("v1","src","raw.mkv");
    const graph = baseGraph();
    graph.files.push(
      {fileId:"s1",parentDirectoryId:"src",name:"raw.jpn.ass",isDirectory:false},
      {fileId:"s2",parentDirectoryId:"src",name:"raw.fr.srt",isDirectory:false},
      {fileId:"s3",parentDirectoryId:"src",name:"raw.zh-Hans.srt",isDirectory:false},
      {fileId:"s4",parentDirectoryId:"src",name:"raw.forced.SRT",isDirectory:false},
    );
    const plan = buildOrganizationPlan(input([video],graph));
    expect(plan.operations.map(({targetName}) => targetName)).toEqual(["Film (2024).mkv","Film (2024).jpn.ass","Film (2024).fr.srt","Film (2024).zh-Hans.srt","Film (2024).forced.SRT"]);
  });

  it("keeps subtitles in place and reports ambiguity when same-basename videos tie", () => {
    const mkv = confirmed("v-mkv","src","raw.mkv");
    const mp4 = confirmed("v-mp4","src","raw.mp4");
    const graph = baseGraph();
    graph.files.push({fileId:"s1",parentDirectoryId:"src",name:"raw.jpn.ass",isDirectory:false});
    const plan = buildOrganizationPlan(input([mkv,mp4],graph));
    expect(plan.operations.map(({fileId}) => fileId)).toEqual(["v-mkv","v-mp4"]);
    expect(plan.skippedFiles).toEqual([{fileId:"s1",reason:"字幕同时匹配多个同长度视频basename（v-mkv、v-mp4），已保留原位"}]);
  });

  it("retains both versions by adding deterministic file ID suffixes", () => {
    const a = confirmed("video-a","src","first.mkv");
    const b = confirmed("video-b","src","second.mkv");
    const plan = buildOrganizationPlan(input([a,b]));
    expect(plan.operations.map(({targetName}) => targetName)).toEqual(["Film (2024).mkv","Film (2024) (2e046223).mkv"]);
  });

  it("rejects source file facts and target roots outside the authorized graph", () => {
    const good = confirmed("m1","src","raw.mkv");
    expect(() => buildOrganizationPlan(input([{...good,parentDirectoryId:"outside"}]))).toThrow(/扫描图|授权文件缺少真实父目录/);
    expect(() => buildOrganizationPlan({...input([good]),targetRoots:["outside"]})).toThrow(/不在扫描图或持久化配置授权中/);
  });

  it("rejects a provider file whose extension case would change", () => {
    const movie = confirmed("m1","src","raw.MKV");
    expect(() => buildOrganizationPlan({...input([movie]),templates:{movieFile:"{title} ({year}).mkv"}})).toThrow(/扩展名及大小写/);
  });

  it("recovers a move timeout only when listing proves the real target", async () => {
    const store = new MemoryStore(); const storage = new MemoryStorage();
    storage.items.set("v1",{fileId:"v1",parentId:"src",name:"raw.mkv",isDirectory:false});
    storage.moveEffect = "timeout-after-success";
    const organizer = new LibraryOrganizer({store,storage,idFactory:() => "stable",now:() => "2026-11-14T00:00:00.000Z"});
    await organizer.plan(input([confirmed("v1","src","raw.mkv")]));
    const result = await organizer.execute(scope,"task","organize-1");
    expect(result.plan.operations[0]?.status).toBe("verified");
    expect(result.verifiedLocations[0]?.parentId).toBe("dir-1");
  });

  it("does not claim success after a move timeout without a matching readback", async () => {
    const store = new MemoryStore(); const storage = new MemoryStorage();
    storage.items.set("v1",{fileId:"v1",parentId:"src",name:"raw.mkv",isDirectory:false});
    storage.moveEffect = "timeout-before-success";
    const organizer = new LibraryOrganizer({store,storage,idFactory:() => "stable"});
    await organizer.plan(input([confirmed("v1","src","raw.mkv")]));
    const result = await organizer.execute(scope,"task","organize-1");
    expect(result.plan.operations[0]?.status).toBe("failed");
  });

  it("rejects optimistic client success when actual listing facts did not move", async () => {
    const store = new MemoryStore(); const storage = new MemoryStorage();
    storage.items.set("v1",{fileId:"v1",parentId:"src",name:"raw.mkv",isDirectory:false});
    storage.moveEffect = "lie";
    const organizer = new LibraryOrganizer({store,storage,idFactory:() => "stable"});
    await organizer.plan(input([confirmed("v1","src","raw.mkv")]));
    const result = await organizer.execute(scope,"task","organize-1");
    expect(result.plan.operations[0]?.status).toBe("failed");
  });

  it("checks the real GuangYa adapter listing after the client reports a move", async () => {
    const store = new MemoryStore();
    const moveFiles = vi.fn(async () => undefined);
    const client = {
      async listFilesPage(parentId:string) {
        const items = parentId === "src"
          ? [{fileId:"v1",parentId:"src",fileName:"raw.mkv",fileSize:12,resType:1}]
          : parentId === "target"
            ? [{fileId:"dir-1",parentId:"target",fileName:"Film (2024) [tmdbid=123]",fileSize:0,resType:2}]
            : [];
        return {items,hasMore:false};
      },
      async createDir() { return "unused"; },
      async renameFile() {},
      moveFiles,
    };
    const organizer = new LibraryOrganizer({store,storage:createGuangYaOrganizationStorage(client),idFactory:() => "lease"});
    await organizer.plan(input([confirmed("v1","src","raw.mkv")]));
    const result = await organizer.execute(scope,"task","organize-1");
    expect(moveFiles).toHaveBeenCalledWith(["v1"],"dir-1");
    expect(result.plan.operations[0]?.status).toBe("failed");
  });

  it("restarts by reconciling the saved operation against the provider before writing", async () => {
    const store = new MemoryStore(); const storage = new MemoryStorage();
    storage.items.set("v1",{fileId:"v1",parentId:"dir-1",name:"Film (2024).mkv",isDirectory:false});
    await store.createOrGet({plan:buildOrganizationPlan(input([confirmed("v1","src","raw.mkv")]),() => "op"),operationKey:"organize-1"});
    store.planValue!.operations[0]!.status = "running";
    const move = vi.spyOn(storage,"move");
    const organizer = new LibraryOrganizer({store,storage,idFactory:() => "lease"});
    const result = await organizer.resume(scope,"task","organize-1");
    expect(result.plan.operations[0]?.status).toBe("verified");
    expect(move).not.toHaveBeenCalled();
  });

  it("serializes concurrent creation for one plan key", async () => {
    const store = new MemoryStore(); const storage = new MemoryStorage();
    const create = store.createOrGet.bind(store);
    const gate = new Promise<void>((resolve) => setTimeout(resolve,10));
    vi.spyOn(store,"createOrGet").mockImplementation(async (args) => { await gate; return create(args); });
    const organizer = new LibraryOrganizer({store,storage,idFactory:() => "op"});
    const args = input([confirmed("v1","src","raw.mkv")]);
    const [a,b] = await Promise.all([organizer.plan(args),organizer.plan(args)]);
    expect(a.operations.map(({operationId}) => operationId)).toEqual(b.operations.map(({operationId}) => operationId));
    expect(store.createCalls).toBe(1);
  });

  it("extracts Dolby Vision, Atmos and release group from filenames using default templates and pairs subtitles", () => {
    const video = confirmed("v-dv", "src", "Film.2024.2160p.BluRay.REMUX.DV.HDR10+.HEVC.TrueHD.Atmos-CHD.mkv");
    const graph = baseGraph();
    graph.files.push({
      fileId: "s-dv",
      parentDirectoryId: "src",
      name: "Film.2024.2160p.BluRay.REMUX.DV.HDR10+.HEVC.TrueHD.Atmos-CHD.zh-Hans.forced.ass",
      isDirectory: false,
    });
    const plan = buildOrganizationPlan(input([video], graph));
    expect(plan.operations.map((item) => item.targetRelativePath)).toEqual([
      "Film (2024) [tmdbid=123]/Film (2024) - 2160p.REMUX.DV.HDR10+.HEVC.TrueHD.Atmos-CHD.mkv",
      "Film (2024) [tmdbid=123]/Film (2024) - 2160p.REMUX.DV.HDR10+.HEVC.TrueHD.Atmos-CHD.zh-Hans.forced.ass",
    ]);
  });

  it("runs operations concurrently with single-flight directory creation and isolates per-file failures", async () => {
    const store = new MemoryStore();
    const storage = new MemoryStorage();
    storage.items.set("v1", { fileId: "v1", parentId: "src", name: "Ep1.mkv", isDirectory: false });
    storage.items.set("v2", { fileId: "v2", parentId: "src", name: "Ep2.mkv", isDirectory: false });
    storage.items.set("v3", { fileId: "v3", parentId: "src", name: "Ep3.mkv", isDirectory: false });

    const createSpy = vi.spyOn(storage, "createDir").mockImplementation(async (parentId, name) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      const fileId = `dir-${++storage.dirSequence}`;
      storage.items.set(fileId, { fileId, parentId, name, isDirectory: true });
      return fileId;
    });
    let inFlightMoves = 0;
    let maxInFlightMoves = 0;
    const origMove = storage.move.bind(storage);
    vi.spyOn(storage, "move").mockImplementation(async (fileId, parentId) => {
      inFlightMoves += 1;
      maxInFlightMoves = Math.max(maxInFlightMoves, inFlightMoves);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        if (fileId === "v2") throw new Error("单文件写入失败");
        await origMove(fileId, parentId);
      } finally {
        inFlightMoves -= 1;
      }
    });

    const files = [
      confirmed("v1", "src", "Ep1.mkv"),
      confirmed("v2", "src", "Ep2.mkv"),
      confirmed("v3", "src", "Ep3.mkv"),
    ];
    const organizer = new LibraryOrganizer({ store, storage, idFactory: () => "lease-concurrent" });
    await organizer.plan({
      ...input(files),
      templates: { movieFile: "{originalName}{ext}" },
    });
    const result = await organizer.execute(scope, "task", "organize-1", { concurrency: 3 });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(maxInFlightMoves).toBeGreaterThanOrEqual(2);
    expect(result.processed).toBe(3);
    expect(result.plan.status).toBe("failed");
    const byFile = Object.fromEntries(result.plan.operations.map((op) => [op.fileId, op.status]));
    expect(byFile).toEqual({ v1: "verified", v2: "failed", v3: "verified" });
  });

  it("trips circuit breaker after consecutive failures, leaving remaining operations planned, and resets counter on success", async () => {
    const store = new MemoryStore();
    const storage = new MemoryStorage();
    for (let i = 1; i <= 7; i += 1) {
      storage.items.set(`f${i}`, { fileId: `f${i}`, parentId: "src", name: `Ep${i}.mkv`, isDirectory: false });
    }
    const origMove = storage.move.bind(storage);
    vi.spyOn(storage, "move").mockImplementation(async (fileId, parentId) => {
      if (fileId === "f2") {
        await origMove(fileId, parentId);
        return;
      }
      throw new Error(`权限错误:${fileId}`);
    });

    const files = Array.from({ length: 7 }, (_, i) => confirmed(`f${i + 1}`, "src", `Ep${i + 1}.mkv`));
    const organizer = new LibraryOrganizer({ store, storage, idFactory: () => "lease-breaker" });
    await organizer.plan({
      ...input(files),
      templates: { movieFile: "{originalName}{ext}" },
    });
    // f1 fail (1) -> f2 ok (reset to 0) -> f3, f4, f5 fail (3) -> trip before f6, f7
    const result = await organizer.execute(scope, "task", "organize-1", {
      concurrency: 1,
      maxConsecutiveFailures: 3,
    });

    expect(result.plan.status).toBe("failed");
    expect(result.processed).toBe(5);
    expect(result.circuitBreaker).toEqual({
      consecutiveFailures: 3,
      remainingPlanned: 2,
      lastError: "权限错误:f5",
    });
    expect(result.plan.operations.map((op) => op.status)).toEqual([
      "failed",
      "verified",
      "failed",
      "failed",
      "failed",
      "planned",
      "planned",
    ]);
  });

  it("computes stable template fingerprints and restores missing tech tags from tagSourceName during reorganization", () => {
    const fpA = computeNamingTemplatesFingerprint();
    const fpB = computeNamingTemplatesFingerprint({});
    const fpC = computeNamingTemplatesFingerprint({ movieFile: "{title} ({year}){ext}" });
    expect(fpA).toBe(fpB);
    expect(fpC).not.toBe(fpA);

    const rendered = renderExpectedVideoTarget(
      identity,
      "TamperedName.mp4",
      undefined,
      "Film (2024) - 2160p.REMUX.DV.HEVC-CHD.mkv",
    );
    expect(rendered.fileName).toBe("Film (2024) - 2160p.REMUX.DV.HEVC-CHD.mp4");
    expect(rendered.relativePath).toBe("Film (2024) [tmdbid=123]/Film (2024) - 2160p.REMUX.DV.HEVC-CHD.mp4");

    const plan = buildOrganizationPlan(
      input([confirmed("v-tampered", "src", "TamperedName.mkv", { tagSourceName: "Film (2024) - 2160p.BluRay.HEVC-CHD.mkv" })]),
    );
    expect(plan.operations[0]?.targetRelativePath).toBe("Film (2024) [tmdbid=123]/Film (2024) - 2160p.BluRay.HEVC-CHD.mkv");
  });
});
