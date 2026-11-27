"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, CircleAlert, Folder, LoaderCircle, Pause, Play, Plus, RefreshCw, Save, Sparkles, Square, X } from "lucide-react";
import type { NamingTemplateKind } from "@media-track/workflow/library";
import { validateNamingTemplate } from "@media-track/workflow/naming";
import styles from "./library-scan-settings.module.css";
import { LibraryNamingTemplates } from "./library-naming-templates";
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
type SelectionChange = { storageId: string | null; configId: string | null; taskId: string | null; dirty: boolean };
export type LibraryWorkspaceTab = "rules" | "history" | "pending";
const TEMPLATE_KINDS = ["movieDirectory", "movieFile", "tvDirectory", "seasonDirectory", "episodeFile"] as const;

export function LibraryScanSettings({
  storages,
  defaultTemplates,
  settingsHref,
  activeTab = "rules",
  onSwitchTab,
  onSelectionChange,
}: {
  storages: readonly SafeLibraryStorage[];
  defaultTemplates: TemplateSet;
  settingsHref: string;
  activeTab?: LibraryWorkspaceTab;
  onSwitchTab?: (tab: LibraryWorkspaceTab) => void;
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
  const [autoOrganize, setAutoOrganize] = useState(true);
  const [templates, setTemplates] = useState<TemplateSet>(defaultTemplates);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [pickerKind, setPickerKind] = useState<PickerKind | null>(null);
  const [pickerPath, setPickerPath] = useState<Array<{ id: string; label: string }>>([]);
  const [directoryItems, setDirectoryItems] = useState<LibraryDirectoryChoice[]>([]);
  const [directoryNextPage, setDirectoryNextPage] = useState<number | null>(null);
  const [directoryNextCursor, setDirectoryNextCursor] = useState<string | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const generation = useRef(0);
  const pickerGeneration = useRef(0);
  const pickerController = useRef<AbortController | null>(null);
  const mainController = useRef<AbortController | null>(null);
  const selectionVersion = useRef(0);
  const draftSignatureRef = useRef("");
  const isCurrentScope = useCallback((id: string, scopeGeneration: number, signal: AbortSignal): boolean =>
    generation.current === scopeGeneration && storageId === id && !signal.aborted, [storageId]);
  const activeTaskId = tasks.find((task) => task.status === "running" || task.status === "queued" || task.status === "cancelling")?.taskId ?? null;

  const selectedConfiguration = configurations.find((item) => item.configId === selectedConfigId) ?? null;
  const draftShape = {
    sourceRoots: sourceRoots.map((root) => root.directoryId),
    movieTarget: movieTarget?.directoryId ?? null,
    tvTarget: tvTarget?.directoryId ?? null,
    mediaKind,
    autoOrganize,
  };
  const savedShape = selectedConfiguration ? {
    sourceRoots: selectedConfiguration.sourceRoots.map((root) => root.directoryId),
    movieTarget: selectedConfiguration.movieTargetDirectoryId,
    tvTarget: selectedConfiguration.tvTargetDirectoryId,
    mediaKind: selectedConfiguration.mediaKind,
    autoOrganize: selectedConfiguration.autoOrganize,
  } : { sourceRoots: [], movieTarget: null, tvTarget: null, mediaKind: "mixed", autoOrganize: true };
  const savedTemplates = normalizeTemplates(selectedConfiguration?.templates, defaultTemplates);
  const dirty = JSON.stringify(draftShape) !== JSON.stringify(savedShape) || !templatesEqual(templates, savedTemplates);
  const templatesInvalid = Object.values(templates).some((template) => validateNamingTemplate(template).length > 0);
  const draftSignature = JSON.stringify({ ...draftShape, templates: TEMPLATE_KINDS.map((kind) => templates[kind]) });
  const formDisabled = storage?.status !== "active" || saving || starting;
  useEffect(() => { draftSignatureRef.current = draftSignature; }, [draftSignature]);
  const notifySelection = useCallback((nextStorageId: string | null, nextConfigId: string | null, nextTaskId: string | null, nextDirty: boolean) => {
    onSelectionChange?.({ storageId: nextStorageId, configId: nextConfigId, taskId: nextTaskId, dirty: nextDirty });
  }, [onSelectionChange]);

  useEffect(() => {
    notifySelection(storageId, selectedConfigId, selectedTaskId, dirty);
  }, [notifySelection, storageId, selectedConfigId, selectedTaskId, dirty]);

  const applyConfiguration = useCallback((configuration: LibraryScanConfiguration | null) => {
    setSelectedConfigId(configuration?.configId ?? null);
    setSourceRoots(configuration?.sourceRoots.map((root) => ({ directoryId: root.directoryId, name: root.name })) ?? []);
    setMovieTarget(configuration?.movieTargetDirectoryId ? { directoryId: configuration.movieTargetDirectoryId, name: configuration.movieTargetDirectoryName || "已保存电影目标目录" } : null);
    setTvTarget(configuration?.tvTargetDirectoryId ? { directoryId: configuration.tvTargetDirectoryId, name: configuration.tvTargetDirectoryName || "已保存剧集目标目录" } : null);
    setMediaKind(configuration?.mediaKind ?? "mixed");
    setAutoOrganize(configuration?.autoOrganize ?? true);
    setTemplates(normalizeTemplates(configuration?.templates, defaultTemplates));
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
    setLoading(false); setSaving(false); setStarting(false); setBusyTaskId(null); setDirectoryLoading(false); setScanNotice(null);
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

  const canEdit = storage?.status === "active";
  const sourceRootIds = useMemo(() => new Set(sourceRoots.map((root) => root.directoryId)), [sourceRoots]);

  const changeStorage = (id: string) => {
    selectionVersion.current += 1;
    setStorageId(id);
    setScanNotice(null);
    applyConfiguration(null);
    setSelectedConfigId(null);
    setSelectedTaskId(null);
    notifySelection(id, null, null, false);
  };

  const selectConfiguration = (id: string) => {
    selectionVersion.current += 1;
    const configuration = configurations.find((item) => item.configId === id) ?? null;
    applyConfiguration(configuration);
    if (selectedTaskId && tasks.find((task) => task.taskId === selectedTaskId)?.configId !== id) setSelectedTaskId(null);
  };

  const beginNewConfiguration = () => {
    selectionVersion.current += 1;
    applyConfiguration(null);
    setSelectedConfigId(null);
    setSelectedTaskId(null);
  };

  const selectTask = (task: LibraryScanTask, knownConfiguration?: LibraryScanConfiguration) => {
    selectionVersion.current += 1;
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

  const loadDirectory = useCallback(async (parentId: string, page: number, cursor: string | null, replace: boolean) => {
    if (!storageId) return;
    const currentGeneration = generation.current;
    const currentPickerGeneration = ++pickerGeneration.current;
    pickerController.current?.abort();
    const controller = new AbortController();
    pickerController.current = controller;
    setDirectoryLoading(true);
    setDirectoryError(null);
    try {
      const result = await loadDirectoryPage(storageId, parentId, page, cursor, controller.signal);
      if (controller.signal.aborted || generation.current !== currentGeneration || pickerGeneration.current !== currentPickerGeneration) return;
      setDirectoryItems((current) => replace ? result.items : [...current, ...result.items]);
      setDirectoryNextPage(result.nextPage);
      setDirectoryNextCursor(result.nextCursor);
    } catch (error) {
      if (!controller.signal.aborted && pickerGeneration.current === currentPickerGeneration) setDirectoryError(error instanceof Error ? error.message : "读取目录失败。");
    } finally { if (!controller.signal.aborted && generation.current === currentGeneration && pickerGeneration.current === currentPickerGeneration) setDirectoryLoading(false); }
  }, [storageId]);

  const openPicker = (kind: PickerKind) => {
    setPickerKind(kind);
    const rootId = storage?.rootDirectoryId ?? "";
    setPickerPath([{ id: rootId, label: `${storage?.label ?? "网盘"}根目录` }]);
    setDirectoryItems([]); setDirectoryNextPage(null); setDirectoryNextCursor(null); setDirectoryError(null);
    void loadDirectory(rootId, 0, null, true);
  };

  const enterDirectory = (item: LibraryDirectoryChoice) => {
    const path = [...pickerPath, { id: item.directoryId, label: item.name }];
    setPickerPath(path); setDirectoryItems([]); setDirectoryNextPage(null); setDirectoryNextCursor(null);
    void loadDirectory(item.directoryId, 0, null, true);
  };

  const goBackInPicker = (index: number) => {
    const path = pickerPath.slice(0, index + 1);
    setPickerPath(path); setDirectoryItems([]); setDirectoryNextPage(null); setDirectoryNextCursor(null);
    void loadDirectory(path[path.length - 1]?.id ?? "", 0, null, true);
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
    dailyScheduleEnabled: false,
    autoOrganize,
    dailyScheduleTime: null,
    templates,
  });

  const persistConfiguration = async (id: string, scopeGeneration: number, signal: AbortSignal): Promise<LibraryScanConfiguration> => {
    if (!isCurrentScope(id, scopeGeneration, signal)) throw new DOMException("Aborted", "AbortError");
    const draftAtSave = draftSignatureRef.current;
    const selectionAtSave = selectionVersion.current;
    const saved = await saveScanConfiguration(buildPayload(id), signal);
    if (!isCurrentScope(id, scopeGeneration, signal)) throw new DOMException("Aborted", "AbortError");
    setConfigurations((current) => isCurrentScope(id, scopeGeneration, signal)
      ? [saved, ...current.filter((item) => item.configId !== saved.configId)] : current);
    if (selectionVersion.current === selectionAtSave) {
      if (draftSignatureRef.current === draftAtSave) applyConfiguration(saved);
      else setSelectedConfigId(saved.configId);
    }
    return saved;
  };

  const save = async () => {
    if (!storageId || !canEdit || templatesInvalid || saving || starting) return;
    const id = storageId; const scopeGeneration = generation.current; const signal = mainController.current?.signal;
    if (!signal) return;
    setSaving(true); setPageError(null);
    try { await persistConfiguration(id, scopeGeneration, signal); }
    catch (error) { if (isCurrentScope(id, scopeGeneration, signal)) setPageError(error instanceof Error ? error.message : "保存整理规则配置失败。"); }
    finally { if (isCurrentScope(id, scopeGeneration, signal)) setSaving(false); }
  };

  const start = async () => {
    if (!storageId || !canEdit || templatesInvalid || sourceRoots.length < 1 || saving || starting) return;
    const selectionAtStart = selectionVersion.current;
    const id = storageId; const scopeGeneration = generation.current; const signal = mainController.current?.signal;
    if (!signal) return;
    setStarting(true); setPageError(null); setScanNotice(null);
    try {
      const saved = await persistConfiguration(id, scopeGeneration, signal);
      if (!isCurrentScope(id, scopeGeneration, signal)) return;
      const task = await startLibraryScan(id, saved.configId, signal);
      if (!isCurrentScope(id, scopeGeneration, signal)) return;
      setTasks((current) => isCurrentScope(id, scopeGeneration, signal)
        ? [task, ...current.filter((item) => item.taskId !== task.taskId)] : current);
      if (selectionVersion.current === selectionAtStart) selectTask(task, saved);
      setScanNotice("已启动存量扫描：已入库影片将直接复用数据库身份（免重新识别），并按当前模板自动整理。");
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
        <strong>还没有连接可用网盘</strong>
        <p>连接网盘后即可配置入库整理目录、命名规则并整理存量媒体库。</p>
        <Link className="primary-button" href={settingsHref}>前往设置连接</Link>
      </section> : <>
        {/* 顶部网盘切换与入库自动整理核心状态条 */}
        <section className={`panel ${styles.panel}`}>
          <div className={styles.toolbar}>
            <div className={styles.storageSwitchGroup}>
              <div className={styles.storagePills} role="group" aria-label="快捷切换网盘">
                {storages.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`${styles.storagePill} ${item.id === storageId ? styles.storagePillActive : ""}`}
                    onClick={() => changeStorage(item.id)}
                  >
                    <span>{item.label}</span>
                    {item.status === "frozen" && <span className={styles.pillFrozen}>已冻结</span>}
                  </button>
                ))}
              </div>
              <label className={styles.storageField}>
                <span>当前网盘</span>
                <select value={storageId ?? ""} onChange={(event) => changeStorage(event.target.value)} aria-label="当前网盘">
                  {storages.map((item) => <option key={item.id} value={item.id}>{item.label}{item.status === "frozen" ? "（已冻结）" : ""}</option>)}
                </select>
              </label>
            </div>

            <div className={styles.configSelectRow}>
              <label className={styles.storageField}>
                <span>已保存规则</span>
                <select value={selectedConfigId ?? ""} onChange={(event) => selectConfiguration(event.target.value)} disabled={!configurations.length || formDisabled}>
                  {!configurations.length && <option value="">尚未保存规则（使用默认全息模板）</option>}
                  {configurations.map((item, index) => <option key={item.configId} value={item.configId}>规则配置 {configurations.length - index}</option>)}
                </select>
              </label>
              <button className="secondary-button" type="button" onClick={beginNewConfiguration} disabled={formDisabled}><Plus size={15} />新建配置</button>
            </div>
          </div>

          <div className={`${styles.autoHero} ${autoOrganize ? "" : styles.autoHeroPaused}`} style={{ marginTop: 14 }}>
            <div className={styles.heroLeft}>
              <div className={styles.heroIcon}><Sparkles size={20} /></div>
              <div className={styles.heroCopy}>
                <div className={styles.heroTitle}>
                  <span>{autoOrganize ? "入库自动整理已默认开启" : "当前网盘自动整理已暂停"}</span>
                  <span className={styles.heroBadge}>{autoOrganize ? "实时自动整理" : "手动暂停中"}</span>
                </div>
                <p>新片获取、追更或机器人转存落盘后，将直接按下方命名规则提取清晰度 / 杜比视界 / 全景声并归档，无需定时扫描。已有老文件可在需要时手动扫描整理。</p>
              </div>
            </div>
            <div className={styles.heroActions}>
              <label className={styles.switchCard}>
                <span>启用自动整理</span>
                <input type="checkbox" checked={autoOrganize} onChange={(event) => setAutoOrganize(event.target.checked)} disabled={formDisabled} />
              </label>
              {onSwitchTab && activeTab !== "pending" && (
                <button className="secondary-button" type="button" onClick={() => onSwitchTab("pending")}>
                  存量扫描任务
                </button>
              )}
              <button className="secondary-button" type="button" onClick={() => void save()} disabled={formDisabled || templatesInvalid || sourceRoots.length === 0}>
                <Save size={15} />{saving ? "保存中…" : "保存配置"}
              </button>
              <button className="primary-button" type="button" onClick={() => void start()} disabled={formDisabled || templatesInvalid || sourceRoots.length === 0}>
                <Play size={15} />{starting ? "开始中…" : "保存并开始扫描"}
              </button>
            </div>
          </div>

          {storage?.status === "frozen" && <div className={styles.notice} style={{ marginTop: 12 }}>该网盘连接已冻结，可查看已有配置和任务；恢复连接后才能修改配置或开始扫描。</div>}
          {pageError && <div className={styles.error} role="alert" style={{ marginTop: 12 }}><CircleAlert size={17} /><span>{pageError}</span><button className="secondary-button" onClick={reload}><RefreshCw size={14} />重试</button></div>}
          {scanNotice && <div className={styles.notice} role="status" style={{ marginTop: 12, color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 10%, transparent)", borderColor: "color-mix(in srgb, var(--accent) 28%, transparent)" }}><span>{scanNotice}</span>{onSwitchTab && activeTab !== "pending" && <button className="secondary-button" type="button" onClick={() => onSwitchTab("pending")}>查看扫描与识别进度</button>}</div>}
          {dirty && <div className={styles.notice} role="status" style={{ marginTop: 12 }}>有未保存的配置或模板修改；整理预览只使用已保存的配置。</div>}
          {loading && configurations.length === 0 && <div className={styles.loading}><LoaderCircle size={18} className={styles.spin} />正在读取已保存配置与扫描任务…</div>}
        </section>

        {/* 标签一：目录流向映射 + 完美命名工坊 */}
        {activeTab === "rules" && (
          <>
            <section className={`panel ${styles.panel}`}>
              <div className={styles.panelHeader}>
                <div>
                  <h2>目录流向映射</h2>
                  <p>设定待整理来源根目录与电影/剧集目标根目录；整理全程保留多版本与字幕语言标记，不删除原视频。</p>
                </div>
                <button className="secondary-button" type="button" onClick={() => openPicker("sources")} disabled={formDisabled || sourceRoots.length >= 20}>
                  <Folder size={15} />选择来源目录
                </button>
              </div>

              <div className={styles.dirFlowGrid}>
                <div className={styles.dirNode}>
                  <span className={styles.dirNodeLabel}>扫描 / 待整理来源目录（可选 1–20 个）</span>
                  <div className={styles.sourceList}>
                    {sourceRoots.map((root) => (
                      <div className={styles.directoryChip} key={root.directoryId}>
                        <Folder size={15} />
                        <span title={root.directoryId}>{root.name}</span>
                        <button type="button" aria-label={`移除${root.name}`} onClick={() => setSourceRoots((current) => current.filter((entry) => entry.directoryId !== root.directoryId))} disabled={formDisabled}>
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    {sourceRoots.length === 0 && <p className={styles.hint}>请从当前网盘目录中选择一个或多个来源目录。</p>}
                  </div>
                </div>

                <div className={styles.flowBridge}>
                  <div className={styles.flowArrowPill}>智能识别后按模板归档 →</div>
                  <div className={styles.mediaKindRow} role="radiogroup" aria-label="媒体类型">
                    {([ ["movie", "电影"], ["tv", "剧集"], ["mixed", "电影与剧集"] ] as const).map(([value, label]) => (
                      <label className={styles.mediaKindPill} key={value}>
                        <input type="radio" name="media-kind" value={value} checked={mediaKind === value} onChange={() => setMediaKind(value)} disabled={formDisabled} />
                        {label}
                      </label>
                    ))}
                  </div>
                  <div className={styles.flowCaps}>
                    <span>保留字幕语言</span>
                    <span>多版本共存</span>
                    <span>写后自动通知</span>
                  </div>
                </div>

                <div className={styles.dirNode}>
                  <span className={styles.dirNodeLabel}>整理目标根目录（可留空）</span>
                  <TargetRow label="电影目标" value={movieTarget} onChoose={() => openPicker("movie")} onClear={() => setMovieTarget(null)} disabled={formDisabled} />
                  <TargetRow label="剧集目标" isTv value={tvTarget} onChoose={() => openPicker("tv")} onClear={() => setTvTarget(null)} disabled={formDisabled} />
                </div>
              </div>
            </section>

            <section className={`panel ${styles.panel}`}>
              <LibraryNamingTemplates
                value={templates}
                savedValue={savedTemplates}
                onChange={setTemplates}
                disabled={formDisabled}
                movieRootLabel={movieTarget?.name ?? "电影目标"}
                tvRootLabel={tvTarget?.name ?? "剧集目标"}
              />
            </section>
          </>
        )}

        {/* 标签三：存量扫描任务面板 */}
        {activeTab === "pending" && (
          <section className={`panel ${styles.panel}`}>
            <div className={styles.panelHeader}>
              <div><h2>扫描任务</h2><p>用于管理已有存量老目录的手动扫描进度；点击某个任务即可查看对应的识别结果与待确认项。</p></div>
              <button className="secondary-button" type="button" onClick={reload} disabled={loading}><RefreshCw size={14} />刷新</button>
            </div>
            {tasks.length === 0 && !loading ? <div className={styles.emptyTasks}>还没有扫描任务。配置好来源目录后点击「保存并开始扫描」，任务会显示在这里。</div> : <div className={styles.taskList}>
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
            {taskHasMore && <button className="secondary-button" type="button" style={{ marginTop: 12 }} onClick={() => void loadMoreTasks()} disabled={loading}>{loading ? "加载中…" : "加载更多任务"}<ChevronRight size={14} /></button>}
          </section>
        )}
      </>}

      {pickerKind && <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPickerKind(null); }}>
        <section className={`${styles.picker} panel`} role="dialog" aria-modal="true" aria-labelledby="directory-picker-title">
          <div className={styles.pickerHeader}><div><h2 id="directory-picker-title">选择{pickerKind === "sources" ? "扫描来源" : pickerKind === "movie" ? "电影目标" : "剧集目标"}目录</h2><p>只能选择此账号中实际浏览到的目录。</p></div><button className="secondary-button" onClick={() => setPickerKind(null)} aria-label="关闭目录选择器"><X size={16} /></button></div>
          <nav className={styles.breadcrumb} aria-label="目录路径">{pickerPath.map((entry, index) => <span key={`${entry.id}-${index}`}><button type="button" onClick={() => goBackInPicker(index)}>{entry.label}</button>{index < pickerPath.length - 1 && <ChevronRight size={14} />}</span>)}</nav>
          {directoryError && <div className={styles.error} role="alert"><span>{directoryError}</span><button className="secondary-button" onClick={() => void loadDirectory(pickerPath[pickerPath.length - 1]?.id ?? "", directoryItems.length ? (directoryNextPage ?? 0) : 0, directoryItems.length ? directoryNextCursor : null, directoryItems.length === 0)}>重试</button></div>}
          {directoryLoading && directoryItems.length === 0 && <div className={styles.loading}><LoaderCircle size={18} className={styles.spin} />正在读取目录…</div>}
          <div className={styles.directoryList}>
            {directoryItems.map((item) => <div className={styles.directoryRow} key={item.directoryId}>
              <button className={styles.directoryName} type="button" onClick={() => enterDirectory(item)}><Folder size={17} /><span>{item.name}</span><ChevronRight size={15} /></button>
              <button className="secondary-button" type="button" onClick={() => chooseDirectory(item)} disabled={pickerKind === "sources" && (sourceRootIds.has(item.directoryId) || sourceRoots.length >= 20)}>{pickerKind === "sources" ? (sourceRootIds.has(item.directoryId) ? <><Check size={14} />已添加</> : <><Plus size={14} />添加来源</>) : "选择此目录"}</button>
            </div>)}
            {!directoryItems.length && !directoryLoading && !directoryError && <div className={styles.emptyDirectory}>此目录下没有可选子目录。</div>}
          </div>
          {directoryNextPage !== null && <button className="secondary-button" type="button" onClick={() => void loadDirectory(pickerPath[pickerPath.length - 1]?.id ?? "", directoryNextPage, directoryNextCursor, false)} disabled={directoryLoading}>{directoryLoading ? "读取中…" : "加载更多目录"}<ChevronRight size={14} /></button>}
          <div className={styles.pickerFooter}><button className="secondary-button" type="button" onClick={() => pickerPath.length > 1 ? goBackInPicker(pickerPath.length - 2) : setPickerKind(null)}><ChevronLeft size={14} />{pickerPath.length > 1 ? "返回上级" : "取消"}</button></div>
        </section>
      </div>}
    </div>
  );
}

function TargetRow({ label, value, onChoose, onClear, disabled, isTv = false }: {
  label: string;
  value: PickedRoot | null;
  onChoose: () => void;
  onClear: () => void;
  disabled: boolean;
  isTv?: boolean;
}) {
  return (
    <div className={styles.targetChipCard}>
      <span className={`${styles.targetTag} ${isTv ? styles.targetTagTv : ""}`}>{label}</span>
      <span className={styles.targetValue} title={value?.directoryId}>{value?.name ?? "未选择"}</span>
      {value ? (
        <button type="button" className={styles.clearTarget} onClick={onClear} aria-label={`清除${label}`} disabled={disabled}>
          <X size={14} />
        </button>
      ) : <span />}
      <button type="button" className="secondary-button" onClick={onChoose} disabled={disabled}>选择</button>
    </div>
  );
}

function statusLabel(status: LibraryScanTask["status"]): string {
  const labels: Record<LibraryScanTask["status"], string> = { queued: "排队中", running: "扫描中", paused: "已暂停", cancelling: "正在取消", cancelled: "已取消", completed: "已完成", partial: "部分完成", failed: "失败" };
  return labels[status];
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function templatesEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return TEMPLATE_KINDS.every((kind) => left[kind] === right[kind]);
}

function normalizeTemplates(source: Readonly<Record<string, string>> | undefined, fallback: TemplateSet): TemplateSet {
  return {
    movieDirectory: source?.movieDirectory ?? fallback.movieDirectory,
    movieFile: source?.movieFile ?? fallback.movieFile,
    tvDirectory: source?.tvDirectory ?? fallback.tvDirectory,
    seasonDirectory: source?.seasonDirectory ?? fallback.seasonDirectory,
    episodeFile: source?.episodeFile ?? fallback.episodeFile,
  };
}
