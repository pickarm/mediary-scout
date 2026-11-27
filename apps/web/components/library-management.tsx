"use client";

import { useCallback, useState } from "react";
import { LibraryScanSettings, type LibraryWorkspaceTab } from "./library-scan-settings";
import { LibraryIdentificationResults } from "./library-identification-results";
import { LibraryOrganization } from "./library-organization";
import { LibraryOrganizationHistory } from "./library-organization-history";
import type { SafeLibraryStorage } from "./library-scan-client";
import type { NamingTemplateKind } from "@media-track/workflow/library";
import styles from "./library-management.module.css";

type Selection = { storageId: string | null; configId: string | null; taskId: string | null; dirty: boolean };
type TemplateSet = Readonly<Record<NamingTemplateKind, string>>;

const WORKSPACE_TABS: readonly { id: LibraryWorkspaceTab; label: string }[] = [
  { id: "organize", label: "库整理" },
  { id: "pending", label: "待确认与扫描任务" },
];

export function LibraryManagement({ storages, defaultTemplates, settingsHref }: {
  storages: readonly SafeLibraryStorage[];
  defaultTemplates: TemplateSet;
  settingsHref: string;
}) {
  const [selection, setSelection] = useState<Selection>({ storageId: null, configId: null, taskId: null, dirty: false });
  const [activeTab, setActiveTab] = useState<LibraryWorkspaceTab>("organize");
  const [historyRefreshTrigger, setHistoryRefreshTrigger] = useState(0);
  const onSelectionChange = useCallback((next: Selection) => setSelection(next), []);
  const onScanStarted = useCallback(() => setHistoryRefreshTrigger((count) => count + 1), []);
  const storage = storages.find((item) => item.id === selection.storageId) ?? null;
  const frozen = storage?.status === "frozen";

  return (
    <div className="library-management-stack">
      <nav className={styles.tabsBar} role="tablist" aria-label="库管理工作区">
        {WORKSPACE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`${styles.tabButton} ${activeTab === tab.id ? styles.tabButtonActive : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <LibraryScanSettings
        storages={storages}
        defaultTemplates={defaultTemplates}
        settingsHref={settingsHref}
        activeTab={activeTab}
        onSwitchTab={setActiveTab}
        onScanStarted={onScanStarted}
        onSelectionChange={onSelectionChange}
      />

      {activeTab === "organize" && (
        <LibraryOrganizationHistory
          storageId={selection.storageId}
          refreshTrigger={historyRefreshTrigger}
        />
      )}

      {activeTab === "pending" && (
        <>
          <LibraryIdentificationResults
            storageId={selection.storageId}
            configId={selection.configId}
            taskId={selection.taskId}
            frozen={frozen}
          />
          <LibraryOrganization
            storageId={selection.storageId}
            configId={selection.configId}
            taskId={selection.taskId}
            dirty={selection.dirty}
            frozen={frozen}
          />
        </>
      )}
    </div>
  );
}
