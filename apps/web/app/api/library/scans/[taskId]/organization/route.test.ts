import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({service:{preview:vi.fn(),store:{listPlans:vi.fn()}}}));
vi.mock("../../../../../../lib/library-api",async(importOriginal)=>{
  const actual=await importOriginal<typeof import("../../../../../../lib/library-api")>();
  return {...actual,libraryAccount:vi.fn(async()=>"account-a")};
});
vi.mock("../../../../../../lib/library-organization-runtime",async(importOriginal)=>{
  const actual=await importOriginal<typeof import("../../../../../../lib/library-organization-runtime")>();
  return {...actual,getLibraryOrganizationService:vi.fn(async()=>({...mocks.service,scope:{accountId:"account-a",connectedStorageId:"storage-a"}}))};
});
vi.mock("../../../../../../lib/library-read-runtime",()=>({
  getLibraryReadOrganizationService:vi.fn(async()=>({...mocks.service,scope:{accountId:"account-a",connectedStorageId:"storage-a"}})),
}));

import { GET, POST } from "./route";

function request(path:string,method="GET",body?:unknown):NextRequest {
  return new NextRequest(`https://app.example${path}`,{method,headers:{origin:"https://app.example",host:"app.example","x-forwarded-proto":"https",...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
}

describe("organization plan API",()=>{
  beforeEach(()=>{vi.clearAllMocks();});

  it("creates a plan from bounded file selection and ignores client graph claims",async()=>{
    mocks.service.preview.mockResolvedValue({operationKey:"org_stable",status:"planned",createdAt:"now",updatedAt:"now",operations:[{}],skippedFiles:[]});
    const response=await POST(request("/api/library/scans/task/organization","POST",{storageId:"storage-a",fileIds:["file-a"],graph:{files:[{fileId:"forged"}]}}),{params:Promise.resolve({taskId:"task"})});
    expect(response.status).toBe(201);
    expect(mocks.service.preview).toHaveBeenCalledWith("task",{fileIds:["file-a"]});
    expect(await response.json()).toMatchObject({plan:{operationKey:"org_stable",operationCount:1}});
  });

  it("reads only a bounded plan page",async()=>{
    mocks.service.store.listPlans.mockResolvedValue([{operationKey:"k1",status:"planned",executeRequested:true,createdAt:"a",updatedAt:"a",skippedFiles:[],operationCount:4},{operationKey:"k2",status:"planned",executeRequested:false,createdAt:"b",updatedAt:"b",skippedFiles:[],operationCount:3}]);
    const response=await GET(request("/api/library/scans/task/organization?storageId=storage-a&limit=1"),{params:Promise.resolve({taskId:"task"})});
    expect(response.status).toBe(200);
    expect(mocks.service.store.listPlans).toHaveBeenCalledWith({accountId:"account-a",connectedStorageId:"storage-a"},"task",{limit:2});
    expect(await response.json()).toMatchObject({plans:[{operationKey:"k1",executeRequested:true}],nextCursor:expect.any(String)});
  });
});
