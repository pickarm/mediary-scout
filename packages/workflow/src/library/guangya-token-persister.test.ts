import { describe, expect, it, vi } from "vitest";
import { createGuangYaTokenPersister } from "./guangya-token-persister.js";

const snapshot = {
  accountId: "account-1",
  connectedStorageId: "storage-1",
  providerUid: "uid-1",
  credentials: { accessToken: "a0", refreshToken: "r0", deviceId: "d0" },
};

describe("GuangYa token CAS persister", () => {
  it("advances its expected credential tuple after each successful CAS", async () => {
    const query = vi.fn(async (_sql: string, _values: readonly unknown[]) => ({ rowCount: 1 }));
    const persist = createGuangYaTokenPersister(query, snapshot);

    await expect(persist({ accessToken: "a1", refreshToken: "r1", deviceId: "d0" })).resolves.toBe(true);
    await expect(persist({ accessToken: "a2", refreshToken: "r2", deviceId: "d0" })).resolves.toBe(true);
    expect(query).toHaveBeenNthCalledWith(2, expect.any(String), [
      "storage-1", "account-1", "uid-1", "a1", "r1", "d0", "", "active", "a2", "r2", "d0",
    ]);
  });

  it("reports a lost CAS without advancing its expected tuple", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 });
    const persist = createGuangYaTokenPersister(query, snapshot);

    await expect(persist({ accessToken: "stale", refreshToken: "stale-r", deviceId: "d0" })).resolves.toBe(false);
    await expect(persist({ accessToken: "a1", refreshToken: "r1", deviceId: "d0" })).resolves.toBe(true);
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [
      "storage-1", "account-1", "uid-1", "a0", "r0", "d0", "", "active", "a1", "r1", "d0",
    ]);
  });

  it("uses the caller's observed marker and raw legacy device value for each CAS", async () => {
    const query = vi.fn(async () => ({ rowCount: 1 }));
    const persist = createGuangYaTokenPersister(query, {
      ...snapshot,
      credentials: { accessToken: "a0", refreshToken: "r0", deviceId: null },
      connectionMarker: "bind-0",
    });
    const observed = {
      ...snapshot,
      credentials: { accessToken: "a1", refreshToken: "r1", deviceId: null },
      connectionMarker: "bind-1",
    };

    await expect(persist({ accessToken: "a2", refreshToken: "r2", deviceId: "runtime-did" }, observed)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("connectedAt"), [
      "storage-1", "account-1", "uid-1", "a1", "r1", null, "bind-1", "active", "a2", "r2", "runtime-did",
    ]);
  });

  it("persists a refresh for an explicit frozen probe without changing row status", async () => {
    const query = vi.fn(async (_sql: string, _values: readonly unknown[]) => ({ rowCount: 1 }));
    const persist = createGuangYaTokenPersister(query, {
      ...snapshot,
      expectedStatus: "frozen",
      connectionMarker: "probe-generation",
    });

    await expect(persist({ accessToken: "a1", refreshToken: "r1", deviceId: "d0" })).resolves.toBe(true);
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(sql).toContain("status=status");
    expect(sql).not.toContain("status=CASE WHEN");
    expect(values).toEqual(["storage-1", "account-1", "uid-1", "a0", "r0", "d0", "probe-generation", "frozen", "a1", "r1", "d0"]);
  });
});
