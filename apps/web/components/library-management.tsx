"use client";

import { useCallback, useState } from "react";
import { LibraryScanSettings } from "./library-scan-settings";
import { LibraryIdentificationResults } from "./library-identification-results";
import type { SafeLibraryStorage } from "./library-scan-client";
import type { NamingTemplateKind } from "@media-track/workflow/library";

type Selection = { storageId: string | null; configId: string | null; taskId: string | null };
type TemplateSet = Readonly<Record<NamingTemplateKind, string>>;

export function LibraryManagement({ storages, defaultTemplates, settingsHref }: {
  storages: readonly SafeLibraryStorage[];
  defaultTemplates: TemplateSet;
  settingsHref: string;
}) {
  const [selection, setSelection] = useState<Selection>({ storageId: null, configId: null, taskId: null });
  const onSelectionChange = useCallback((next: Selection) => setSelection(next), []);
  const storage = storages.find((item) => item.id === selection.storageId) ?? null;

  return <div className="library-management-stack">
    <LibraryScanSettings storages={storages} defaultTemplates={defaultTemplates} settingsHref={settingsHref} onSelectionChange={onSelectionChange} />
    <LibraryIdentificationResults storageId={selection.storageId} configId={selection.configId} taskId={selection.taskId} frozen={storage?.status !== "active"} />
  </div>;
}
