import type { NextRequest } from "next/server";
import { apiErrorResponse, decodeCursor, encodeCursor, libraryAccount, LibraryApiError, parseLimit, readJson, requireString } from "../../../../../../../lib/library-api";
import { getLibraryOrganizationService, LibraryOrganizationRuntimeError } from "../../../../../../../lib/library-organization-runtime";
import { OrganizationAuthorizationError, OrganizationConflictError } from "@media-track/workflow/library";

type Context = { params: Promise<{taskId:string;operationKey:string}> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const accountId=await libraryAccount(request); const {taskId,operationKey}=await context.params;
    const storageId=requireString(request.nextUrl.searchParams.get("storageId"),"storageId");
    const limit=parseLimit(request.nextUrl.searchParams.get("limit"),50,200);
    const afterOperationId=decodeCursor(request.nextUrl.searchParams.get("cursor"));
    const service=await getLibraryOrganizationService(accountId,storageId);
    const [summary,rows]=await Promise.all([
      service.store.getPlanSummary(service.scope,taskId,operationKey),
      service.store.listOperations(service.scope,taskId,operationKey,{limit:limit+1,...(afterOperationId?{afterOperationId}:{})}),
    ]);
    const matching=summary;
    if (!matching) throw new LibraryApiError(404,"整理清单不存在。");
    const hasMore=rows.length>limit; const operations=rows.slice(0,limit);
    return Response.json({plan:{operationKey,status:matching.status,createdAt:matching.createdAt,updatedAt:matching.updatedAt,operationCount:matching.operationCount,skippedFiles:matching.skippedFiles},operations,nextCursor:hasMore?encodeCursor(operations.at(-1)?.operationId??null):null});
  } catch(error) { return organizationError(error); }
}

export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    const accountId=await libraryAccount(request,true); const {taskId,operationKey}=await context.params;
    const body=await readJson(request); const storageId=requireString(body.storageId,"storageId");
    const action=body.action;
    if (action!=="execute" && action!=="pause") throw new LibraryApiError(400,"整理操作无效。");
    const service=await getLibraryOrganizationService(accountId,storageId);
    const updated=action==="execute"
      ? await service.store.requestExecution(service.scope,taskId,operationKey,new Date().toISOString())
      : await service.store.pause(service.scope,taskId,operationKey,new Date().toISOString());
    if (!updated) throw new LibraryApiError(404,"整理清单不存在或已完成。");
    return Response.json({operationKey,status:action==="execute"?"queued":"paused",accepted:true});
  } catch(error) { return organizationError(error); }
}

function organizationError(error:unknown):Response {
  if (error instanceof LibraryOrganizationRuntimeError) return Response.json({error:error.message},{status:error.code==="storage_not_found"?404:error.code==="credentials_invalid"?403:409});
  if (error instanceof OrganizationAuthorizationError || error instanceof OrganizationConflictError || error instanceof RangeError) return Response.json({error:error.message},{status:409});
  return apiErrorResponse(error);
}
