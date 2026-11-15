import type { NextRequest } from "next/server";
import { ActivityQueryInputError } from "@media-track/workflow/activity-query";
import { getLibraryActivityPage } from "../../../../lib/library-activity-runtime";
import { createLibraryProgressStream } from "../../../../lib/library-progress-stream";
import { parseLibraryActivityInput } from "../../../../lib/library-activity-input";
import { apiErrorResponse, LibraryApiError, libraryAccount } from "../../../../lib/library-api";
import { subscribeLibrarySummaryWake } from "../../../../lib/library-summary-cache";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const accountId = await libraryAccount(request);
    const input = parseLibraryActivityInput(request.nextUrl.searchParams, accountId);
    const verifyStorageOwnership = async (): Promise<void> => {
      if (input.connectedStorageId === null) return;
      const storages = await getWorkflowRepository().listConnectedStorages(accountId);
      if (!storages.some((storage) => storage.id === input.connectedStorageId && storage.accountId === accountId)) {
        throw new LibraryApiError(404, "找不到该账号的网盘连接。");
      }
    };
    // Initial and reconnect snapshots always come from the bounded PostgreSQL-backed query.
    await verifyStorageOwnership();
    const initialPage = await getLibraryActivityPage(input);
    return createLibraryProgressStream({
      initialPage,
      signal: request.signal,
      async loadPage() {
        await verifyStorageOwnership();
        return getLibraryActivityPage(input);
      },
      subscribe: (listener) => subscribeLibrarySummaryWake(listener),
    });
  } catch (error) {
    if (error instanceof ActivityQueryInputError) return Response.json({ error: error.message }, { status: 400 });
    return apiErrorResponse(error);
  }
}
