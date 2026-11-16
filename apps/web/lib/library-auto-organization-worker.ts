import { isDemoMode } from "./demo-mode";
import { getLibraryAutoOrganizationScheduler } from "./library-auto-organization";
import { isUpdateHoldActive, whileInFlight } from "./update-hold";

const POLL_MS = boundedEnv("MEDIA_TRACK_LIBRARY_AUTO_ORGANIZATION_WORKER_POLL_MS", 15_000, 1_000, 300_000);
let started = false;
let ticking = false;

/** Starts the bounded F08f dispatcher. The main agent owns instrumentation wiring. */
export function startLibraryAutoOrganizationWorker(): void {
  if (started || process.env.MEDIA_TRACK_INPROCESS_WORKER === "0" || process.env.MEDIA_TRACK_REHEARSAL === "1" || isDemoMode()) return;
  started = true;
  const tick = async (): Promise<void> => {
    if (ticking || isUpdateHoldActive(Date.now())) return;
    ticking = true;
    try {
      await whileInFlight(async () => {
        if (isUpdateHoldActive(Date.now())) return;
        const result = await getLibraryAutoOrganizationScheduler().tick();
        if (result.processed || result.recovered || result.cancelled) {
          console.log(`[library-auto-organization-worker] processed=${result.processed} recovered=${result.recovered} cancelled=${result.cancelled}`);
        }
      });
    } catch (error) {
      console.error(`[library-auto-organization-worker] tick failed: ${safeError(error)}`);
    } finally {
      ticking = false;
    }
  };
  console.log(`[library-auto-organization-worker] started (poll ${POLL_MS}ms)`);
  void tick();
  setInterval(() => { void tick(); }, POLL_MS);
}

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}
