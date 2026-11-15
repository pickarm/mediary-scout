import type { NextRequest } from "next/server";
import { apiErrorResponse, decodeCursor, encodeCursor, libraryAccount, LibraryApiError, parseLimit, readJson, requireString } from "../../../../../../lib/library-api";
import { getLibraryOrganizationService, LibraryOrganizationRuntimeError } from "../../../../../../lib/library-organization-runtime";
import { getLibraryReadOrganizationService } from "../../../../../../lib/library-read-runtime";
import { OrganizationAuthorizationError, OrganizationConflictError } from "@media-track/workflow/library";

type Context = { params: Promise<{taskId:string}> };

export async function GET(request: NextRequest, context: Context): Promise<Response> {
  try {
    const accountId=await libraryAccount(request); const {taskId}=await context.params;
    const storageId=requireString(request.nextUrl.searchParams.get("storageId"),"storageId");
    const limit=parseLimit(request.nextUrl.searchParams.get("limit"),50,200);
    const afterOperationKey=decodeCursor(request.nextUrl.searchParams.get("cursor"));
    const service=await getLibraryReadOrganizationService(accountId,storageId);
    const rows=await service.store.listPlans(service.scope,taskId,{limit:limit+1,...(afterOperationKey?{afterOperationKey}:{})});
    const hasMore=rows.length>limit; const plans=rows.slice(0,limit);
    return Response.json({plans,nextCursor:hasMore?encodeCursor(plans.at(-1)?.operationKey ?? null):null});
  } catch(error) { return organizationError(error); }
}

export async function POST(request: NextRequest, context: Context): Promise<Response> {
  try {
    const accountId=await libraryAccount(request,true); const {taskId}=await context.params;
    const body=await readJson(request);
    const storageId=requireString(body.storageId,"storageId");
    let fileIds: string[] | undefined;
    if (body.fileIds !== undefined) {
      if (!Array.isArray(body.fileIds) || body.fileIds.length < 1 || body.fileIds.length > 100 || body.fileIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 300) || new Set(body.fileIds).size !== body.fileIds.length) throw new LibraryApiError(400,"整理文件选择无效。");
      fileIds=body.fileIds as string[];
    }
    const afterFileId=body.afterFileId===undefined?undefined:requireString(body.afterFileId,"afterFileId");
    const limit=body.limit===undefined?undefined:parseLimit(String(body.limit),50,100);
    if (fileIds && (afterFileId || limit !== undefined)) throw new LibraryApiError(400,"文件ID选择不能同时使用分页游标或批次大小。");
    const service=await getLibraryOrganizationService(accountId,storageId);
    const plan=await service.preview(taskId,{...(fileIds?{fileIds}:{}),...(afterFileId?{afterFileId}:{}),...(limit?{limit}:{})});
    return Response.json({plan:{operationKey:plan.operationKey,status:plan.status,createdAt:plan.createdAt,updatedAt:plan.updatedAt,operationCount:plan.operations.length,skippedFiles:plan.skippedFiles}}, {status:201});
  } catch(error) { return organizationError(error); }
}

function organizationError(error:unknown):Response {
  if (error instanceof LibraryOrganizationRuntimeError) return Response.json({error:error.message},{status:error.code==="storage_not_found"?404:error.code==="credentials_invalid"?403:409});
  if (error instanceof OrganizationAuthorizationError || error instanceof OrganizationConflictError || error instanceof RangeError) return Response.json({error:error.message},{status:409});
  return apiErrorResponse(error);
}
