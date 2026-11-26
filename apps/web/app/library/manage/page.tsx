import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { LibraryManagement } from "../../../components/library-management";
import type { SafeLibraryStorage } from "../../../components/library-scan-client";
import { getStorageBrand, isRegisteredStorageProvider } from "@media-track/workflow";
import { DEFAULT_NAMING_TEMPLATES } from "@media-track/workflow/library";
import { isDemoMode } from "../../../lib/demo-mode";
import {
  getWorkflowRepository,
  hasLoginPassword,
  isMultiUserEnabled,
  requireAuthenticatedAccountId,
  UnauthenticatedAccountError,
} from "../../../lib/workflow-runtime";

export default function LibraryManagePage() {
  return <Suspense fallback={<ManageShell busy />}><ManageSurface /></Suspense>;
}

function ManageShell({ busy = false }: { busy?: boolean }) {
  return (
    <div className="app-shell">
      <AppSidebar active="library-manage" />
      <main className="main product-main" aria-busy={busy}>
        <div className="section-heading library-heading"><div><h1>库管理</h1><p>配置网盘媒体库扫描与查看扫描任务</p></div></div>
      </main>
    </div>
  );
}

async function ManageSurface() {
  await connection();
  if (!isDemoMode() && !isMultiUserEnabled() && process.env.MEDIA_TRACK_DESKTOP !== "1") {
    if ((await hasLoginPassword()) !== true) {
      redirect("/login");
    }
  }
  let accountId: string;
  try {
    accountId = await requireAuthenticatedAccountId();
  } catch (error) {
    if (error instanceof UnauthenticatedAccountError) {
      redirect("/login");
    }
    throw error;
  }
  const rows = await getWorkflowRepository().listConnectedStorages(accountId);
  const storages = libraryStorageChoices(rows);

  return (
    <div className="app-shell">
      <AppSidebar active="library-manage" />
      <main className="main product-main">
        <div className="section-heading library-heading">
          <div><h1>库管理</h1><p>配置网盘媒体库扫描与查看扫描任务</p></div>
        </div>
        <LibraryManagement storages={storages} defaultTemplates={DEFAULT_NAMING_TEMPLATES} settingsHref="/settings" />
      </main>
    </div>
  );
}

interface ConnectedStorageChoiceRow {
  id: string;
  provider: string;
  label: string | null;
  status: "active" | "frozen";
}

export function libraryStorageChoices(rows: readonly ConnectedStorageChoiceRow[]): SafeLibraryStorage[] {
  return rows
    .filter((row): row is ConnectedStorageChoiceRow & { provider: ReturnType<typeof getStorageBrand>["provider"] } => isRegisteredStorageProvider(row.provider))
    .map((row) => {
      const brand = getStorageBrand(row.provider);
      const customLabel = row.label?.trim();
      return {
        id: row.id,
        provider: row.provider,
        label: customLabel ? `${brand.label}（${customLabel}）` : brand.label,
        status: row.status,
        rootDirectoryId: brand.provisionRootId,
      };
    });
}
