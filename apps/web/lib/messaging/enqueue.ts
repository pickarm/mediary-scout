import type { Pool } from "pg";
import type { MessagingCommandPorts } from "./commands";

type QueueOwnedMedia = (accountId: string, candidateId: string, storageId: string, messagingJobId: string) => Promise<{
  status: string; workflowRunId?: string | null; message?: string;
}>;

/** Persist dispatch intent, then let the original reservation atomically attach its run. */
export function createMessagingEnqueue(pool: Pool, queue: QueueOwnedMedia): MessagingCommandPorts["enqueue"] {
  return async (input) => {
    const prepared = await pool.query(
      "UPDATE messaging_jobs SET phase='queued', landing_storage_id=$3, result=$4::jsonb, updated_at=$5 WHERE id=$1 AND account_id=$2 AND phase IN ('running','queued') AND stop_requested=false RETURNING id",
      [input.messagingJobId, input.accountId, input.storageId, JSON.stringify({ kind: "acquisition_request", request: input.request, storageId: input.storageId }), new Date().toISOString()],
    );
    if (prepared.rowCount !== 1) throw new Error("消息任务已停止或已处理");
    const candidateId = input.request.mediaType === "movie" ? input.request.titleId : `${input.request.titleId}_s${input.request.seasonNumber ?? 1}`;
    const result = await queue(input.accountId, candidateId, input.storageId, input.messagingJobId);
    if (result.status === "already_tracked") return { status: "already_tracked", workflowRunId: null, reused: true, associationCommitted: true };
    if (result.status === "unsupported" || !result.workflowRunId) throw new Error(result.message ?? "无法创建获取任务");
    return { status: "queued", workflowRunId: result.workflowRunId, reused: result.status !== "queued", associationCommitted: true };
  };
}
