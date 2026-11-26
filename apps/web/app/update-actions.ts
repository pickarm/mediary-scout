"use server";

import { isDemoMode } from "../lib/demo-mode";
import { isAutoUpdateTime } from "../lib/auto-update-schedule";
import { readBuildCommit } from "../lib/deployment-update-server";
import { resolveUpdateDistribution } from "../lib/fork-release";
import {
  acquireManualImageCheckSlot,
  fetchRemoteImageStatus,
  invalidateImageUpdateCache,
} from "../lib/image-update-server";
import { invalidateReleaseFeedCache } from "../lib/release-feed-server";
import { resolveCurrentIsOwner } from "../lib/settings-attention-server";
import type { UpdateStatus } from "../lib/update-state";
import { loadUpdateView } from "../lib/update-view-server";
import { requestUpdate } from "../lib/updater-client";

const REASON_TEXT = {
  no_updater: "一键更新需要先完成一次手动升级（见下方命令）。",
  busy: "已经在更新了。",
  needs_recovery: "上次更新回退没成功，请先在部署目录运行 ./scripts/deploy.sh 恢复，再更新。",
  serving_unknown: "部署目录被人手动换过版本。请在部署目录运行 ./scripts/deploy.sh，跑起来之后就能更新。",
  bad_tag: "这个版本不是可更新的新版本，刷新页面再试。",
  unreachable: "连不上更新助手，稍后再试。",
} as const;

export async function startUpdateAction(
  tag: string,
): Promise<{
  ok: boolean;
  message: string;
  reason?:
    | "no_updater"
    | "busy"
    | "needs_recovery"
    | "serving_unknown"
    | "bad_tag"
    | "unreachable"
    | "denied"
    | "stale"
    | "unsupported";
}> {
  if (isDemoMode() || !(await resolveCurrentIsOwner()))
    return { ok: false, message: "没有权限。", reason: "denied" };
  if (resolveUpdateDistribution(process.env) === "fork-image") {
    return {
      ok: false,
      message: "容器镜像部署不支持网页内一键更新，请拉取最新镜像并重建容器。",
      reason: "unsupported",
    };
  }
  // Only the release the view itself offers — never an arbitrary string from the client,
  // and never an older tag (that would be a downgrade).
  const offered = (await loadUpdateView()).available?.tag;
  if (!offered || offered !== tag) return { ok: false, message: REASON_TEXT.bad_tag, reason: "stale" };
  const result = await requestUpdate(offered);
  if (!result.ok) return { ok: false, message: REASON_TEXT[result.reason], reason: result.reason };
  // A click is a person's decision to try again: auto-update may retry a release it gave up on.
  // The update is already running: a failed write here must not report it as not started.
  try {
    const { getWorkflowRepository, AUTO_UPDATE_FAIL_STREAK_SETTING_KEY } = await import("../lib/workflow-runtime");
    await getWorkflowRepository().setSetting(AUTO_UPDATE_FAIL_STREAK_SETTING_KEY, "");
  } catch (error) {
    console.error(`[update] could not clear the auto-update retry count: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, message: "已开始更新。" };
}

/** The 「每天自动更新」 switch and its hour, whole hours in Beijing time. */
export async function saveAutoUpdateAction(enabled: boolean, time: string): Promise<{ ok: boolean; message: string }> {
  if (isDemoMode() || !(await resolveCurrentIsOwner())) return { ok: false, message: "没有权限。" };
  if (resolveUpdateDistribution(process.env) === "fork-image") {
    return { ok: false, message: "容器镜像部署不支持网页内自动更新。" };
  }
  if (!isAutoUpdateTime(time)) return { ok: false, message: "时间只能选整点。" };
  const { getWorkflowRepository, AUTO_UPDATE_ENABLED_SETTING_KEY, AUTO_UPDATE_TIME_SETTING_KEY } = await import(
    "../lib/workflow-runtime"
  );
  const repository = getWorkflowRepository();
  // Two separate writes: order them so a failure part way leaves updates off, never on at
  // an hour nobody chose. On: hour first, then the switch. Off: the switch first.
  if (enabled) {
    await repository.setSetting(AUTO_UPDATE_TIME_SETTING_KEY, time);
    await repository.setSetting(AUTO_UPDATE_ENABLED_SETTING_KEY, "1");
  } else {
    await repository.setSetting(AUTO_UPDATE_ENABLED_SETTING_KEY, "0");
    await repository.setSetting(AUTO_UPDATE_TIME_SETTING_KEY, time);
  }
  return { ok: true, message: "已保存。" };
}

export interface CheckForUpdatesResult {
  ok: boolean;
  throttled?: boolean;
  status?: UpdateStatus;
  message: string;
}

let lastManualCheck = 0;

/** 「检查更新」: force-refresh GHCR image status in `fork-image` mode (15s cooldown),
 *  or drop the cached release list in `local-source` mode (60s cooldown). */
export async function checkForUpdatesAction(): Promise<CheckForUpdatesResult> {
  if (isDemoMode() || !(await resolveCurrentIsOwner())) {
    return { ok: false, message: "没有权限。" };
  }

  if (resolveUpdateDistribution(process.env) === "fork-image") {
    const slot = acquireManualImageCheckSlot(Date.now());
    if (!slot.allowed) {
      return { ok: true, throttled: true, message: "刚刚已检查过，请稍后再试。" };
    }
    invalidateImageUpdateCache();
    invalidateReleaseFeedCache();
    const [remote, currentCommit] = await Promise.all([
      fetchRemoteImageStatus({ force: true }),
      readBuildCommit(),
    ]);
    if (!remote.ok) {
      if (remote.reason === "unauthorized") {
        return {
          ok: false,
          status: "offline",
          message: "镜像仓库需要认证或未公开，请将包设为 Public。",
        };
      }
      if (remote.reason === "not_found") {
        return {
          ok: false,
          status: "offline",
          message: "远端未找到镜像标签，请核对镜像名称与标签。",
        };
      }
      if (remote.reason === "invalid_ref") {
        return {
          ok: false,
          status: "offline",
          message: "镜像配置格式无效，请检查环境变量。",
        };
      }
      return {
        ok: false,
        status: "offline",
        message: "暂时无法连接镜像仓库，请稍后再试。",
      };
    }
    if (!currentCommit) {
      return {
        ok: true,
        status: "unknown",
        message: "已刷新远端镜像信息（本地开发构建无法比对）。",
      };
    }
    if (!remote.commit) {
      return {
        ok: true,
        status: "unknown",
        message: "远端镜像缺少提交信息，无法比对版本。",
      };
    }
    if (remote.commit !== currentCommit) {
      return {
        ok: true,
        status: "available",
        message: "检测到新镜像，请更新容器。",
      };
    }
    return {
      ok: true,
      status: "latest",
      message: "已是最新镜像。",
    };
  }

  if (Date.now() - lastManualCheck < 60_000) {
    return { ok: true, throttled: true, message: "刚刚已检查过，请稍后再试。" };
  }
  lastManualCheck = Date.now();
  invalidateReleaseFeedCache();
  return { ok: true, message: "已重新检查更新。" };
}
