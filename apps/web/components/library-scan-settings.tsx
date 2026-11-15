"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, CircleAlert, Folder, LoaderCircle, Pause, Play, Plus, RefreshCw, Save, Square, X } from "lucide-react";
import type { NamingTemplateKind } from "@media-track/workflow/library";
import styles from "./library-scan-settings.module.css";
import {
  controlLibraryScan,
  loadAllScanConfigurations,
  loadDirectoryPage,
  loadScanTaskPage,
  refreshLibraryScan,
  saveScanConfiguration,
  startLibraryScan,
  type LibraryDirectoryChoice,
  type LibraryScanConfiguration,
  type LibraryScanRoot,
  type LibraryScanTask,
  type SafeLibraryStorage,
} from "./library-scan-client";

type TemplateSet = Readonly<Record<NamingTemplateKind, string>>;
type PickedRoot = LibraryScanRoot & { selectionToken?: string };
type PickerKind = "sources" | "movie" | "tv";
type SelectionChange = { storageId: string | null; configId: string | null; taskId: string | null };

export function LibraryScanSettings({
  storages,
  defaultTemplates,
  settingsHref,
  onSelectionChange,
}: {
  storages: readonly SafeLibraryStorage[];
  defaultTemplates: TemplateSet;
  settingsHref: string;
  onSelectionChange?: (selection: SelectionChange) => void;
}) {
  const initialStorage = storages.find((storage) => storage.status === "active") ?? storages[0] ?? null;
  const [storageId, setStorageId] = useState<string | null>(initialStorage?.id ?? null);
  const storage = storages.find((item) => item.id === storageId) ?? null;
  const [configurations, setConfigurations] = useState<LibraryScanConfiguration[]>([]);
  const [tasks, setTasks] = useState<LibraryScanTask[]>([]);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const [taskHasMore, setTaskHasMore] = useState(false);
  const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [sourceRoots, setSourceRoots] = useState<PickedRoot[]>([]);
  const [movieTarget, setMovieTarget] = useState<PickedRoot | null>(null);
  const [tvTarget, setTvTarget] = useState<PickedRoot | null>(null);
  const [mediaKind, setMediaKind] = useState<"movie" | "tv" | "mixed">("mixed");
  const [dailyEnabled, setDailyEnabled] = useState(false);
  const [dailyTime, setDailyTime] = useState("03:00");
  const [templates, setTemplates] = useState<TemplateSet>(defaultTemplates);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pickerKind, setPickerKind] = useState<PickerKind | null>(null);
  const [pickerPath, setPickerPath] = useState<Array<{ id: string; label: string }>>([]);
  const [directoryItems, setDirectoryItems] = useState<LibraryDirectoryChoice[]>([]);
  const [directoryNextPage, setDirectoryNextPage] = useState<number | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const generation = useRef(0);
  const pickerGeneration = useRef(0);
  const pickerController = useRef<AbortController | null>(null);
  const mainController = useRef<AbortController | null>(null);
  const isCurrentScope = useCallback((id: string, scopeGeneration: number, signal: AbortSignal): boolean =>
    generation.current === scopeGeneration && storageId === id && !signal.aborted, [storageId]);
  const activeTaskId = tasks.find((task) => task.status === "running" || task.status === "queued" || task.status === "cancelling")?.taskId ?? null;

  const notifySelection = useCallback((nextStorageId: string | null, nextConfigId: string | null, nextTaskId: string | null) => {
    onSelectionChange?.({ storageId: nextStorageId, configId: nextConfigId, taskId: nextTaskId });
  }, [onSelectionChange]);

  useEffect(() => {
    notifySelection(storageId, selectedConfigId, selectedTaskId);
  }, [notifySelection, storageId, selectedConfigId, selectedTaskId]);

  const applyConfiguration = useCallback((configuration: LibraryScanConfiguration | null) => {
    setSelectedConfigId(configuration?.configId ?? null);
    setSourceRoots(configuration?.sourceRoots.map((root) => ({ directoryId: root.directoryId, name: root.name })) ?? []);
    setMovieTarget(configuration?.movieTargetDirectoryId ? { directoryId: configuration.movieTargetDirectoryId, name: configuration.movieTargetDirectoryName || "已保存电影目标目录" } : null);
    setTvTarget(configuration?.tvTargetDirectoryId ? { directoryId: configuration.tvTargetDirectoryId, name: configuration.tvTargetDirectoryName || "已保存剧集目标目录" } : null);
    setMediaKind(configuration?.mediaKind ?? "mixed");
    setDailyEnabled(configuration?.dailyScheduleEnabled ?? false);
    setDailyTime(configuration?.dailyScheduleTime ?? "03:00");
    setTemplates((configuration?.templates as TemplateSet | undefined) ?? defaultTemplates);
  }, [defaultTemplates]);

  const loadStorageData = useCallback(async (id: string, signal: AbortSignal, currentGeneration: number) => {
    setLoading(true);
    setPageError(null);
    setConfigurations([]);
    setTasks([]);
    setSelectedTaskId(null);
    setTaskCursor(null);
    setTaskHasMore(false);
    applyConfiguration(null);
    try {
      const [nextConfigurations, nextTasks] = await Promise.all([
        loadAllScanConfigurations(id, signal),
        loadScanTaskPage(id, null, signal),
      ]);
      if (generation.current !== currentGeneration) return;
      setConfigurations(nextConfigurations);
      setTasks(nextTasks.items);
      setTaskCursor(nextTasks.nextCursor);
      setTaskHasMore(nextTasks.hasMore);
      applyConfiguration(nextConfigurations[0] ?? null);
    } catch (error) {
      if (!signal.aborted && generation.current === currentGeneration) setPageError(error instanceof Error ? error.message : "加载库扫描信息失败。");
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, [applyConfiguration]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    mainController.current?.abort();
    pickerGeneration.current += 1;
    pickerController.current?.abort();
    pickerController.current = null;
    setPickerKind(null);
    setLoading(false); setSaving(false); setStarting(false); setBusyTaskId(null); setDirectoryLoading(false);
    const controller = new AbortController();
    mainController.current = controller;
    if (storageId) void loadStorageData(storageId, controller.signal, currentGeneration);
    else {
      setConfigurations([]); setTasks([]); setSelectedConfigId(null); setSelectedTaskId(null); setLoading(false);
    }
    return () => {
      controller.abort();
      if (mainController.current === controller) mainController.current = null;
      pickerController.current?.abort();
    };
  }, [storageId, loadStorageData]);

  useEffect(() => {
    if (!storageId || !activeTaskId) return;
    const scopeGeneration = generation.current;
    const scopeId = storageId;
    const controller = new AbortController();
    const poll = async () => {
      if (document.visibilityState === "hidden" || controller.signal.aborted) return;
      const id = storageId;
      try {
        const activeTasks = tasks.filter((task) => task.status === "running" || task.status === "queued" || task.status === "cancelling");
        const refreshed = await Promise.all(activeTasks.map((task) => refreshLibraryScan(id, task.taskId, controller.signal)));
        if (isCurrentScope(id, scopeGeneration, controller.signal) && id === scopeId) {
          setTasks((current) => isCurrentScope(id, scopeGeneration, controller.signal)
            ? current.map((task) => refreshed.find((item) => item.taskId === task.taskId) ?? task) : current);
        }
      } catch (error) {
        if (isCurrentScope(id, scopeGeneration, controller.signal)) setPageError(error instanceof Error ? error.message : "刷新扫描状态失败。");
      }
    };
    const timer = window.setInterval(() => void poll(), 5_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); controller.abort(); };
  }, [storageId, activeTaskId, tasks, isCurrentScope]);

  const selectedConfiguration = configurations.find((item) => item.configId === selectedConfigId) ?? null;
  const canEdit = storage?.status === "active";
  const sourceRootIds = useMemo(() => new Set(sourceRoots.map((root) => root.directoryId)), [sourceRoots]);

  const selectConfiguration = (id: string) => {
    const configuration = configurations.find((item) => item.configId === id) ?? null;
    applyConfiguration(configuration);
    if (selectedTaskId && tasks.find((task) => task.taskId === selectedTaskId)?.configId !== id) setSelectedTaskId(null);
  };

  const beginNewConfiguration = () => {
    applyConfiguration(null);
    setSelectedConfigId(null);
    setSelectedTaskId(null);
  };

  const selectTask = (task: LibraryScanTask, knownConfiguration?: LibraryScanConfiguration) => {
    setSelectedTaskId(task.taskId);
    const configuration = knownConfiguration ?? configurations.find((item) => item.configId === task.configId) ?? null;
    applyConfiguration(configuration);
  };

  const reload = () => {
    if (!storageId) return;
    mainController.current?.abort();
    const controller = new AbortController();
    mainController.current = controller;
    const currentGeneration = ++generation.current;
    setSaving(false); setStarting(false); setBusyTaskId(null);
    void loadStorageData(storageId, controller.signal, currentGeneration);
  };

  const loadDirectory = useCallback(async (parentId: string, page: number, replace: boolean) => {
    if (!storageId) return;
    const currentGeneration = generation.current;
    const currentPickerGeneration = ++pickerGeneration.current;
    pickerController.current?.abort();
    const controller = new AbortController();
    pickerController.current = controller;
    setDirectoryLoading(true);
    setDirectoryError(null);
    try {
      const result = await loadDirectoryPage(storageId, parentId, page, controller.signal);
      if (controller.signal.aborted || generation.current !== currentGeneration || pickerGeneration.current !== currentPickerGeneration) return;
      setDirectoryItems((current) => replace ? result.items : [...current, ...result.items]);
      setDirectoryNextPage(result.nextPage);
    } catch (error) {
      if (!controller.signal.aborted && pickerGeneration.current === currentPickerGeneration) setDirectoryError(error instanceof Error ? error.message : "读取目录失败。");
    } finally { if (!controller.signal.aborted && generation.current === currentGeneration && pickerGeneration.current === currentPickerGeneration) setDirectoryLoading(false); }
  }, [storageId]);

  const openPicker = (kind: PickerKind) => {
    setPickerKind(kind);
    setPickerPath([{ id: "", label: "光鸭网盘根目录" }]);
    setDirectoryItems([]); setDirectoryNextPage(null); setDirectoryError(null);
    void loadDirectory("", 0, true);
  };

  const enterDirectory = (item: LibraryDirectoryChoice) => {
    const path = [...pickerPath, { id: item.directoryId, label: item.name }];
    setPickerPath(path); setDirectoryItems([]); setDirectoryNextPage(null);
    void loadDirectory(item.directoryId, 0, true);
  };

  const goBackInPicker = (index: number) => {
    const path = pickerPath.slice(0, index + 1);
    setPickerPath(path); setDirectoryItems([]); setDirectoryNextPage(null);
    void loadDirectory(path[path.length - 1]?.id ?? "", 0, true);
  };

  const chooseDirectory = (item: LibraryDirectoryChoice) => {
    if (pickerKind === "sources") {
      setSourceRoots((current) => current.some((root) => root.directoryId === item.directoryId)
        ? current : [...current, { directoryId: item.directoryId, name: item.name, selectionToken: item.selectionToken }]);
    } else if (pickerKind === "movie") setMovieTarget({ directoryId: item.directoryId, name: item.name, selectionToken: item.selectionToken });
    else if (pickerKind === "tv") setTvTarget({ directoryId: item.directoryId, name: item.name, selectionToken: item.selectionToken });
    setPickerKind(null);
  };

  const buildPayload = (id: string) => ({
    ...(selectedConfigId ? { configId: selectedConfigId } : {}),
    storageId: id,
    sourceRoots: sourceRoots.map(({ directoryId, selectionToken }) => ({ directoryId, ...(selectionToken ? { selectionToken } : {}) })),
    movieTargetDirectoryId: movieTarget?.directoryId ?? null,
    ...(movieTarget?.selectionToken ? { movieTargetSelectionToken: movieTarget.selectionToken } : {}),
    tvTargetDirectoryId: tvTarget?.directoryId ?? null,
    ...(tvTarget?.selectionToken ? { tvTargetSelectionToken: tvTarget.selectionToken } : {}),
    mediaKind,
    dailyScheduleEnabled: dailyEnabled,
    dailyScheduleTime: dailyEnabled ? dailyTime : null,
    templates: selectedConfiguration?.templates ?? templates,
  });

  const persistConfiguration = async (id: string, scopeGeneration: number, signal: AbortSignal): Promise<LibraryScanConfiguration> => {
    if (!isCurrentScope(id, scopeGeneration, signal)) throw new DOMException("Aborted", "AbortError");
    const saved = await saveScanConfiguration(buildPayload(id), signal);
    if (!isCurrentScope(id, scopeGeneration, signal)) throw new DOMException("Aborted", "AbortError");
    setConfigurations((current) => isCurrentScope(id, scopeGeneration, signal)
      ? [saved, ...current.filter((item) => item.configId !== saved.configId)] : current);
    applyConfiguration(saved);
    return saved;
  };

  const save = async () => {
    if (!storageId || !canEdit) return;
    const id = storageId; const scopeGeneration = generation.current; const signal = mainController.current?.signal;
    if (!signal) return;
    setSaving(true); setPageError(null);
    try { await persistConfiguration(id, scopeGeneration, signal); }
    catch (error) { if (isCurrentScope(id, scopeGeneration, signal)) setPageError(error instanceof Error ? error.message : "保存扫描配置失败。"); }
    finally { if (isCurrentScope(id, scopeGeneration, signal)) setSaving(false); }
  };

  const start = async () => {
    if (!storageId || !canEdit || sourceRoots.length < 1) return;
    const id = storageId; const scopeGeneration = generation.current; const signal = mainController.current?.signal;
    if (!signal) return;
    setStarting(true); setPageError(null);
    try {
      const saved = await persistConfiguration(id, scopeGeneration, signal);
      if (!isCurrentScope(id, scopeGeneration, signal)) return;
      const task = await startLibraryScan(id, saved.configId, signal);
      if (!isCurrentScope(id, scopeGeneration, signal)) return;
      setTasks((current) => isCurrentScope(id, scopeGeneration, signal)
        ? [task, ...current.filter((item) => item.taskId !== task.taskId)] : current);
      selectTask(task, saved);
    } catch (error) { if (isCurrentScope(id, scopeGeneration, signal)) setPageError(error instanceof Error ? error.message : "开始扫描失败。"); }
    finally { if (isCurrentScope(id, scopeGeneration, signal)) setStarting(false); }
  };

  const controlTask = async (task: LibraryScanTask, action: "pause" | "resume" | "cancel" | "retry") => {
    if (!storageId || !canEdit || busyTaskId) return;
    const id = storageId; const scopeGeneration = generation.current; const signal = mainController.current?.signal;
    if (!signal) return;
    setBusyTaskId(task.taskId); setPageError(null);
    try {
      const updated = await controlLibraryScan(id, task.taskId, action, signal);
      if (!isCurrentScope(id, scopeGeneration, signal)) return;
      setTasks((current) => isCurrentScope(id, scopeGeneration, signal)
        ? current.map((item) => item.taskId === updated.taskId ? updated : item) : current);
      selectTask(updated);
    } catch (error) { if (isCurrentScope(id, scopeGeneration, signal)) setPageError(error instanceof Error ? error.message : "扫描操作失败。"); }
    finally { if (isCurrentScope(id, scopeGeneration, signal)) setBusyTaskId(null); }
  };

  const loadMoreTasks = async () => {
    if (!storageId || !taskCursor || loading) return;
    const id = storageId; const scopeGeneration = generation.current; const cursor = taskCursor;
    const scopeSignal = mainController.current?.signal;
    if (!scopeSignal) return;
    const controller = new AbortController();
    const abortOnScopeChange = () => controller.abort();
    scopeSignal.addEventListener("abort", abortOnScopeChange, { once: true });
    setLoading(true); setPageError(null);
    try {
      const page = await loadScanTaskPage(id, cursor, controller.signal);
      if (!isCurrentScope(id, scopeGeneration, controller.signal)) return;
      setTasks((current) => isCurrentScope(id, scopeGeneration, controller.signal)
        ? [...current, ...page.items.filter((item) => !current.some((known) => known.taskId === item.taskId))] : current);
      setTaskCursor(page.nextCursor); setTaskHasMore(page.hasMore);
    } catch (error) { if (isCurrentScope(id, scopeGeneration, controller.signal)) setPageError(error instanceof Error ? error.message : "加载更多任务失败。"); }
    finally {
      scopeSignal.removeEventListener("abort", abortOnScopeChange);
      if (isCurrentScope(id, scopeGeneration, controller.signal)) setLoading(false);
    }
  };

  const emptyStorages = storages.length === 0;
  return (
    <div className={styles.root}>
      {emptyStorages ? <section className={`panel ${styles.empty}`}>
        <strong>还没有连接光鸭网盘</strong>
        <p>连接光鸭后即可选择媒体目录并创建扫描任务。</p>
        <Link className="primary-button" href={settingsHref}>前往设置连接</Link>
      </section> : <>
        <section className={`panel ${styles.panel}`}>
          <div className={styles.panelHeader}>
            <div><h2>扫描配置</h2><p>扫描只读取已选目录，不会自动补缺或整理文件。</p></div>
            <label className={styles.storageField}>
              <span>当前网盘</span>
              <select value={storageId ?? ""} onChange={(event) => setStorageId(event.target.value)} aria-label="当前网盘">
                {storages.map((item) => <option key={item.id} value={item.id}>{item.label}{item.status === "frozen" ? "（已冻结）" : ""}</option>)}
              </select>
            </label>
          </div>
          {storage?.status === "frozen" && <div className={styles.notice}>该光鸭连接已冻结，可查看已有配置和任务；恢复连接后才能修改配置或开始扫描。</div>}
          {pageError && <div className={styles.error} role="alert"><CircleAlert size={17} /> <span>{pageError}</span><button className="secondary-button" onClick={reload}><RefreshCw size={14} />重试</button></div>}
          {loading && configurations.length === 0 && <div className={styles.loading}><LoaderCircle size={18} className={styles.spin} />正在读取已保存配置与扫描任务…</div>}
          <div className={styles.configSelectRow}>
            <label className={styles.storageField}>
              <span>已保存配置</span>
              <select value={selectedConfigId ?? ""} onChange={(event) => selectConfiguration(event.target.value)} disabled={!configurations.length}>
                {!configurations.length && <option value="">尚无保存配置</option>}
                {configurations.map((item, index) => <option key={item.configId} value={item.configId}>扫描配置 {configurations.length - index}</option>)}
              </select>
            </label>
            <button className="secondary-button" type="button" onClick={beginNewConfiguration} disabled={!canEdit}><Plus size={15} />新建配置</button>
          </div>

          <div className={styles.formGrid}>
            <fieldset className={styles.fieldset}>
              <legend>扫描来源目录 <span>可选 1–20 个</span></legend>
              <div className={styles.sourceList}>
                {sourceRoots.map((root) => <div className={styles.directoryChip} key={root.directoryId}>
                  <Folder size={15} /><span title={root.directoryId}>{root.name}</span>
                  <button type="button" aria-label={`移除${root.name}`} onClick={() => setSourceRoots((current) => current.filter((entry) => entry.directoryId !== root.directoryId))} disabled={!canEdit}><X size={14} /></button>
                </div>)}
                {sourceRoots.length === 0 && <p className={styles.hint}>从光鸭目录中选择一个或多个来源。</p>}
              </div>
              <button className="secondary-button" type="button" onClick={() => openPicker("sources")} disabled={!canEdit || sourceRoots.length >= 20}><Folder size={15} />选择来源目录</button>
            </fieldset>

            <fieldset className={styles.fieldset}>
              <legend>媒体类型</legend>
              <div className={styles.radioRow}>
                {([ ["movie", "电影"], ["tv", "剧集"], ["mixed", "电影与剧集"] ] as const).map(([value, label]) => <label key={value}><input type="radio" name="media-kind" value={value} checked={mediaKind === value} onChange={() => setMediaKind(value)} disabled={!canEdit} />{label}</label>)}
              </div>
            </fieldset>

            <fieldset className={styles.fieldset}>
              <legend>整理目标目录 <span>可留空</span></legend>
              <TargetRow label="电影目标" value={movieTarget} onChoose={() => openPicker("movie")} onClear={() => setMovieTarget(null)} disabled={!canEdit} />
              <TargetRow label="剧集目标" value={tvTarget} onChoose={() => openPicker("tv")} onClear={() => setTvTarget(null)} disabled={!canEdit} />
            </fieldset>

            <fieldset className={styles.fieldset}>
              <legend>每日扫描</legend>
              <div className={styles.scheduleRow}>
                <label><input type="checkbox" checked={dailyEnabled} onChange={(event) => setDailyEnabled(event.target.checked)} disabled={!canEdit} />启用定时扫描</label>
                <label className={styles.timeField}>时间（上海）<input type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} disabled={!canEdit || !dailyEnabled} /></label>
              </div>
              <p className={styles.hint}>时区：Asia/Shanghai。启用定时扫描后由服务端按此时间运行。</p>
            </fieldset>
          </div>

          <div className={styles.actions}>
            <button className="secondary-button" type="button" onClick={() => void save()} disabled={!canEdit || saving || starting || sourceRoots.length === 0}><Save size={15} />{saving ? "保存中…" : "保存配置"}</button>
            <button className="primary-button" type="button" onClick={() => void start()} disabled={!canEdit || saving || starting || sourceRoots.length === 0}><Play size={15} />{starting ? "开始中…" : "保存并开始扫描"}</button>
          </div>
        </section>

        <section className={`panel ${styles.panel}`}>
          <div className={styles.panelHeader}>
            <div><h2>扫描任务</h2><p>任务状态和摘要来自持久化扫描记录，页面不会自动创建任务。</p></div>
            <button className="secondary-button" type="button" onClick={reload} disabled={loading}><RefreshCw size={14} />刷新</button>
          </div>
          {tasks.length === 0 && !loading ? <div className={styles.emptyTasks}>还没有扫描任务。保存配置并开始扫描后，任务会显示在这里。</div> : <div className={styles.taskList}>
            {tasks.map((task) => <article className={`${styles.task} ${selectedTaskId === task.taskId ? styles.selectedTask : ""}`} key={task.taskId}>
              <button type="button" className={styles.taskSelect} aria-label={`查看${statusLabel(task.status)}任务的识别结果 ${task.taskId}`} onClick={() => selectTask(task)}>
                <span className={`${styles.statusDot} ${styles[`status_${task.status}`] ?? ""}`} />
                <span className={styles.taskTitle}>{statusLabel(task.status)}</span>
                <span className={styles.taskTime}>{formatDate(task.updatedAt)}</span>
              </button>
              <div className={styles.taskStats}><span>已扫描目录 <b>{task.directoriesDone}</b> / {task.directoriesDiscovered}</span><span>发现文件 <b>{task.filesDiscovered}</b></span><span>失败 <b>{task.failures.length}</b></span></div>
              {task.failures.length > 0 && <details className={styles.failures}><summary>失败摘要（{task.failures.length}）</summary><ul>{task.failures.slice(0, 5).map((failure, index) => <li key={`${failure.directoryId}:${failure.page}:${index}`}>目录 {failure.directoryId} · 第 {failure.page + 1} 页：{failure.message}</li>)}</ul></details>}
              <div className={styles.taskActions}>
                {task.status === "running" && <button className="secondary-button" type="button" onClick={() => void controlTask(task, "pause")} disabled={!canEdit || busyTaskId !== null}><Pause size={14} />暂停</button>}
                {task.status === "paused" && <button className="secondary-button" type="button" onClick={() => void controlTask(task, "resume")} disabled={!canEdit || busyTaskId !== null}><Play size={14} />继续</button>}
                {(task.status === "running" || task.status === "queued" || task.status === "paused") && <button className="secondary-button" type="button" onClick={() => void controlTask(task, "cancel")} disabled={!canEdit || busyTaskId !== null}><Square size={13} />取消</button>}
                {(task.status === "failed" || task.status === "partial") && <button className="secondary-button" type="button" onClick={() => void controlTask(task, "retry")} disabled={!canEdit || busyTaskId !== null}><RefreshCw size={14} />重试失败项</button>}
                {busyTaskId === task.taskId && <span className={styles.busyLabel}><LoaderCircle size={14} className={styles.spin} />正在提交…</span>}
              </div>
            </article>)}
          </div>}
          {taskHasMore && <button className="secondary-button" type="button" onClick={() => void loadMoreTasks()} disabled={loading}>{loading ? "加载中…" : "加载更多任务"}<ChevronRight size={14} /></button>}
        </section>
      </>}

      {pickerKind && <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPickerKind(null); }}>
        <section className={`${styles.picker} panel`} role="dialog" aria-modal="true" aria-labelledby="directory-picker-title">
          <div className={styles.pickerHeader}><div><h2 id="directory-picker-title">选择{pickerKind === "sources" ? "扫描来源" : pickerKind === "movie" ? "电影目标" : "剧集目标"}目录</h2><p>只能选择此光鸭账号中实际浏览到的目录。</p></div><button className="secondary-button" onClick={() => setPickerKind(null)} aria-label="关闭目录选择器"><X size={16} /></button></div>
          <nav className={styles.breadcrumb} aria-label="目录路径">{pickerPath.map((entry, index) => <span key={`${entry.id}-${index}`}><button type="button" onClick={() => goBackInPicker(index)}>{entry.label}</button>{index < pickerPath.length - 1 && <ChevronRight size={14} />}</span>)}</nav>
          {directoryError && <div className={styles.error} role="alert"><span>{directoryError}</span><button className="secondary-button" onClick={() => void loadDirectory(pickerPath[pickerPath.length - 1]?.id ?? "", directoryItems.length ? (directoryNextPage ?? 0) : 0, directoryItems.length === 0)}>重试</button></div>}
          {directoryLoading && directoryItems.length === 0 && <div className={styles.loading}><LoaderCircle size={18} className={styles.spin} />正在读取目录…</div>}
          <div className={styles.directoryList}>
            {directoryItems.map((item) => <div className={styles.directoryRow} key={item.directoryId}>
              <button className={styles.directoryName} type="button" onClick={() => enterDirectory(item)}><Folder size={17} /><span>{item.name}</span><ChevronRight size={15} /></button>
              <button className="secondary-button" type="button" onClick={() => chooseDirectory(item)} disabled={pickerKind === "sources" && (sourceRootIds.has(item.directoryId) || sourceRoots.length >= 20)}>{pickerKind === "sources" ? (sourceRootIds.has(item.directoryId) ? <><Check size={14} />已添加</> : <><Plus size={14} />添加来源</>) : "选择此目录"}</button>
            </div>)}
            {!directoryItems.length && !directoryLoading && !directoryError && <div className={styles.emptyDirectory}>此目录下没有可选子目录。</div>}
          </div>
          {directoryNextPage !== null && <button className="secondary-button" type="button" onClick={() => void loadDirectory(pickerPath[pickerPath.length - 1]?.id ?? "", directoryNextPage, false)} disabled={directoryLoading}>{directoryLoading ? "读取中…" : "加载更多目录"}<ChevronRight size={14} /></button>}
          <div className={styles.pickerFooter}><button className="secondary-button" type="button" onClick={() => pickerPath.length > 1 ? goBackInPicker(pickerPath.length - 2) : setPickerKind(null)}><ChevronLeft size={14} />{pickerPath.length > 1 ? "返回上级" : "取消"}</button></div>
        </section>
      </div>}
    </div>
  );
}

function TargetRow({ label, value, onChoose, onClear, disabled }: { label: string; value: PickedRoot | null; onChoose: () => void; onClear: () => void; disabled: boolean }) {
  return <div className={styles.targetRow}><span>{label}</span><span className={styles.targetValue} title={value?.directoryId}>{value?.name ?? "未选择"}</span>{value && <button type="button" className={styles.clearTarget} onClick={onClear} aria-label={`清除${label}`} disabled={disabled}><X size={14} /></button>}<button type="button" className="secondary-button" onClick={onChoose} disabled={disabled}>选择</button></div>;
}

function statusLabel(status: LibraryScanTask["status"]): string {
  const labels: Record<LibraryScanTask["status"], string> = { queued: "排队中", running: "扫描中", paused: "已暂停", cancelling: "正在取消", cancelled: "已取消", completed: "已完成", partial: "部分完成", failed: "失败" };
  return labels[status];
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date);
}
