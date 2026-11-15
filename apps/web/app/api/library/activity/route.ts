import type { NextRequest } from "next/server";
import { ActivityQueryInputError } from "@media-track/workflow/activity-query";
import { getLibraryActivityPage } from "../../../../lib/library-activity-runtime";
import { apiErrorResponse, LibraryApiError, libraryAccount } from "../../../../lib/library-api";
import { parseLibraryActivityInput } from "../../../../lib/library-activity-input";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const accountId = await libraryAccount(request);
    const input = parseLibraryActivityInput(request.nextUrl.searchParams, accountId);
    const storageId = input.connectedStorageId;
    if (storageId !== null) {
      const storages = await getWorkflowRepository().listConnectedStorages(accountId);
      if (!storages.some((storage) => storage.id === storageId && storage.accountId === accountId)) throw new LibraryApiError(404, "找不到该账号的网盘连接。");
    }
    const result = await getLibraryActivityPage(input);
    return Response.json(result);
  } catch (error) {
    if (error instanceof ActivityQueryInputError) return Response.json({ error: error.message }, { status: 400 });
    return apiErrorResponse(error);
  }
}
