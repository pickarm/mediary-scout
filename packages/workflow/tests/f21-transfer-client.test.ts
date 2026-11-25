import { describe, expect, it } from "vitest";
import { QuarkCookieClient } from "../src/quark-cookie-client.js";

describe("F21 transfer receipt recovery", () => {
  it("reads one Quark task status without entering the long poll", async () => {
    const requested: string[] = [];
    const client = new QuarkCookieClient({
      cookie: "__uid=u",
      fetchJson: async (url) => {
        requested.push(String(url));
        return { code: 0, data: { status: 1 } };
      },
    });

    await expect(client.getTaskStatus("task-existing")).resolves.toBe("running");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("/1/clouddrive/task");
    expect(requested[0]).toContain("task_id=task-existing");
  });
});
