/** Process-local single-flight for refreshes keyed by one physical GuangYa account. */

export interface GuangYaAuthCoordinator {
  runExclusive<T>(accountKey: string, operation: () => Promise<T>): Promise<T>;
}

const REGISTRY_SYMBOL = Symbol.for("media-track.guangya-auth-coordinator.v1");

type LockRegistry = Map<string, Promise<void>>;

/**
 * Create or reuse the process-wide refresh lock for a physical provider account.
 * Entries are removed as soon as the last waiter exits, so idle account keys do
 * not accumulate. Different accounts can refresh independently.
 */
export function createGuangYaAuthCoordinator(): GuangYaAuthCoordinator {
  return {
    async runExclusive<T>(accountKey: string, operation: () => Promise<T>): Promise<T> {
      const key = accountKey.trim();
      if (!key || key.length > 256) throw new Error("GUANGYA_AUTH_ACCOUNT_KEY_INVALID");

      const locks = getLockRegistry();
      const previous = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const tail = previous.then(() => held);
      locks.set(key, tail);

      await previous;
      try {
        return await operation();
      } finally {
        release();
        if (locks.get(key) === tail) locks.delete(key);
      }
    },
  };
}

/** Process-wide coordinator shared by the acquisition and scan client factories. */
export function getGuangYaAuthCoordinator(): GuangYaAuthCoordinator {
  const root = globalThis as typeof globalThis & { [REGISTRY_SYMBOL]?: GuangYaAuthCoordinator };
  return root[REGISTRY_SYMBOL] ?? (root[REGISTRY_SYMBOL] = createGuangYaAuthCoordinator());
}

function getLockRegistry(): LockRegistry {
  const root = globalThis as typeof globalThis & { __guangYaAuthLocks?: LockRegistry };
  return root.__guangYaAuthLocks ?? (root.__guangYaAuthLocks = new Map());
}
