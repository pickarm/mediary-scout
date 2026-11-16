"use client";

import { useCallback, useState } from "react";
import { LibraryScanSettings } from "./library-scan-settings";
import { LibraryIdentificationResults } from "./library-identification-results";
import { LibraryOrganization } from "./library-organization";
import type { SafeLibraryStorage } from "./library-scan-client";
import type { NamingTemplateKind } from "@media-track/workflow/library";

type Selection = { storageId: string | null; configId: string | null; taskId: string | null; dirty: boolean };
type TemplateSet = Readonly<Record<NamingTemplateKind, string>>;

export function LibraryManagement({ storages, defaultTemplates, settingsHref }: {
  storages: readonly SafeLibraryStorage[];
  defaultTemplates: TemplateSet;
  settingsHref: string;
}) {
  const [selection, setSelection] = useState<Selection>({ storageId: null, configId: null, taskId: null, dirty: false });
  const onSelectionChange = useCallback((next: Selection) => setSelection(next), []);
  const storage = storages.find((item) => item.id === selection.storageId) ?? null;
  const frozen = storage?.status === "frozen";

  return <div className="library-management-stack">
    <LibraryScanSettings storages={storages} defaultTemplates={defaultTemplates} settingsHref={settingsHref} onSelectionChange={onSelectionChange} />
    <LibraryIdentificationResults storageId={selection.storageId} configId={selection.configId} taskId={selection.taskId} frozen={frozen} />
    <LibraryOrganization storageId={selection.storageId} configId={selection.configId} taskId={selection.taskId} dirty={selection.dirty} frozen={frozen} />
  </div>;
}
