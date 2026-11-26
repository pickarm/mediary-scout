import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { globalNavHref } from "@media-track/workflow";
import { AppSidebar } from "../../components/app-sidebar";
import { GitHubNameplate } from "../../components/github-nameplate";
import { SystemInfoPanel } from "../../components/system-info-panel";
import { isDemoMode } from "../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../lib/settings-attention-server";
import { collectSystemInfo } from "../../lib/system-info-server";
import {
  hasLoginPassword,
  isMultiUserEnabled,
  resolveGlobalWorkspace,
  UNAUTHENTICATED_ACCOUNT_ID,
} from "../../lib/workflow-runtime";

export default function SystemPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <Suspense fallback={<SystemShell />}>
      <SystemSurface searchParams={searchParams} />
    </Suspense>
  );
}

function SystemShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="system" />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function SystemSurface({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  await connection();
  if (!isDemoMode() && !isMultiUserEnabled() && process.env.MEDIA_TRACK_DESKTOP !== "1") {
    if ((await hasLoginPassword()) !== true) {
      redirect("/login");
    }
  }
  const { w } = await searchParams;
  const workspace = await resolveGlobalWorkspace(w);
  if (!isDemoMode() && isMultiUserEnabled() && workspace.accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    redirect("/login");
  }

  const canViewInfraDetails = isDemoMode() ? false : await resolveCurrentIsOwner();
  const snapshot = await collectSystemInfo({
    accountId: workspace.accountId,
    canViewInfraDetails,
  });

  const libraryHref = workspace.basePath === "/" ? "/?tab=library" : `${workspace.basePath}?tab=library`;
  const settingsBase = globalNavHref("/settings", workspace.activeStorageId);
  const settingsUpdateHref = `${settingsBase}${settingsBase.includes("?") ? "&" : "?"}tab=update`;

  return (
    <div className="app-shell">
      <AppSidebar active="system" basePath={workspace.basePath} activeStorageId={workspace.activeStorageId} />
      <main className="main product-main">
        <div className="section-heading library-heading">
          <div>
            <h1>系统信息</h1>
            <p>查看数据库连接、Redis 缓存、系统版本、持续运行时间与入库影片统计</p>
          </div>
        </div>
        <SystemInfoPanel
          initial={snapshot}
          libraryHref={libraryHref}
          settingsUpdateHref={settingsUpdateHref}
        />
        <GitHubNameplate />
      </main>
    </div>
  );
}
