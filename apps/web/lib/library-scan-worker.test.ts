import { describe, expect, it } from "vitest";
import { createIdentificationDispatcher } from "./library-scan-worker";
import type { ScanScope } from "@media-track/workflow/library";

const a: ScanScope = { accountId: "a", connectedStorageId: "ga" };
const b: ScanScope = { accountId: "b", connectedStorageId: "gb" };
const c: ScanScope = { accountId: "c", connectedStorageId: "gc" };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("library scan worker identification dispatch", () => {
  it("keeps a global concurrency cap and advances queued scopes as batches finish", async () => {
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const dispatcher = createIdentificationDispatcher({ concurrency: 2, canStart: () => true,
      run: async (scope) => { started.push(scope.accountId); await new Promise<void>((resolve) => { release.set(scope.accountId, resolve); }); }, onError: () => undefined });
    dispatcher.enqueue(a); dispatcher.enqueue(b); dispatcher.enqueue(c);
    expect(started).toEqual(["a", "b"]);
    release.get("a")!(); await flush();
    expect(started).toEqual(["a", "b", "c"]);
    release.get("b")!(); release.get("c")!(); await flush();
  });

  it("respects a hold and preserves queued work for the next pump", async () => {
    let allowed = false; const started: string[] = [];
    const dispatcher = createIdentificationDispatcher({ concurrency: 1, canStart: () => allowed,
      run: async (scope) => { started.push(scope.accountId); }, onError: () => undefined });
    dispatcher.enqueue(a);
    expect(started).toEqual([]);
    allowed = true; dispatcher.pump(); await flush();
    expect(started).toEqual(["a"]);
  });

  it("bounds queued scopes and continues from the retained fair queue", async () => {
    const started: string[] = []; const releases: Array<() => void> = [];
    const dispatcher = createIdentificationDispatcher({ concurrency: 1, canStart: () => true,
      run: async (scope) => { started.push(scope.accountId); await new Promise<void>((resolve) => { releases.push(resolve); }); }, onError: () => undefined });
    const scopes = Array.from({ length: 66 }, (_, i) => ({ accountId: `account-${i}`, connectedStorageId: `storage-${i}` }));
    for (const scope of scopes) dispatcher.enqueue(scope);
    expect(started).toEqual(["account-0"]);
    releases[0]!(); await flush();
    expect(started).toEqual(["account-0", "account-1"]);
    expect(started).not.toContain("account-65");
    releases[1]!(); await flush();
  });
});
