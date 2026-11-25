import { createTmdbSearchProvider, isRegisteredStorageProvider, type WorkflowStatus } from "@media-track/workflow";
import { getWorkflowRepository, getAccountScopedSettings, getTmdbAccesses, queueCandidateTrackingForAccount } from "../workflow-runtime";
import { getLibraryPool } from "../library-runtime";
import type { MessagingCommandPorts, MessagingTaskStatus, MessagingTaskSummary } from "./commands";
import { createMessagingSearch } from "./search";
import { createMessagingEnqueue } from "./enqueue";
import type { PostgresMessagingStore, MessagingJob } from "./store";

const PHASE_LABELS: Record<string, string> = {
  received: "已收到", running: "处理中", queued: "排队中", pending_selection: "等待选择", direct_pending: "待转存",
  submitted: "已提交网盘", transferring: "转存中", verifying: "核实落盘", identifying: "识别中", organizing: "整理中",
  completed: "已完成", succeeded: "已完成", partial: "部分完成", no_coverage: "暂未找到资源", failed: "失败", stopped: "已停止", reserved: "等待上映",
};

export function messagingPhaseLabel(phase: string): string { return PHASE_LABELS[phase] ?? "处理中"; }

export function createMessagingApplication(store: PostgresMessagingStore): MessagingCommandPorts {
  const repository = getWorkflowRepository();
  const summarize = async (job: MessagingJob): Promise<MessagingTaskSummary> => {
    const snapshot = job.workflowRunId ? await repository.getWorkflowRunSnapshot(job.workflowRunId, job.accountId) : null;
    const phase = snapshot?.workflowRun.status ?? job.phase;
    const status: MessagingTaskStatus = isTaskStatus(phase) ? phase : "queued";
    return {
      id: job.workflowRunId ?? job.id, messagingJobId: job.id,
      title: snapshot?.title.title ?? job.text.slice(0, 80), status,
      source: job.inputKind === "direct_link" ? "direct_transfer" : "acquisition",
      activity: messagingPhaseLabel(phase), ...(job.result ? { result: job.result } : {}), error: job.error,
    };
  };
  return {
    search: createMessagingSearch(async (accountId) => createTmdbSearchProvider(await getTmdbAccesses(getAccountScopedSettings(accountId)))),
    enqueue: createMessagingEnqueue(getLibraryPool(), queueCandidateTrackingForAccount),
    listStorages: async (accountId) => (await repository.listConnectedStorages(accountId))
      .filter((s) => s.status === "active" && isRegisteredStorageProvider(s.provider))
      .map((s) => ({ id: s.id, label: s.label ?? s.provider })),
    query: async ({ accountId, id }) => {
      const recent = await store.listRecent(accountId, 100);
      const jobs = recent.filter((job) => job.workflowRunId || job.inputKind === "direct_link" || job.phase === "pending_selection" || job.result?.kind === "already_tracked");
      const selected = id ? jobs.filter((j) => j.id === id || j.workflowRunId === id) : jobs.slice(0, 10);
      if (id && !selected.length) {
        const direct = await store.get(accountId, id);
        if (direct) selected.push(direct);
      }
      return Promise.all(selected.map(summarize));
    },
    stop: async ({ accountId, id }) => {
      const message = await store.get(accountId, id);
      const runId = message?.workflowRunId ?? id;
      let snapshot = await repository.getWorkflowRunSnapshot(runId, accountId);
      if (!snapshot) return { taskId: id, stopped: false, reason: "not_found" };
      if (snapshot.workflowRun.status === "queued") {
        const cancelled = await repository.cancelQueuedWorkflowRun(runId, accountId);
        if (cancelled.status === "cancelled") {
          await getLibraryPool().query(
            "UPDATE messaging_jobs SET phase='stopped', stop_requested=true, result=$3::jsonb, send_status='not_applicable', updated_at=$4 WHERE account_id=$1 AND workflow_run_id=$2 AND phase='queued'",
            [accountId, runId, JSON.stringify({ kind: "acquisition_result", status: "stopped", text: "原获取排队任务已取消。" }), new Date().toISOString()],
          );
          return { taskId: id, stopped: true, reason: "queued_cancelled" };
        }
        snapshot = await repository.getWorkflowRunSnapshot(runId, accountId);
        if (!snapshot) return { taskId: id, stopped: false, reason: "not_found" };
      }
      return { taskId: id, stopped: false, reason: snapshot.workflowRun.status === "running" ? "running_original" : "finished" };
    },
  };
}

function isTaskStatus(value: string): value is MessagingTaskStatus {
  const native: readonly WorkflowStatus[] = ["queued", "running", "succeeded", "failed", "partial", "no_coverage", "reserved"];
  return native.some((s) => s === value) || ["direct_pending", "submitted", "transferring", "verifying", "identifying", "organizing", "completed", "stopped"].includes(value);
}
