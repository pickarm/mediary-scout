import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/demo-mode", () => ({ isDemoMode: vi.fn(() => false) }));
vi.mock("../lib/settings-attention-server", () => ({ resolveCurrentIsOwner: vi.fn(async () => true) }));
vi.mock("../lib/update-view-server", () => ({ loadUpdateView: vi.fn() }));
vi.mock("../lib/updater-client", () => ({ requestUpdate: vi.fn() }));
vi.mock("../lib/release-feed-server", () => ({ invalidateReleaseFeedCache: vi.fn() }));
vi.mock("../lib/deployment-update-server", () => ({ readBuildCommit: vi.fn() }));
vi.mock("../lib/image-update-server", async () => {
  const actual = await vi.importActual<typeof import("../lib/image-update-server")>("../lib/image-update-server");
  return {
    ...actual,
    fetchRemoteImageStatus: vi.fn(),
    invalidateImageUpdateCache: vi.fn(),
  };
});
const settings = vi.hoisted(() => new Map<string, string>());
/** Keys that fail to write (simulates a DB error part way through a save). */
const failingWrites = vi.hoisted(() => new Set<string>());
vi.mock("../lib/workflow-runtime", () => ({
  AUTO_UPDATE_ENABLED_SETTING_KEY: "auto_update_enabled",
  AUTO_UPDATE_TIME_SETTING_KEY: "auto_update_time",
  AUTO_UPDATE_FAIL_STREAK_SETTING_KEY: "auto_update_fail_streak",
  getWorkflowRepository: () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => {
      if (failingWrites.has(key)) throw new Error(`write ${key} failed`);
      settings.set(key, value);
    },
  }),
}));

import { isDemoMode } from "../lib/demo-mode";
import { readBuildCommit } from "../lib/deployment-update-server";
import {
  __resetImageUpdateCacheForTests,
  fetchRemoteImageStatus,
  invalidateImageUpdateCache,
} from "../lib/image-update-server";
import { invalidateReleaseFeedCache } from "../lib/release-feed-server";
import { resolveCurrentIsOwner } from "../lib/settings-attention-server";
import { loadUpdateView } from "../lib/update-view-server";
import { requestUpdate } from "../lib/updater-client";
import { checkForUpdatesAction, saveAutoUpdateAction, startUpdateAction } from "./update-actions";

describe("fork-image mode refusals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.clear();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(true);
  });

  it("refuses startUpdateAction and saveAutoUpdateAction by default (fork-image)", async () => {
    expect(await startUpdateAction("latest")).toEqual({
      ok: false,
      message: "容器镜像部署不支持网页内一键更新，请拉取最新镜像并重建容器。",
      reason: "unsupported",
    });
    expect(requestUpdate).not.toHaveBeenCalled();

    expect(await saveAutoUpdateAction(true, "04:00")).toEqual({
      ok: false,
      message: "容器镜像部署不支持网页内自动更新。",
    });
    expect(settings.size).toBe(0);
  });
});

