import type { Pool } from "pg";
import { landedSize } from "../notification-report.js";
import type { MediaType, NotificationReportStatus, WorkflowKind, WorkflowRunProgress } from "../domain.js";

export interface PostgresActivityQueryInput {
  accountId: string;
  connectedStorageId: string | null;
  activePage?: number;
  activePageSize?: number;
  recentLimit?: number;
  historyCursor?: { createdAt: string; id: string };
  runIds?: readonly string[];
}
export interface ActivityActiveRunSummary {
  runId: string; kind: WorkflowKind; tmdbId: number; title: string; year: number | null; type: MediaType;
  posterPath: string | null; seasonNumber: number | null; seasonNumbers: number[];
  status: "queued" | "running"; queuePosition: number | null; missingCount: number; progress: WorkflowRunProgress | null;
}
export interface ActivityCompletedSummary {
  workflowRunId: string; title: string; seasonLabel: string | null; status: NotificationReportStatus;
  posterPath: string | null; sizeText: string | null; createdAt: string;
}
export interface PostgresActivityPage {
  active: { items: ActivityActiveRunSummary[]; total: number; page: number; pageSize: number; hasMore: boolean };
  totals: { queued: number; running: number; active: number };
  recentCompleted: { items: ActivityCompletedSummary[]; nextCursor: { createdAt: string; id: string } | null; hasMore: boolean };
}
export class ActivityQueryInputError extends Error { constructor(message: string) { super(message); this.name = "ActivityQueryInputError"; } }

const INDEX_LOCK = 4_011_989_147;
export async function initializePostgresActivityQueryIndexes(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [INDEX_LOCK]);
    await client.query(`
      CREATE INDEX IF NOT EXISTS workflow_runs_activity_scope_idx
        ON workflow_runs (account_id, connected_storage_id, (payload->>'status'), (payload->>'startedAt'), id)
        WHERE payload->>'status' IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS notifications_activity_run_idx ON notifications (workflow_run_id, id);
      CREATE INDEX IF NOT EXISTS notifications_activity_recent_idx
        ON notifications ((payload->>'createdAt') DESC, id DESC, workflow_run_id)
        WHERE payload ? 'report' AND payload->>'kind' NOT IN ('already_current','staging_leftover','staging_recovery');
      CREATE INDEX IF NOT EXISTS episode_states_activity_scope_idx
        ON episode_states (tracked_season_id, connected_storage_id, episode_code);
      CREATE INDEX IF NOT EXISTS episode_copies_activity_scope_idx ON episode_copies (tracked_season_id, storage_id, episode_code);
    `);
    await client.query("COMMIT");
  } catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve DDL error */ } throw error; }
  finally { client.release(); }
}

function valid(input: PostgresActivityQueryInput) {
  const accountId = input.accountId.trim();
  if (!accountId || accountId.length > 200) throw new ActivityQueryInputError("accountId无效。");
  const storageId = input.connectedStorageId;
  if (storageId !== null && (!storageId.trim() || storageId.length > 300)) throw new ActivityQueryInputError("storageId无效。");
  const page = input.activePage ?? 1, pageSize = input.activePageSize ?? 48, recentLimit = input.recentLimit ?? 30;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new ActivityQueryInputError("活动页码无效。");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ActivityQueryInputError("活动页大小无效。");
  if (!Number.isSafeInteger(recentLimit) || recentLimit < 1 || recentLimit > 100) throw new ActivityQueryInputError("近期完成数量无效。");
  if (input.runIds && (input.runIds.length > 100 || input.runIds.some((id) => !id || id.length > 200))) throw new ActivityQueryInputError("任务 ID 数量或格式无效。");
  if (input.historyCursor && (input.historyCursor.id.length > 200 || !Number.isFinite(Date.parse(input.historyCursor.createdAt)))) throw new ActivityQueryInputError("历史游标无效。");
  return { accountId, storageId, page, pageSize, recentLimit };
}

interface ActiveRow {
  total: string; run_id: string; kind: WorkflowKind; status: "queued" | "running"; started_at: string;
  run_progress: WorkflowRunProgress | null; season_id: string; season_number: number; title_payload: Record<string, unknown>;
  missing_count: number; season_numbers: number[]; queue_position: number | null;
  queued_total: string; running_total: string; active_total: string;
}
interface CompletedRow {
  id: string; workflow_run_id: string; created_at: string; title: string; season_label: string | null;
  status: NotificationReportStatus; poster_path: string | null; tmdb_id: number | null; media_type: MediaType | null;
  file_count: number | null; total_bytes: number | null; resolved_poster: string | null;
}

function compactProgress(value: unknown): WorkflowRunProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.activity !== "string" || typeof row.phase !== "string" ||
      typeof row.percent !== "number" || !Number.isFinite(row.percent) || typeof row.updatedAt !== "string") return null;
  return {
    activity: row.activity.slice(0, 240), phase: row.phase.slice(0, 40),
    percent: Math.max(0, Math.min(100, row.percent)), updatedAt: row.updatedAt.slice(0, 40),
    ...(typeof row.obtained === "number" && Number.isFinite(row.obtained) ? { obtained: Math.max(0, row.obtained) } : {}),
    ...(typeof row.needed === "number" && Number.isFinite(row.needed) ? { needed: Math.max(0, row.needed) } : {}),
  };
}

