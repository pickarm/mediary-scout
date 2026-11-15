import { connection } from "next/server";
import { Suspense } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { LibraryManagement } from "../../../components/library-management";
import type { SafeLibraryStorage } from "../../../components/library-scan-client";
import { DEFAULT_NAMING_TEMPLATES } from "@media-track/workflow/library";
import { getWorkflowRepository, requireAuthenticatedAccountId } from "../../../lib/workflow-runtime";

export default function LibraryManagePage() {
  return <Suspense fallback={<ManageShell busy />}><ManageSurface /></Suspense>;
}

function ManageShell({ busy = false }: { busy?: boolean }) {
  return (
    <div className="app-shell">
      <AppSidebar active="library-manage" />
      <main className="main product-main" aria-busy={busy}>
        <div className="section-heading library-heading"><div><h1>库管理</h1><p>配置光鸭媒体库扫描与查看扫描任务</p></div></div>
      </main>
    </div>
  );
}

async function ManageSurface() {
  await connection();
  const accountId = await requireAuthenticatedAccountId();
  const rows = await getWorkflowRepository().listConnectedStorages(accountId);
  const storages: SafeLibraryStorage[] = rows
    .filter((row) => row.provider === "guangya")
    .map((row) => ({ id: row.id, label: row.label?.trim() || "光鸭网盘", status: row.status }));

  return (
    <div className="app-shell">
      <AppSidebar active="library-manage" />
      <main className="main product-main">
        <div className="section-heading library-heading">
          <div><h1>库管理</h1><p>配置光鸭媒体库扫描与查看扫描任务</p></div>
        </div>
        <LibraryManagement storages={storages} defaultTemplates={DEFAULT_NAMING_TEMPLATES} settingsHref="/settings" />
      </main>
    </div>
  );
}
