"use client";

import { useCallback, useState } from "react";
import { LibraryScanSettings, type LibraryWorkspaceTab } from "./library-scan-settings";
import { LibraryIdentificationResults } from "./library-identification-results";
import { LibraryOrganization } from "./library-organization";
import type { SafeLibraryStorage } from "./library-scan-client";
import type { NamingTemplateKind } from "@media-track/workflow/library";
import styles from "./library-management.module.css";

type Selection = { storageId: string | null; configId: string | null; taskId: string | null; dirty: boolean };
type TemplateSet = Readonly<Record<NamingTemplateKind, string>>;

const WORKSPACE_TABS: readonly { id: LibraryWorkspaceTab; label: string }[] = [
  { id: "rules", label: "整理规则与命名工坊" },
  { id: "history", label: "整理历史记录" },
  { id: "pending", label: "存量扫描与待确认" },
];

export function LibraryManagement({ storages, defaultTemplates, settingsHref }: {
  storages: readonly SafeLibraryStorage[];
  defaultTemplates: TemplateSet;
  settingsHref: string;
}) {
  const [selection, setSelection] = useState<Selection>({ storageId: null, configId: null, taskId: null, dirty: false });
  const [activeTab, setActiveTab] = useState<LibraryWorkspaceTab>("rules");
  const onSelectionChange = useCallback((next: Selection) => setSelection(next), []);
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
        onSelectionChange={onSelectionChange}
      />

      {activeTab === "pending" && (
        <LibraryIdentificationResults
          storageId={selection.storageId}
          configId={selection.configId}
          taskId={selection.taskId}
          frozen={frozen}
        />
      )}

      {activeTab === "history" && (
        <LibraryOrganization
          storageId={selection.storageId}
          configId={selection.configId}
          taskId={selection.taskId}
          dirty={selection.dirty}
          frozen={frozen}
        />
      )}
    </div>
  );
}
