import { UNSCOPED_STORAGE } from "@media-track/workflow";
import type { WorkflowKind, WorkflowStatus } from "@media-track/workflow";
import { isDemoMode } from "./demo-mode";
import type { Pool } from "pg";
import { isUpdateHoldActive, whileInFlight } from "./update-hold";
import { ensureLibraryPreparationRuntime, getLibraryPreparationPool, getLibraryPreparationService } from "./library-preparation-runtime";
import { resolveLibraryPreparationDescriptorsForPage } from "./workflow-runtime";

const PAGE_SIZE = 64;
const TICK_MS = 5_000;
let started = false;
let inTick = false;
let cursor = "";

interface NativeRunRow {
  id: string;
  account_id: string;
  connected_storage_id: string | null;
  workflow_kind: WorkflowKind;
  workflow_status: WorkflowStatus;
  next_attempt_at: string | null;
  media_type: "movie" | "tv" | "anime";
  tmdb_id: number;
  title: string;
  aliases: unknown;
  year: number;
}

/** Starts an independent bounded scanner/queue drain. It never claims workflow_runs. */
export function startLibraryPreparationWorker(): void {
  if (started || process.env.MEDIA_TRACK_INPROCESS_WORKER === "0" || process.env.MEDIA_TRACK_REHEARSAL === "1" || isDemoMode()) return;
  started = true;
  const tick = () => { void runTick(); };
  tick();
  setInterval(tick, TICK_MS).unref?.();
}

export async function runLibraryPreparationWorkerTick(): Promise<void> {
  await runTick();
}

async function runTick(): Promise<void> {
  if (inTick || process.env.MEDIA_TRACK_INPROCESS_WORKER === "0" || process.env.MEDIA_TRACK_REHEARSAL === "1" || isDemoMode() || isUpdateHoldActive(Date.now())) return;
  inTick = true;
  try {
    await whileInFlight(async () => {
      if (isUpdateHoldActive(Date.now())) return;
      await registerNextPage();
      if (isUpdateHoldActive(Date.now())) return;
      await getLibraryPreparationService().tick();
    });
  } catch (error) {
    console.warn(`[library-preparation] worker tick failed (${error instanceof Error ? error.name : typeof error})`);
  } finally { inTick = false; }
}

async function registerNextPage(): Promise<void> {
  await ensureLibraryPreparationRuntime();
  const rows = await findPreparationNativeRunPage(getLibraryPreparationPool(), cursor, PAGE_SIZE, new Date().toISOString());
  if (rows.length === 0 || rows.length < PAGE_SIZE) cursor = "";
  else cursor = rows[rows.length - 1]!.id;
  if (isUpdateHoldActive(Date.now())) return;
  const descriptorRows = rows.map((candidate) => ({
    workflowRunId: candidate.id,
    accountId: candidate.account_id,
    connectedStorageId: candidate.connected_storage_id === null || candidate.connected_storage_id === UNSCOPED_STORAGE ? null : candidate.connected_storage_id,
    kind: candidate.workflow_kind,
    status: candidate.workflow_status,
    nextAttemptAt: candidate.next_attempt_at,
    mediaType: candidate.media_type,
    tmdbId: candidate.tmdb_id,
    title: candidate.title,
    aliases: candidate.aliases,
    year: candidate.year,
  }));
  const descriptors = await resolveLibraryPreparationDescriptorsForPage(descriptorRows);
  for (const descriptor of descriptors) {
    if (isUpdateHoldActive(Date.now())) return;
    try {
      await getLibraryPreparationService().register(descriptor);
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error;
      console.warn(`[library-preparation] registration failed (${name}); continuing`);
    }
  }
}

/** Native discovery is SQL-bounded before LIMIT: only active, credential-bearing
 * Guangya scopes and claimable run kinds occupy a page. */
