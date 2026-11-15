import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { GuangYaWriteCoordinator, type GuangYaWriteClient, type GuangYaWritePool } from "./guangya-write-coordinator.js";

class SharedLocks {
  readonly held = new Map<string, () => void>();
  readonly waiting = new Map<string, Array<() => void>>();
  connectCount = 0;
  failHealthCheck = false;
  failUnlock = false;
  unlockCount = 0;
  destroyedCount = 0;

  pool(): GuangYaWritePool {
    return { connect: async () => {
      this.connectCount += 1;
      const emitter = new EventEmitter();
      const ownedKeys = new Set<string>();
      return {
        query: async (sql, values) => {
          if (sql === "SELECT 1") {
            if (this.failHealthCheck) {
              for (const release of [...this.held.values()]) release();
              throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
            }
            return;
          }
          const key = String(values?.[0]);
          if (sql.includes("pg_advisory_lock")) {
            if (this.held.has(key)) await new Promise<void>((resolve) => {
              const queue = this.waiting.get(key) ?? [];
              queue.push(resolve);
              this.waiting.set(key, queue);
            });
            this.held.set(key, () => {
              const next = this.waiting.get(key)?.shift();
              if (next) next(); else this.held.delete(key);
            });
            ownedKeys.add(key);
          } else if (sql.includes("pg_advisory_unlock")) {
            this.unlockCount += 1;
            if (this.failUnlock) throw new Error("unlock failed");
            const release = this.held.get(key);
            if (!release) return { rows: [{ pg_advisory_unlock: false }] };
            release();
            ownedKeys.delete(key);
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          return { rows: [] };
        },
        on: (_event, listener) => { emitter.on("error", listener); },
        off: (_event, listener) => { emitter.off("error", listener); },
        release: (error) => {
          if (error) {
            this.destroyedCount += 1;
            for (const key of ownedKeys) this.held.get(key)?.();
            queueMicrotask(() => emitter.emit("error", new Error("late socket error")));
          }
        },
      } satisfies GuangYaWriteClient;
    } };
  }
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("GuangYa write coordinator", () => {
  it("serializes independent coordinators by account and permits different accounts concurrently", async () => {
    const shared = new SharedLocks();
    const one = new GuangYaWriteCoordinator(shared.pool());
    const two = new GuangYaWriteCoordinator(shared.pool());
    const firstInside = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];
    const first = one.run(["guangya:acct"], async () => {
      order.push("first-start"); firstInside.resolve(); await releaseFirst.promise; order.push("first-end");
    });
    await firstInside.promise;
    const second = two.run(["guangya:acct"], async () => { order.push("second"); });
    const different = two.run(["guangya:other"], async () => { order.push("other"); });
    await different;
    expect(order).toEqual(["first-start", "other"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "other", "first-end", "second"]);
  });

  it("sorts multi-account locks, permits same-key reentry, and rejects reverse nested acquisition", async () => {
    const shared = new SharedLocks();
    const coordinator = new GuangYaWriteCoordinator(shared.pool());
    await coordinator.run(["b", "a", "a"], async () => {
      await coordinator.run(["a"], async () => {});
      await expect(coordinator.run(["0"], async () => {})).rejects.toThrow("GUANGYA_WRITE_LOCK_ORDER");
    });
    expect(shared.held.size).toBe(0);
  });

  it("releases locks after errors and refuses writes after the lock connection is lost", async () => {
    const shared = new SharedLocks();
    const coordinator = new GuangYaWriteCoordinator(shared.pool());
    await expect(coordinator.run(["a"], async () => { throw new Error("cancelled"); })).rejects.toThrow("cancelled");
    expect(shared.held.size).toBe(0);
    await coordinator.run(["a"], async () => {
      shared.failHealthCheck = true;
      await expect(coordinator.assertHeld("a")).rejects.toThrow("GUANGYA_WRITE_LOCK_LOST");
      await expect(coordinator.assertHeld("a")).rejects.toThrow("GUANGYA_WRITE_LOCK_LOST");
    });
    expect(shared.connectCount).toBe(2);
    expect(shared.held.size).toBe(0);
    expect(shared.destroyedCount).toBe(1);
  });

  it("unlocks after business SQLSTATE and unrelated ECONNRESET errors", async () => {
    const shared = new SharedLocks();
    const coordinator = new GuangYaWriteCoordinator(shared.pool());
    await expect(coordinator.run(["sql-error"], async () => {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    })).rejects.toMatchObject({ code: "23505" });
    await expect(coordinator.run(["outside-error"], async () => {
      throw Object.assign(new Error("AI request socket reset"), { code: "ECONNRESET" });
    })).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(shared.unlockCount).toBe(2);
    expect(shared.destroyedCount).toBe(0);
    expect(shared.held.size).toBe(0);
  });

  it("destroys the client after an unlock failure", async () => {
    const shared = new SharedLocks();
    const coordinator = new GuangYaWriteCoordinator(shared.pool());
    shared.failUnlock = true;
    await coordinator.run(["unlock-error"], async () => {});
    expect(shared.destroyedCount).toBe(1);
  });

  it("requires the matching account key", async () => {
    const coordinator = new GuangYaWriteCoordinator(new SharedLocks().pool());
    await coordinator.run(["a"], async () => {
      await expect(coordinator.assertHeld("b")).rejects.toThrow("GUANGYA_WRITE_LOCK_REQUIRED: b");
      await expect(coordinator.assertHeld("a")).resolves.toBeUndefined();
    });
  });
});
