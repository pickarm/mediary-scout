import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutorForBrand } from "./storage-executor-factory.js";
import { withStorageWriteTask } from "./library/guangya-write-coordinator.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("GuangYa factory write coordination", () => {
  it("uses providerUid and locks standalone executor writes around the full method", async () => {
    const calls: string[] = [];
    const fakeCoordinator = {
      run: async <T>(keys: readonly string[], fn: () => Promise<T>) => {
        calls.push(`run:${keys.join(",")}`);
        return fn();
      },
      assertHeld: async (key: string) => { calls.push(`assert:${key}`); },
    };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url.includes("get_file_list") ? "read" : "write");
      return new Response(JSON.stringify(url.includes("get_file_list")
        ? { msg: "success", data: { list: [] } }
        : { msg: "success", data: { fileId: "new-dir" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const executor = createExecutorForBrand({
      provider: "guangya",
      providerUid: "physical-uid",
      credential: { accessToken: "header.eyJzdWIiOiJ0b2tlbi11aWQifQ.signature", refreshToken: "refresh" },
      scopeCids: [],
      writeCoordinator: fakeCoordinator,
      env: { MEDIA_TRACK_GUANGYA_MIN_INTERVAL_MS: "0" },
    });

    await withStorageWriteTask([executor], async () => { calls.push("task-start"); });
    await expect(executor.createDirectory({ parentId: "", name: "Movies" })).resolves.toBe("new-dir");
    expect(calls).toEqual([
      "run:guangya:physical-uid",
      "task-start",
      "run:guangya:physical-uid",
      "read",
      "assert:guangya:physical-uid",
      "write",
    ]);
  });

  it("fails closed when multiple executor coordinators do not match", async () => {
    const first = { run: async <T>(_keys: readonly string[], fn: () => Promise<T>) => fn(), assertHeld: async () => {} };
    const second = { run: async <T>(_keys: readonly string[], fn: () => Promise<T>) => fn(), assertHeld: async () => {} };
    const make = (writeCoordinator: typeof first) => createExecutorForBrand({
      provider: "guangya",
      providerUid: "same-account",
      credential: { accessToken: "header.eyJzdWIiOiJ0b2tlbi11aWQifQ.signature", refreshToken: "refresh" },
      scopeCids: [],
      writeCoordinator,
    });
    await expect(withStorageWriteTask([make(first), make(second)], async () => {})).rejects.toThrow("GUANGYA_WRITE_COORDINATOR_MISMATCH");
  });

  it("uses the factory's PG environment when process.env has no database URL", async () => {
    vi.stubEnv("MEDIA_TRACK_POSTGRES_URL", "");
    const executor = createExecutorForBrand({
      provider: "guangya",
      providerUid: "env-account",
      credential: { accessToken: "header.eyJzdWIiOiJ0b2tlbi11aWQifQ.signature", refreshToken: "refresh" },
      scopeCids: [],
      env: { MEDIA_TRACK_POSTGRES_URL: "postgresql://127.0.0.1:1/postgres?connect_timeout=1" },
    });
    let callbackRan = false;
    await expect(withStorageWriteTask([executor], async () => { callbackRan = true; })).rejects.toBeDefined();
    expect(callbackRan).toBe(false);
  });
});
