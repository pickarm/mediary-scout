import { describe, expect, it } from "vitest";
import { createGuangYaAuthCoordinator } from "./guangya-auth-coordinator.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("GuangYa auth coordinator", () => {
  it("serializes refreshes for the same physical account across coordinator instances", async () => {
    const firstCoordinator = createGuangYaAuthCoordinator();
    const secondCoordinator = createGuangYaAuthCoordinator();
    const firstEntered = deferred<void>();
    const finishFirst = deferred<string>();
    const order: string[] = [];

    const first = firstCoordinator.runExclusive("guangya:uid-1", async () => {
      order.push("first-start");
      firstEntered.resolve();
      const result = await finishFirst.promise;
      order.push("first-end");
      return result;
    });
    await firstEntered.promise;
    const second = secondCoordinator.runExclusive("guangya:uid-1", async () => {
      order.push("second-start");
      return "second";
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    finishFirst.resolve("first");
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("allows different physical accounts to refresh concurrently", async () => {
    const coordinator = createGuangYaAuthCoordinator();
    const bothEntered = deferred<void>();
    let entered = 0;
    const waitForBoth = async (): Promise<void> => {
      entered += 1;
      if (entered === 2) bothEntered.resolve();
      await bothEntered.promise;
    };

    const first = coordinator.runExclusive("guangya:uid-a", waitForBoth);
    const second = coordinator.runExclusive("guangya:uid-b", waitForBoth);
    await Promise.all([first, second]);
    expect(entered).toBe(2);
  });

  it("releases the account lock when an operation fails", async () => {
    const coordinator = createGuangYaAuthCoordinator();
    await expect(coordinator.runExclusive("guangya:uid-error", async () => {
      throw new Error("expected failure");
    })).rejects.toThrow("expected failure");
    await expect(coordinator.runExclusive("guangya:uid-error", async () => "recovered"))
      .resolves.toBe("recovered");
  });

  it("rejects missing or unbounded account keys", async () => {
    const coordinator = createGuangYaAuthCoordinator();
    await expect(coordinator.runExclusive("  ", async () => undefined))
      .rejects.toThrow("GUANGYA_AUTH_ACCOUNT_KEY_INVALID");
    await expect(coordinator.runExclusive("x".repeat(257), async () => undefined))
      .rejects.toThrow("GUANGYA_AUTH_ACCOUNT_KEY_INVALID");
  });
});
