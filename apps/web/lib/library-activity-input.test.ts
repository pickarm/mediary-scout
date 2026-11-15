import { describe, expect, it } from "vitest";
import { LibraryApiError } from "./library-api";
import { parseLibraryActivityInput } from "./library-activity-input";

describe("parseLibraryActivityInput", () => {
  it("shares the bounded F10b activity query contract", () => {
    const params = new URLSearchParams("storageId=drive&activePage=4&activePageSize=50&recentLimit=20&runId=r2&runId=r1");
    expect(parseLibraryActivityInput(params, "account")).toEqual({
      accountId: "account", connectedStorageId: "drive", activePage: 4, activePageSize: 50,
      recentLimit: 20, runIds: ["r2", "r1"],
    });
  });

  it("rejects invalid page bounds, malformed cursor and excessive run IDs", () => {
    expect(() => parseLibraryActivityInput(new URLSearchParams("activePage=0"), "account")).toThrow(LibraryApiError);
    expect(() => parseLibraryActivityInput(new URLSearchParams("historyCursor=%%%"), "account")).toThrow(LibraryApiError);
    expect(() => parseLibraryActivityInput(new URLSearchParams(Array.from({ length: 101 }, (_, i) => `runId=${i}`).join("&")), "account")).toThrow(LibraryApiError);
  });
});