describe("startUpdateAction (local-source)", () => {
  beforeEach(() => {
    vi.stubEnv("MEDIA_TRACK_DISTRIBUTION", "local-source");
    vi.clearAllMocks();
    settings.clear();
    failingWrites.clear();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards only the tag the current view offers", async () => {
    vi.mocked(loadUpdateView).mockResolvedValue({ available: { tag: "v2026.10.02" } } as never);
    vi.mocked(requestUpdate).mockResolvedValue({ ok: true });
    expect(await startUpdateAction("v2026.09.28")).toEqual({
      ok: false,
      message: "这个版本不是可更新的新版本，刷新页面再试。",
      reason: "stale",
    });
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(await startUpdateAction("v2026.10.02")).toEqual({ ok: true, message: "已开始更新。" });
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    expect(requestUpdate).toHaveBeenCalledWith("v2026.10.02");
  });

  it("an update the updater accepted is reported as started even if clearing the retry count fails", async () => {
    failingWrites.add("auto_update_fail_streak");
    vi.mocked(loadUpdateView).mockResolvedValue({ available: { tag: "v2026.10.02" } } as never);
    vi.mocked(requestUpdate).mockResolvedValue({ ok: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await startUpdateAction("v2026.10.02")).toEqual({ ok: true, message: "已开始更新。" });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("marks the demo and non-owner refusals as denied", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    expect(await startUpdateAction("v2026.10.02")).toEqual({
      ok: false,
      message: "没有权限。",
      reason: "denied",
    });
    expect(loadUpdateView).not.toHaveBeenCalled();
    expect(resolveCurrentIsOwner).not.toHaveBeenCalled();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(false);
    expect(await startUpdateAction("v2026.10.02")).toEqual({
      ok: false,
      message: "没有权限。",
      reason: "denied",
    });
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("passes the updater's own reason through with its text", async () => {
    vi.mocked(loadUpdateView).mockResolvedValue({ available: { tag: "v2026.10.02" } } as never);
    for (const [reason, message] of [
      ["busy", "已经在更新了。"],
      ["no_updater", "一键更新需要先完成一次手动升级（见下方命令）。"],
      ["needs_recovery", "上次更新回退没成功，请先在部署目录运行 ./scripts/deploy.sh 恢复，再更新。"],
      ["serving_unknown", "部署目录被人手动换过版本。请在部署目录运行 ./scripts/deploy.sh，跑起来之后就能更新。"],
      ["bad_tag", "这个版本不是可更新的新版本，刷新页面再试。"],
      ["unreachable", "连不上更新助手，稍后再试。"],
    ] as const) {
      vi.mocked(requestUpdate).mockResolvedValue({ ok: false, reason });
      expect(await startUpdateAction("v2026.10.02")).toEqual({ ok: false, message, reason });
    }
  });
});

describe("startUpdateAction and the auto-update failure count (local-source)", () => {
  beforeEach(() => {
    vi.stubEnv("MEDIA_TRACK_DISTRIBUTION", "local-source");
    vi.clearAllMocks();
    settings.clear();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(true);
    vi.mocked(loadUpdateView).mockResolvedValue({ available: { tag: "v2026.10.02" } } as never);
    settings.set("auto_update_fail_streak", JSON.stringify({ tag: "v2026.10.02", count: 2, at: "x" }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a click that starts an update lets auto-update try again", async () => {
    vi.mocked(requestUpdate).mockResolvedValue({ ok: true });
    await startUpdateAction("v2026.10.02");
    expect(settings.get("auto_update_fail_streak")).toBe("");
  });

  it("a click that did not start anything keeps the count", async () => {
    vi.mocked(requestUpdate).mockResolvedValue({ ok: false, reason: "busy" });
    await startUpdateAction("v2026.10.02");
    await startUpdateAction("v2026.09.28"); // stale tag: never reaches the updater
    expect(JSON.parse(settings.get("auto_update_fail_streak") ?? "")).toMatchObject({ count: 2 });
  });
});

describe("saveAutoUpdateAction (local-source)", () => {
  beforeEach(() => {
    vi.stubEnv("MEDIA_TRACK_DISTRIBUTION", "local-source");
    vi.clearAllMocks();
    settings.clear();
    failingWrites.clear();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("saves the switch and the hour", async () => {
    expect(await saveAutoUpdateAction(true, "03:00")).toEqual({ ok: true, message: "已保存。" });
    expect(settings.get("auto_update_enabled")).toBe("1");
    expect(settings.get("auto_update_time")).toBe("03:00");
    expect(await saveAutoUpdateAction(false, "23:00")).toEqual({ ok: true, message: "已保存。" });
    expect(settings.get("auto_update_enabled")).toBe("0");
    expect(settings.get("auto_update_time")).toBe("23:00");
    expect((await saveAutoUpdateAction(true, "00:00")).ok).toBe(true);
  });

  it("a save that fails half way never leaves updates switched on at an hour nobody chose", async () => {
    settings.set("auto_update_enabled", "0");
    settings.set("auto_update_time", "04:00");
    failingWrites.add("auto_update_time");
    await expect(saveAutoUpdateAction(true, "13:00")).rejects.toThrow();
    expect(settings.get("auto_update_enabled")).toBe("0");
    failingWrites.clear();
    expect(await saveAutoUpdateAction(true, "13:00")).toEqual({ ok: true, message: "已保存。" });
    failingWrites.add("auto_update_time");
    await expect(saveAutoUpdateAction(false, "05:00")).rejects.toThrow();
    expect(settings.get("auto_update_enabled")).toBe("0");
  });

  it("takes whole hours only", async () => {
    for (const time of ["04:30", "24:00", "4:00", "04:00 ", "", "04", "ab:cd"]) {
      expect(await saveAutoUpdateAction(true, time)).toEqual({ ok: false, message: "时间只能选整点。" });
    }
    expect(settings.size).toBe(0);
  });

  it("refuses the demo and non-owners without writing anything", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    expect(await saveAutoUpdateAction(true, "04:00")).toEqual({ ok: false, message: "没有权限。" });
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(false);
    expect(await saveAutoUpdateAction(true, "04:00")).toEqual({ ok: false, message: "没有权限。" });
    expect(settings.size).toBe(0);
  });
});

describe("checkForUpdatesAction", () => {
  beforeEach(() => {
    __resetImageUpdateCacheForTests();
    vi.clearAllMocks();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(true);
    vi.mocked(readBuildCommit).mockResolvedValue("a".repeat(40));
    vi.mocked(fetchRemoteImageStatus).mockResolvedValue({
      ok: true,
      registry: "ghcr.io",
      repository: "pickarm/mediary-scout",
      tag: "latest",
      fullRef: "ghcr.io/pickarm/mediary-scout:latest",
      manifestDigest: "sha256:1",
      configDigest: "sha256:2",
      commit: "b".repeat(40),
      version: "edge",
      createdAt: "2026-11-26T00:00:00Z",
      sourceUrl: "https://github.com/pickarm/mediary-scout",
      checkedAt: "2026-11-26T00:00:00Z",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("invalidates GHCR cache, forces refresh with 15s cooldown, and returns structured status", async () => {
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    const first = await checkForUpdatesAction();
    expect(first).toEqual({
      ok: true,
      status: "available",
      message: "检测到新镜像，请更新容器。",
    });
    expect(invalidateImageUpdateCache).toHaveBeenCalledTimes(1);
    expect(invalidateReleaseFeedCache).toHaveBeenCalledTimes(1);
    expect(fetchRemoteImageStatus).toHaveBeenCalledWith({ force: true });

    const throttled = await checkForUpdatesAction();
    expect(throttled).toEqual({
      ok: true,
      throttled: true,
      message: "刚刚已检查过，请稍后再试。",
    });
    expect(invalidateImageUpdateCache).toHaveBeenCalledTimes(1);

    clock += 16_000;
    vi.mocked(readBuildCommit).mockResolvedValue("b".repeat(40));
    const latest = await checkForUpdatesAction();
    expect(latest).toEqual({ ok: true, status: "latest", message: "已是最新镜像。" });
    expect(invalidateImageUpdateCache).toHaveBeenCalledTimes(2);
  });

  it("returns unauthorized / not_found / unreachable messages cleanly", async () => {
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    vi.mocked(fetchRemoteImageStatus).mockResolvedValueOnce({
      ok: false,
      reason: "unauthorized",
      statusCode: 401,
      checkedAt: "2026-11-26T00:00:00Z",
    });
    expect(await checkForUpdatesAction()).toEqual({
      ok: false,
      status: "offline",
      message: "镜像仓库需要认证或未公开，请将包设为 Public。",
    });

    clock += 16_000;
    vi.mocked(fetchRemoteImageStatus).mockResolvedValueOnce({
      ok: false,
      reason: "not_found",
      statusCode: 404,
      checkedAt: "2026-11-26T00:00:00Z",
    });
    expect(await checkForUpdatesAction()).toEqual({
      ok: false,
      status: "offline",
      message: "远端未找到镜像标签，请核对镜像名称与标签。",
    });
  });

  it("drops the cached release list at most once a minute in local-source mode", async () => {
    vi.stubEnv("MEDIA_TRACK_DISTRIBUTION", "local-source");
    const now = vi.spyOn(Date, "now");
    let clock = 1_700_000_000_000;
    now.mockImplementation(() => clock);
    await checkForUpdatesAction();
    await checkForUpdatesAction();
    expect(invalidateReleaseFeedCache).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await checkForUpdatesAction();
    expect(invalidateReleaseFeedCache).toHaveBeenCalledTimes(2);
    vi.mocked(resolveCurrentIsOwner).mockResolvedValue(false);
    clock += 61_000;
    expect(await checkForUpdatesAction()).toEqual({ ok: false, message: "没有权限。" });
    expect(invalidateReleaseFeedCache).toHaveBeenCalledTimes(2);
  });
});
