"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, RefreshCw, Search, Check } from "lucide-react";
import styles from "./library-identification-results.module.css";
import {
  confirmIdentity, loadIdentificationPage, parseIdentityCandidate, parseIdentityEvidence,
  setSeasonAutoAcquire, startIdentification, validateEpisodeNumbers,
  type IdentificationFilter, type IdentificationPage, type IdentificationResultItem, type IdentityCandidate,
} from "./library-identification-client";

const FILTERS: readonly { value: IdentificationFilter; label: string }[] = [
  { value: "all", label: "全部" }, { value: "pending", label: "待确认" }, { value: "confirmed", label: "已确认" }, { value: "ignored", label: "已忽略" }, { value: "failed", label: "失败" },
];

export function LibraryIdentificationResults({ storageId, configId, taskId, frozen }: {
  storageId: string | null; configId: string | null; taskId: string | null; frozen: boolean;
}) {
  const [filter, setFilter] = useState<IdentificationFilter>("all");
  const [page, setPage] = useState<IdentificationPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeNeedsRefresh, setNoticeNeedsRefresh] = useState(false);
  const [busyFileIds, setBusyFileIds] = useState<Set<string>>(() => new Set());
  const [busySeasons, setBusySeasons] = useState<Set<string>>(() => new Set());
  const [recognitionBusy, setRecognitionBusy] = useState(false);
  const generation = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const expandedResults = useRef(false);
  const pollInFlight = useRef(false);
  const selectedScope = useMemo(() => storageId && taskId ? `${storageId}\u0000${taskId}\u0000${filter}` : "", [storageId, taskId, filter]);

  const current = useCallback((scopeGeneration: number, signal: AbortSignal) => generation.current === scopeGeneration && !signal.aborted, []);
  const loadFirst = useCallback(async (scopeGeneration: number, signal: AbortSignal) => {
    if (!storageId || !taskId) return;
    expandedResults.current = false;
    setNoticeNeedsRefresh(false);
    setLoading(true); setError(null);
    try {
      const next = await loadIdentificationPage(storageId, taskId, 30, null, filter, signal);
      if (current(scopeGeneration, signal)) setPage(next);
    } catch (cause) {
      if (current(scopeGeneration, signal)) setError(cause instanceof Error ? cause.message : "读取识别结果失败。");
    } finally { if (current(scopeGeneration, signal)) setLoading(false); }
  }, [storageId, taskId, filter, current]);

  useEffect(() => {
    const scopeGeneration = ++generation.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    expandedResults.current = false;
    pollInFlight.current = false;
    setPage(null); setError(null); setNotice(null); setNoticeNeedsRefresh(false); setBusyFileIds(new Set()); setBusySeasons(new Set()); setRecognitionBusy(false);
    setLoading(false); setLoadingMore(false);
    if (storageId && taskId) void loadFirst(scopeGeneration, controller.signal);
    else setLoading(false);
    return () => { controller.abort(); if (controllerRef.current === controller) controllerRef.current = null; };
  }, [selectedScope, loadFirst, storageId, taskId]);

  useEffect(() => {
    const jobStatus = page?.summary?.status;
    if (!storageId || !taskId || !jobStatus || !["waiting", "pending", "running"].includes(jobStatus)) return;
    const scopeGeneration = generation.current;
    const controller = controllerRef.current;
    if (!controller) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden" || pollInFlight.current || !current(scopeGeneration, controller.signal)) return;
      pollInFlight.current = true;
      void loadIdentificationPage(storageId, taskId, 30, null, filter, controller.signal).then((next) => {
        if (!current(scopeGeneration, controller.signal)) return;
        if (!expandedResults.current) {
          setPage(next);
          return;
        }
        const firstPageChanged = page
          ? JSON.stringify(page.items.slice(0, next.items.length)) !== JSON.stringify(next.items)
          : next.items.length > 0;
        const countsChanged = !page || JSON.stringify(page.counts) !== JSON.stringify(next.counts);
        const statusChanged = page?.summary?.status !== next.summary?.status;
        const completed = ["waiting", "pending", "running"].includes(page?.summary?.status ?? "")
          && ["completed", "cancelled", "failed"].includes(next.summary?.status ?? "");
        if (firstPageChanged || countsChanged || statusChanged || completed) {
            setNotice("结果有更新，刷新列表查看最新状态。");
            setNoticeNeedsRefresh(true);
        }
        setPage((existing) => existing ? { ...existing, summary: next.summary, counts: next.counts } : next);
      }).catch((cause: unknown) => {
        if (current(scopeGeneration, controller.signal)) setError(cause instanceof Error ? cause.message : "刷新识别进度失败。");
      }).finally(() => {
        if (current(scopeGeneration, controller.signal)) pollInFlight.current = false;
      });
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [page, storageId, taskId, filter, current]);

  const reload = () => {
    expandedResults.current = false;
    setNotice(null);
    setNoticeNeedsRefresh(false);
    const controller = controllerRef.current;
    if (controller) void loadFirst(generation.current, controller.signal);
  };

  const loadMore = async () => {
    if (!storageId || !taskId || !page?.nextCursor || loadingMore) return;
    const scopeGeneration = generation.current; const signal = controllerRef.current?.signal;
    if (!signal) return;
    expandedResults.current = true;
    setLoadingMore(true); setError(null);
    try {
      const next = await loadIdentificationPage(storageId, taskId, 30, page.nextCursor, filter, signal);
      if (current(scopeGeneration, signal)) setPage((existing) => existing ? { ...next, items: [...existing.items, ...next.items] } : next);
    } catch (cause) { if (current(scopeGeneration, signal)) setError(cause instanceof Error ? cause.message : "读取下一页失败。"); }
    finally { if (current(scopeGeneration, signal)) setLoadingMore(false); }
  };

  const runRecognition = async (action: "start" | "retry") => {
    if (!storageId || !taskId || frozen || recognitionBusy) return;
    const scopeGeneration = generation.current; const signal = controllerRef.current?.signal;
    if (!signal) return;
    setRecognitionBusy(true); setError(null); setNotice(null);
    try {
      await startIdentification(storageId, taskId, action, signal);
      if (!current(scopeGeneration, signal)) return;
      setNotice(action === "retry" ? "已提交失败项重试。" : "已提交识别任务。扫描仍在进行时，结果会随进度更新。 ");
      await loadFirst(scopeGeneration, signal);
    } catch (cause) { if (current(scopeGeneration, signal)) setError(cause instanceof Error ? cause.message : "提交识别任务失败。"); }
    finally { if (current(scopeGeneration, signal)) setRecognitionBusy(false); }
  };

  const confirm = async (item: IdentificationResultItem, input: { tmdbId: number; mediaType: "movie" | "tv" | "anime"; seasonNumber?: number; episodeNumbers?: number[] }) => {
    if (!storageId || !taskId || frozen || busyFileIds.has(item.fileId)) return;
    const scopeGeneration = generation.current; const signal = controllerRef.current?.signal;
    if (!signal) return;
    setBusyFileIds((set) => new Set(set).add(item.fileId)); setError(null); setNotice(null);
    try {
      await confirmIdentity(storageId, taskId, item.fileId, input, signal);
      if (!current(scopeGeneration, signal)) return;
      setNotice("已确认文件身份，并刷新当前页结果与补缺状态。");
      await loadFirst(scopeGeneration, signal);
    } catch (cause) { if (current(scopeGeneration, signal)) setError(cause instanceof Error ? cause.message : "确认文件身份失败。"); }
    finally { if (current(scopeGeneration, signal)) setBusyFileIds((set) => { const next = new Set(set); next.delete(item.fileId); return next; }); }
  };

  const setTracking = async (seasonId: string, value: boolean) => {
    if (!storageId || frozen || busySeasons.has(seasonId)) return;
    const scopeGeneration = generation.current; const signal = controllerRef.current?.signal;
    if (!signal) return;
    setBusySeasons((set) => new Set(set).add(seasonId)); setError(null); setNotice(null);
    try {
      await setSeasonAutoAcquire(storageId, seasonId, value, signal);
      if (!current(scopeGeneration, signal)) return;
      setPage((existing) => existing ? { ...existing, items: existing.items.map((item) => item.tracking?.trackedSeasonId === seasonId ? { ...item, tracking: { ...item.tracking, autoAcquire: value } } : item) } : existing);
      setNotice(value ? "已开启此季自动补缺。" : "已关闭此季自动补缺。");
    } catch (cause) { if (current(scopeGeneration, signal)) setError(cause instanceof Error ? cause.message : "保存补缺设置失败。"); }
    finally { if (current(scopeGeneration, signal)) setBusySeasons((set) => { const next = new Set(set); next.delete(seasonId); return next; }); }
  };

  const seasonGroups = new Map<string, IdentificationResultItem>();
  for (const item of page?.items ?? []) if (item.tracking && !seasonGroups.has(item.tracking.trackedSeasonId)) seasonGroups.set(item.tracking.trackedSeasonId, item);

  return <section className={`panel ${styles.panel}`} aria-labelledby="library-identifications-title" data-config-id={configId ?? ""}>
    <div className={styles.header}>
      <div><h2 id="library-identifications-title">识别结果与身份确认</h2><p>确认的是扫描到的现有文件身份，不会选择下载资源。</p></div>
      {taskId && <div className={styles.actions}>
        <button className="secondary-button" type="button" onClick={() => void runRecognition("start")} disabled={frozen || recognitionBusy || ["waiting", "pending", "running"].includes(page?.summary?.status ?? "")}>{recognitionBusy ? "提交中…" : "开始识别"}<Search size={14} /></button>
        {Boolean(page?.counts.failed) && <button className="secondary-button" type="button" onClick={() => void runRecognition("retry")} disabled={frozen || recognitionBusy}>重试失败项<RefreshCw size={14} /></button>}
        <button className="secondary-button" type="button" onClick={reload} disabled={loading}><RefreshCw size={14} />刷新</button>
      </div>}
    </div>
    {frozen && storageId && <div className={styles.notice}>连接已冻结，仅可查看扫描结果。</div>}
    {!storageId ? <div className={styles.empty}>请先选择光鸭连接并读取扫描任务。</div>
      : !taskId ? <div className={styles.empty}>从上方“扫描任务”中选择一个任务，即可查看识别结果。</div>
      : <>
        {page && <div className={styles.counts} aria-label="识别结果数量">
          <span>文件 {page.counts.total}</span><span>已确认 {page.counts.confirmed}</span><span>待确认 {page.counts.pending}</span><span>失败 {page.counts.failed}</span><span>已导入 {page.counts.imported}</span>
          {page.summary && <span>识别状态：{jobStatusLabel(page.summary.status)}{page.summary.lastError ? ` · ${page.summary.lastError}` : ""}</span>}
        </div>}
        {error && <div className={styles.error} role="alert"><CircleAlert size={16} /><span>{error}</span><button className="secondary-button" type="button" onClick={reload}>重试读取</button></div>}
        {notice && <p className={styles.notice} role="status">{notice}{noticeNeedsRefresh && <> <button className="secondary-button" type="button" onClick={reload} disabled={loading}>刷新列表</button></>}</p>}
        <div className={styles.filters} role="group" aria-label="识别状态筛选">
          {FILTERS.map((item) => <button key={item.value} type="button" className={filter === item.value ? styles.activeFilter : ""} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}
        </div>
        {loading && !page ? <div className={styles.loading}><LoaderCircle size={18} className={styles.spin} />正在读取识别结果…</div>
          : !page ? <div className={styles.empty}>{error ? "未能读取识别结果，请重试。" : "正在读取识别结果…"}</div>
          : page.items.length === 0 ? <div className={styles.empty}>{page.counts.total === 0 ? "此任务暂时没有识别结果。识别可能仍在排队，页面不会自动启动识别。" : "当前筛选没有结果。"}</div>
          : <>
            {seasonGroups.size > 0 && <section className={styles.trackingSection} aria-label="按已跟踪剧季管理自动补缺">
              <h3>剧季自动补缺</h3><p>每个已跟踪剧季仅显示一个开关；新导入默认关闭。身份确认不会自动开启补缺。</p>
              {[...seasonGroups].map(([seasonId, item]) => <label className={styles.trackingRow} key={seasonId}>
                <input type="checkbox" checked={item.tracking?.autoAcquire === true} disabled={frozen || busySeasons.has(seasonId)} onChange={(event) => void setTracking(seasonId, event.target.checked)} />
                <span>{item.file?.path ?? item.file?.name ?? "已关联剧季"}</span>
                <small>{item.tracking?.autoAcquire === null ? "未单独设置，沿用原有行为" : item.tracking?.autoAcquire ? "自动补缺已开启" : "自动补缺已关闭"}</small>
                {busySeasons.has(seasonId) && <LoaderCircle size={14} className={styles.spin} />}
              </label>)}
            </section>}
            <div className={styles.results}>
              {page.items.map((item) => <IdentificationCard key={item.fileId} item={item} frozen={frozen} busy={busyFileIds.has(item.fileId)} onConfirm={confirm} />)}
            </div>
            {page.hasMore && <button type="button" className="secondary-button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "正在读取…" : "加载更多结果"}</button>}
          </>}
      </>}
  </section>;
}

function IdentificationCard({ item, frozen, busy, onConfirm }: {
  item: IdentificationResultItem; frozen: boolean; busy: boolean;
  onConfirm: (item: IdentificationResultItem, input: { tmdbId: number; mediaType: "movie" | "tv" | "anime"; seasonNumber?: number; episodeNumbers?: number[] }) => Promise<void>;
}) {
  const candidates = item.candidates.map(parseIdentityCandidate).filter((candidate): candidate is IdentityCandidate => candidate !== null);
  const evidence = item.evidence.map(parseIdentityEvidence).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const [candidateIndex, setCandidateIndex] = useState(candidates.length ? "0" : "manual");
  const [manualId, setManualId] = useState("");
  const [mediaType, setMediaType] = useState<"movie" | "tv" | "anime">("movie");
  const [season, setSeason] = useState("1");
  const [episodes, setEpisodes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const chosen = candidateIndex === "manual" ? null : candidates[Number(candidateIndex)] ?? null;
  const choose = async () => {
    setFormError(null);
    const tmdbId = chosen?.tmdbId ?? Number(manualId);
    const resolvedType = chosen?.mediaType ?? mediaType;
    if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) { setFormError("请选择候选或输入有效的 TMDB ID。"); return; }
    if (resolvedType !== "movie" && resolvedType !== "tv" && resolvedType !== "anime") { setFormError("请选择媒体类型。"); return; }
    const payload: { tmdbId: number; mediaType: "movie" | "tv" | "anime"; seasonNumber?: number; episodeNumbers?: number[] } = { tmdbId, mediaType: resolvedType };
    if (resolvedType !== "movie") {
      const seasonNumber = Number(season);
      if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 0 || seasonNumber > 99) { setFormError("季号必须是 0 至 99 的整数；0 表示特别篇。"); return; }
      payload.seasonNumber = seasonNumber;
      const parsed = validateEpisodeNumbers(episodes);
      if (parsed.error) { setFormError(parsed.error); return; }
      if (parsed.numbers?.length) payload.episodeNumbers = parsed.numbers;
    }
    await onConfirm(item, payload);
  };
  const status = { confirmed: "已确认", pending: "待确认", ignored: "已忽略", failed: "识别失败" }[item.status];
  return <article className={styles.card}>
    <div className={styles.fileHeader}><div><span className={styles.status}>{status}</span><h3>{item.file?.name ?? item.fileId}</h3><p title={item.file?.path}>{item.file?.path ?? "扫描文件事实暂不可用"}</p></div>
      {busy && <span className={styles.busy}><LoaderCircle size={15} className={styles.spin} />提交中</span>}
    </div>
    {item.file && <p className={styles.fileMeta}>{item.file.sizeBytes === null ? "大小未知" : formatBytes(item.file.sizeBytes)}{item.file.modifiedAt ? ` · 修改时间 ${formatDate(item.file.modifiedAt)}` : ""}</p>}
    <p className={styles.reason}>{item.reason || "暂无识别说明。"}</p>
    {evidence.length > 0 && <details className={styles.evidence}><summary>识别依据（{evidence.length}）</summary><ul>{evidence.map((entry, index) => <li key={`${entry.kind}:${entry.value}:${index}`}><strong>{entry.kind}</strong>：{entry.value}<small>（{entry.source}）</small></li>)}</ul></details>}
    {item.status !== "confirmed" && <div className={styles.confirmForm}>
      {candidates.length > 0 && <label>候选作品<select value={candidateIndex} onChange={(event) => setCandidateIndex(event.target.value)} disabled={frozen || busy}>
        {candidates.map((candidate, index) => <option key={`${candidate.mediaType}:${candidate.tmdbId}`} value={String(index)}>{candidate.title}{candidate.year ? ` (${candidate.year})` : ""} · {mediaTypeLabel(candidate.mediaType)} · TMDB {candidate.tmdbId}</option>)}
        <option value="manual">没有合适候选，手动输入 TMDB ID</option>
      </select></label>}
      {(!candidates.length || candidateIndex === "manual") && <div className={styles.manualFields}>
        <label>TMDB ID<input inputMode="numeric" value={manualId} onChange={(event) => setManualId(event.target.value)} placeholder="例如 12345" disabled={frozen || busy} /></label>
        <label>媒体类型<select value={mediaType} onChange={(event) => setMediaType(event.target.value as "movie" | "tv" | "anime")} disabled={frozen || busy}><option value="movie">电影</option><option value="tv">剧集</option><option value="anime">动画剧集</option></select></label>
      </div>}
      {chosen && <p className={styles.selectedCandidate}>将确认：{chosen.title}{chosen.year ? ` (${chosen.year})` : ""}，{mediaTypeLabel(chosen.mediaType)} · TMDB {chosen.tmdbId}。服务器会重新核实TMDB资料。</p>}
      {(chosen?.mediaType === "tv" || chosen?.mediaType === "anime" || (!chosen && mediaType !== "movie")) && <div className={styles.manualFields}>
        <label>季号<input inputMode="numeric" value={season} onChange={(event) => setSeason(event.target.value)} disabled={frozen || busy} /><small>0 表示特别篇。</small></label>
        <label>集号<input value={episodes} onChange={(event) => setEpisodes(event.target.value)} placeholder="例如 1-3, 5" disabled={frozen || busy} /><small>必填，支持逗号列表与范围，最多 50 集。</small></label>
      </div>}
      {formError && <p className={styles.formError} role="alert">{formError}</p>}
      <button className="primary-button" type="button" onClick={() => void choose()} disabled={frozen || busy || !item.file}><Check size={14} />确认文件身份</button>
      <p className={styles.separation}>这是对现有扫描文件做身份确认，不是选择下载或转存资源。</p>
    </div>}
    {item.status === "confirmed" && <p className={styles.confirmedIdentity}>身份：{mediaTypeLabel(item.mediaType ?? "未知")} · TMDB {item.tmdbId ?? "未知"}{item.seasonNumber !== null ? ` · 第 ${item.seasonNumber} 季` : ""}{item.importStatus === "imported" ? " · 已导入" : " · 等待导入"}</p>}
  </article>;
}

function mediaTypeLabel(type: string): string { return type === "movie" ? "电影" : type === "tv" ? "剧集" : type === "anime" ? "动画剧集" : "未知类型"; }
function jobStatusLabel(status: string): string { return ({ waiting: "等待扫描", pending: "等待识别", running: "识别中", completed: "已完成", cancelled: "已取消", failed: "失败" } as Record<string, string>)[status] ?? status; }
function formatBytes(value: number): string { return value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024 ** 3).toFixed(2)} GB`; }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date); }
