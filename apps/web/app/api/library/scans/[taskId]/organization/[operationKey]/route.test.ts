import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({store:{getPlanSummary:vi.fn(),listOperations:vi.fn(),requestExecution:vi.fn(),pause:vi.fn()}}));
vi.mock("../../../../../../../lib/library-api",async(importOriginal)=>{
  const actual=await importOriginal<typeof import("../../../../../../../lib/library-api")>();
  return {...actual,libraryAccount:vi.fn(async()=>"account-a")};
});
vi.mock("../../../../../../../lib/library-organization-runtime",async(importOriginal)=>{
  const actual=await importOriginal<typeof import("../../../../../../../lib/library-organization-runtime")>();
  return {...actual,getLibraryOrganizationService:vi.fn(async()=>({scope:{accountId:"account-a",connectedStorageId:"storage-a"},store:mocks.store}))};
});

import { GET, POST } from "./route";

function request(path:string,method="GET",body?:unknown):NextRequest {
  return new NextRequest(`https://app.example${path}`,{method,headers:{origin:"https://app.example",host:"app.example","x-forwarded-proto":"https",...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
}

describe("organization plan execution API",()=>{
  beforeEach(()=>{vi.clearAllMocks();});
  it("returns a bounded operation page instead of a full plan graph",async()=>{
    mocks.store.getPlanSummary.mockResolvedValue({operationKey:"key",status:"planned",createdAt:"a",updatedAt:"a",skippedFiles:[],operationCount:2});
    mocks.store.listOperations.mockResolvedValue([{operationId:"op1",fileId:"f1",status:"planned"},{operationId:"op2",fileId:"f2",status:"planned"}]);
    const response=await GET(request("/api/library/scans/task/organization/key?storageId=storage-a&limit=1"),{params:Promise.resolve({taskId:"task",operationKey:"key"})});
    expect(response.status).toBe(200);
    expect(mocks.store.listOperations).toHaveBeenCalledWith({accountId:"account-a",connectedStorageId:"storage-a"},"task","key",{limit:2});
    expect(await response.json()).toMatchObject({operations:[{operationId:"op1"}],nextCursor:expect.any(String),plan:{operationCount:2}});
  });
  it("persists explicit execute/pause intent without awaiting cloud work in the request",async()=>{
    mocks.store.requestExecution.mockResolvedValue(true); mocks.store.pause.mockResolvedValue(true);
    const context={params:Promise.resolve({taskId:"task",operationKey:"key"})};
    const start=await POST(request("/api/library/scans/task/organization/key","POST",{storageId:"storage-a",action:"execute"}),context);
    expect(start.status).toBe(200); expect(mocks.store.requestExecution).toHaveBeenCalledWith({accountId:"account-a",connectedStorageId:"storage-a"},"task","key",expect.any(String));
    const pause=await POST(request("/api/library/scans/task/organization/key","POST",{storageId:"storage-a",action:"pause"}),context);
    expect(pause.status).toBe(200); expect(mocks.store.pause).toHaveBeenCalled();
  });
});