export async function findPreparationNativeRunPage(pool: Pool, cursor: string, pageSize: number, now: string): Promise<NativeRunRow[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error("PREPARATION_PAGE_SIZE_INVALID");
  const result = await pool.query<NativeRunRow>(
    `SELECT wr.id,wr.account_id,wr.connected_storage_id,wr.payload->>'kind' AS workflow_kind,
            wr.payload->>'status' AS workflow_status,wr.payload->>'nextAttemptAt' AS next_attempt_at,
            mt.payload->>'type' AS media_type,(mt.payload->>'tmdbId')::integer AS tmdb_id,
            mt.payload->>'title' AS title,mt.payload->'aliases' AS aliases,(mt.payload->>'year')::integer AS year
       FROM workflow_runs wr
       JOIN tracked_seasons ts ON ts.id=wr.tracked_season_id AND ts.account_id=wr.account_id AND ts.connected_storage_id=wr.connected_storage_id
       JOIN media_titles mt ON mt.id=ts.media_title_id
      WHERE wr.id > $1
        AND wr.payload->>'status' IN ('queued','running')
        AND wr.payload->>'kind' = ANY($2::text[])
        AND mt.payload->>'type' IN ('movie','tv','anime')
        AND NULLIF(btrim(mt.payload->>'title'),'') IS NOT NULL
        AND (wr.payload->>'status'='running' OR COALESCE(wr.payload->>'nextAttemptAt','')='' OR wr.payload->>'nextAttemptAt' <= $3)
        AND (
          (wr.connected_storage_id IS NOT NULL AND wr.connected_storage_id <> '__unscoped__'
            AND EXISTS (SELECT 1 FROM connected_storages cs WHERE cs.id=wr.connected_storage_id AND cs.account_id=wr.account_id
              AND cs.provider='guangya' AND cs.status='active'
              AND COALESCE(NULLIF(btrim(cs.payload->>'accessToken'),''),NULLIF(btrim(cs.payload->>'access_token'),'')) IS NOT NULL
              AND COALESCE(NULLIF(btrim(cs.payload->>'refreshToken'),''),NULLIF(btrim(cs.payload->>'refresh_token'),'')) IS NOT NULL))
          OR ((wr.connected_storage_id IS NULL OR wr.connected_storage_id='__unscoped__')
            AND EXISTS (SELECT 1 FROM connected_storages cs WHERE cs.account_id=wr.account_id
              AND cs.id=(SELECT preferred.id FROM connected_storages preferred
                WHERE preferred.account_id=wr.account_id
                  AND preferred.provider IN ('pan115','quark','uc','guangya','tianyi','pan123')
                  AND CASE preferred.provider
                    WHEN 'pan115' THEN NULLIF(btrim(preferred.payload->>'cookie'),'') IS NOT NULL
                    WHEN 'quark' THEN NULLIF(btrim(preferred.payload->>'cookie'),'') IS NOT NULL
                    WHEN 'uc' THEN NULLIF(btrim(preferred.payload->>'cookie'),'') IS NOT NULL
                    WHEN 'guangya' THEN COALESCE(NULLIF(btrim(preferred.payload->>'accessToken'),''),NULLIF(btrim(preferred.payload->>'access_token'),'')) IS NOT NULL
                      AND COALESCE(NULLIF(btrim(preferred.payload->>'refreshToken'),''),NULLIF(btrim(preferred.payload->>'refresh_token'),'')) IS NOT NULL
                    WHEN 'tianyi' THEN NULLIF(btrim(preferred.payload->>'sessionKey'),'') IS NOT NULL AND NULLIF(btrim(preferred.payload->>'accessToken'),'') IS NOT NULL AND NULLIF(btrim(preferred.payload->>'refreshToken'),'') IS NOT NULL
                    WHEN 'pan123' THEN NULLIF(btrim(preferred.payload->>'token'),'') IS NOT NULL
                    ELSE false END
                ORDER BY (preferred.status='active') DESC,preferred.created_at ASC LIMIT 1)
              AND cs.provider='guangya' AND cs.status='active'
              AND COALESCE(NULLIF(btrim(cs.payload->>'accessToken'),''),NULLIF(btrim(cs.payload->>'access_token'),'')) IS NOT NULL
              AND COALESCE(NULLIF(btrim(cs.payload->>'refreshToken'),''),NULLIF(btrim(cs.payload->>'refresh_token'),'')) IS NOT NULL))
        )
      ORDER BY wr.id ASC LIMIT $4`,
    [cursor, ["type1_package_init", "type2_init", "movie_init", "replace_request"], now, pageSize],
  );
  return result.rows;
}