export class PostgresActivityQuery {
  constructor(private readonly pool: Pool) {}
  async getPage(input: PostgresActivityQueryInput): Promise<PostgresActivityPage> {
    const args = valid(input);
    const offset = (args.page - 1) * args.pageSize;
    const active = await this.pool.query<ActiveRow>(`
      WITH scoped AS (
        SELECT wr.id, wr.tracked_season_id, wr.connected_storage_id,
               wr.payload->>'kind' AS kind, wr.payload->>'status' AS status,
               wr.payload->>'startedAt' AS started_at, wr.payload->'progress' AS run_progress,
               ts.payload->>'seasonNumber' AS season_number, ts.media_title_id
          FROM workflow_runs wr
          JOIN tracked_seasons ts ON ts.id = wr.tracked_season_id AND ts.connected_storage_id = wr.connected_storage_id AND ts.account_id = wr.account_id
          JOIN media_titles mt ON mt.id=ts.media_title_id
         WHERE wr.account_id = $1 AND ($2::text IS NULL OR wr.connected_storage_id = $2)
           AND wr.payload->>'status' IN ('queued','running')
           AND COALESCE(wr.payload->>'kind','') <> 'staging_recovery'
      ), totals AS (
        SELECT count(*) FILTER (WHERE status='queued')::integer AS queued_total,
               count(*) FILTER (WHERE status='running')::integer AS running_total,
               count(*)::integer AS active_total FROM scoped
      ), ranked AS (
        SELECT scoped.*, CASE WHEN status = 'queued' THEN
          count(*) FILTER (WHERE status='queued') OVER (ORDER BY started_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::integer ELSE NULL END AS queue_position
        FROM scoped
      ), filtered AS (
        SELECT * FROM ranked WHERE $5::text[] IS NULL OR id = ANY($5::text[])
      ), filtered_total AS (SELECT count(*)::integer AS total FROM filtered), page_runs AS (
        SELECT ranked.* FROM ranked
         WHERE $5::text[] IS NULL OR id = ANY($5::text[])
         ORDER BY CASE WHEN status='running' THEN 0 ELSE 1 END, started_at, id
         LIMIT $3 OFFSET $4
      ), page_seasons AS (
        SELECT DISTINCT pr.tracked_season_id, pr.connected_storage_id FROM page_runs pr
      ), episode_facts AS (
        SELECT ps.tracked_season_id, ps.connected_storage_id, e.episode_code,
               (e.payload->>'obtained')::boolean AS obtained, e.payload->>'airStatus' AS air_status
          FROM page_seasons ps JOIN episode_states e ON e.tracked_season_id=ps.tracked_season_id AND e.connected_storage_id=ps.connected_storage_id
        UNION ALL
        SELECT ps.tracked_season_id, ps.connected_storage_id, c.episode_code, true AS obtained, 'unknown' AS air_status
          FROM page_seasons ps JOIN episode_copies c ON c.tracked_season_id=ps.tracked_season_id AND c.storage_id=ps.connected_storage_id
         WHERE NOT EXISTS (SELECT 1 FROM episode_states e WHERE e.tracked_season_id=ps.tracked_season_id AND e.connected_storage_id=ps.connected_storage_id)
      ), episode_summary AS (
        SELECT tracked_season_id, connected_storage_id,
               count(*) FILTER (WHERE air_status='aired' AND NOT obtained)::integer AS missing_count,
               array_agg(DISTINCT NULLIF(regexp_replace(episode_code, '^S([0-9]+)E[0-9]+$', '\\1'), episode_code)::integer ORDER BY NULLIF(regexp_replace(episode_code, '^S([0-9]+)E[0-9]+$', '\\1'), episode_code)::integer)
                 FILTER (WHERE episode_code ~ '^S[0-9]+E[0-9]+$') AS season_numbers
          FROM episode_facts GROUP BY tracked_season_id, connected_storage_id
      )
      SELECT filtered_total.total::text, totals.queued_total::text, totals.running_total::text, totals.active_total::text,
             pr.queue_position, pr.id AS run_id, pr.kind, pr.status, pr.started_at, pr.run_progress,
             pr.tracked_season_id AS season_id, COALESCE(NULLIF(pr.season_number,''),'0')::integer AS season_number,
             m.id AS title_id, m.payload AS title_payload, COALESCE(es.missing_count,0) AS missing_count,
             COALESCE(es.season_numbers, ARRAY[]::integer[]) AS season_numbers
        FROM totals CROSS JOIN filtered_total LEFT JOIN page_runs pr ON true
        LEFT JOIN media_titles m ON m.id=pr.media_title_id
        LEFT JOIN episode_summary es ON es.tracked_season_id=pr.tracked_season_id AND es.connected_storage_id=pr.connected_storage_id
       ORDER BY CASE WHEN pr.status='running' THEN 0 ELSE 1 END, pr.started_at, pr.id
    `, [args.accountId, args.storageId, args.pageSize, offset, input.runIds ? [...input.runIds] : null]);
    const first = active.rows[0];
    const total = Number(first?.total ?? 0);
    const queuedTotal = Number(first?.queued_total ?? 0), runningTotal = Number(first?.running_total ?? 0);
    const activeTotal = Number(first?.active_total ?? 0);
    const activeItems: ActivityActiveRunSummary[] = active.rows.filter((row) => row.run_id && row.title_payload).map((row) => {
      const titleLevel = row.kind === "replace_request";
      const title = row.title_payload;
      const progress = compactProgress(row.run_progress);
      return {
        runId: row.run_id, kind: row.kind, tmdbId: Number(title.tmdbId), title: String(title.title ?? ""),
        year: typeof title.year === "number" ? title.year : null,
        type: title.type as MediaType, posterPath: typeof title.posterPath === "string" ? title.posterPath : null,
        seasonNumber: titleLevel || row.season_number === 0 ? null : row.season_number,
        seasonNumbers: titleLevel ? [] : (row.season_numbers ?? []), status: row.status,
        queuePosition: row.status === "queued" ? row.queue_position : null,
        missingCount: titleLevel ? 0 : Number(row.missing_count), progress,
      };
    });

    const completed = await this.pool.query<CompletedRow>(`
      SELECT n.id, n.workflow_run_id, n.payload->>'createdAt' AS created_at,
             n.payload->'report'->>'titleName' AS title,
             n.payload->'report'->>'seasonLabel' AS season_label,
             n.payload->'report'->>'status' AS status,
             NULLIF(n.payload->'report'->>'posterPath','') AS poster_path,
             CASE WHEN n.payload->'report'->>'tmdbId' ~ '^[0-9]+$' THEN (n.payload->'report'->>'tmdbId')::integer END AS tmdb_id,
             n.payload->'report'->>'mediaType' AS media_type,
             CASE WHEN n.payload->'report'->>'fileCount' ~ '^[0-9]+$' THEN (n.payload->'report'->>'fileCount')::integer END AS file_count,
             CASE WHEN n.payload->'report'->>'totalBytes' ~ '^[0-9]+$' THEN (n.payload->'report'->>'totalBytes')::bigint END AS total_bytes,
             COALESCE(NULLIF(n.payload->'report'->>'posterPath',''), mp.payload->>'posterPath') AS resolved_poster
        FROM notifications n JOIN workflow_runs wr ON wr.id=n.workflow_run_id
        LEFT JOIN tracked_seasons ts ON ts.id=wr.tracked_season_id AND ts.connected_storage_id=wr.connected_storage_id AND ts.account_id=wr.account_id
        LEFT JOIN media_titles mp ON mp.id=ts.media_title_id
         AND mp.payload->>'type' = n.payload->'report'->>'mediaType'
         AND (n.payload->'report'->>'tmdbId' IS NULL OR mp.payload->>'tmdbId'=n.payload->'report'->>'tmdbId')
       WHERE wr.account_id=$1 AND ($2::text IS NULL OR wr.connected_storage_id=$2)
         AND n.payload->>'kind' NOT IN ('already_current','staging_leftover','staging_recovery')
         AND n.payload ? 'report' AND jsonb_typeof(n.payload->'report')='object'
         AND NULLIF(n.payload->'report'->>'titleName','') IS NOT NULL
         AND NULLIF(n.payload->'report'->>'status','') IS NOT NULL
         AND ($4::text IS NULL OR (n.payload->>'createdAt', n.id) < ($4::text, $5::text))
       ORDER BY n.payload->>'createdAt' DESC, n.id DESC LIMIT $3
    `, [args.accountId, args.storageId, args.recentLimit + 1, input.historyCursor?.createdAt ?? null, input.historyCursor?.id ?? null]);
    const completedRows = completed.rows.slice(0, args.recentLimit);
    const completedItems = completedRows.filter((row) => row.title && row.status).map((row): ActivityCompletedSummary => {
      const size = landedSize({
        ...(row.file_count === null ? {} : { fileCount: row.file_count }),
        ...(row.total_bytes === null ? {} : { totalBytes: Number(row.total_bytes) }),
        status: row.status,
        ...(row.media_type === null ? {} : { mediaType: row.media_type }),
      });
      return { workflowRunId: row.workflow_run_id, title: row.title, seasonLabel: row.season_label, status: row.status,
        posterPath: row.resolved_poster ?? row.poster_path, sizeText: size ? `${size.label} ${size.value}` : null, createdAt: row.created_at };
    });
    const last = completedRows.at(-1);
    return {
      active: { items: activeItems, total, page: args.page, pageSize: args.pageSize, hasMore: offset + args.pageSize < total },
      totals: { queued: queuedTotal, running: runningTotal, active: activeTotal },
      recentCompleted: { items: completedItems,
        nextCursor: completed.rows.length > args.recentLimit && last ? { createdAt: last.created_at, id: last.id } : null,
        hasMore: completed.rows.length > args.recentLimit },
    };
  }
}
