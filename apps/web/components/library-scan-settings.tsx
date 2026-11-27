"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check, ChevronLeft, ChevronRight, CircleAlert, Folder, LoaderCircle,
  Pause, Play, Plus, RefreshCw, RotateCcw, Save, Sparkles, Square, X,
} from "lucide-react";
import type { NamingTemplateKind } from "@media-track/workflow/library";
import {
  DEFAULT_ORGANIZE_CONCURRENCY,
  MAX_ORGANIZE_CONCURRENCY,
  MIN_ORGANIZE_CONCURRENCY,
  validateNamingTemplate,
} from "@media-track/workflow/naming";
import styles from "./library-scan-settings.module.css";
import { LibraryNamingTemplates } from "./library-naming-templates";
import { stopOrganizations } from "./library-organization-client";
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
type ExtraSourceRoot = PickedRoot & { checked: boolean };
type PickerKind = "extra" | "movie" | "tv";
type SelectionChange = { storageId: string | null; configId: string | null; taskId: string | null; dirty: boolean };
export type LibraryWorkspaceTab = "organize" | "pending";
const TEMPLATE_KINDS = ["movieDirectory", "movieFile", "tvDirectory", "seasonDirectory", "episodeFile"] as const;
const CONCURRENCY_OPTIONS = Array.from(
  { length: MAX_ORGANIZE_CONCURRENCY - MIN_ORGANIZE_CONCURRENCY + 1 },
  (_, index) => MIN_ORGANIZE_CONCURRENCY + index,
);

export function LibraryScanSettings({
  storages,
  defaultTemplates,
  settingsHref,
  activeTab = "organize",
  hasActiveWork = false,
  onStopWork,
  onSwitchTab,
  onScanStarted,
  onSelectionChange,
}: {
  storages: readonly SafeLibraryStorage[];
  defaultTemplates: TemplateSet;
  settingsHref: string;
  activeTab?: LibraryWorkspaceTab;
  hasActiveWork?: boolean;
  onStopWork?: () => void;
  onSwitchTab?: (tab: LibraryWorkspaceTab) => void;
  onScanStarted?: () => void;
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

  const [movieTarget, setMovieTarget] = useState<PickedRoot | null>(initialStorage?.defaultMovieDirectory ?? null);
  const [tvTarget, setTvTarget] = useState<PickedRoot | null>(initialStorage?.defaultTvDirectory ?? null);
  const [includeMovieSource, setIncludeMovieSource] = useState(Boolean(initialStorage?.defaultMovieDirectory));
  const [includeTvSource, setIncludeTvSource] = useState(Boolean(initialStorage?.defaultTvDirectory));
  const [extraRoots, setExtraRoots] = useState<ExtraSourceRoot[]>([]);
  const [mediaKind, setMediaKind] = useState<"movie" | "tv" | "mixed">("mixed");
  const [dailyScheduleEnabled, setDailyScheduleEnabled] = useState(false);
  const [dailyScheduleTime, setDailyScheduleTime] = useState("03:00");
  const [autoOrganize, setAutoOrganize] = useState(true);
  const [organizeConcurrency, setOrganizeConcurrency] = useState<number>(DEFAULT_ORGANIZE_CONCURRENCY);
  const [templates, setTemplates] = useState<TemplateSet>(defaultTemplates);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stoppingWork, setStoppingWork] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

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

  const selectedSourceRoots = useMemo(() => {
    const picked: PickedRoot[] = [];
    const seen = new Set<string>();
    const pushUnique = (root: PickedRoot | null | undefined) => {
      if (!root || seen.has(root.directoryId)) return;
      seen.add(root.directoryId);
      picked.push(root);
    };
    if (includeMovieSource) pushUnique(movieTarget);
    if (includeTvSource) pushUnique(tvTarget);
    for (const root of extraRoots) {
      if (root.checked) pushUnique({ directoryId: root.directoryId, name: root.name, ...(root.selectionToken ? { selectionToken: root.selectionToken } : {}) });
    }
    return picked;
  }, [extraRoots, includeMovieSource, includeTvSource, movieTarget, tvTarget]);

  const draftShape = useMemo(() => ({
    sourceRoots: selectedSourceRoots.map((root) => root.directoryId),
    movieTarget: movieTarget?.directoryId ?? null,
    tvTarget: tvTarget?.directoryId ?? null,
    mediaKind,
    dailyScheduleEnabled,
    dailyScheduleTime: dailyScheduleEnabled ? (dailyScheduleTime || "03:00") : null,
    autoOrganize,
    organizeConcurrency,
  }), [autoOrganize, dailyScheduleEnabled, dailyScheduleTime, mediaKind, movieTarget?.directoryId, organizeConcurrency, selectedSourceRoots, tvTarget?.directoryId]);

  const savedShape = useMemo(() => {
    if (selectedConfiguration) {
      return {
        sourceRoots: selectedConfiguration.sourceRoots.map((root) => root.directoryId),
        movieTarget: selectedConfiguration.movieTargetDirectoryId,
        tvTarget: selectedConfiguration.tvTargetDirectoryId,
        mediaKind: selectedConfiguration.mediaKind,
        dailyScheduleEnabled: selectedConfiguration.dailyScheduleEnabled,
        dailyScheduleTime: selectedConfiguration.dailyScheduleEnabled
          ? (selectedConfiguration.dailyScheduleTime ?? "03:00")
          : null,
        autoOrganize: selectedConfiguration.autoOrganize,
        organizeConcurrency: clampConcurrency(selectedConfiguration.organizeConcurrency),
      };
    }
    const defaults: string[] = [];
    if (storage?.defaultMovieDirectory) defaults.push(storage.defaultMovieDirectory.directoryId);
    if (storage?.defaultTvDirectory && !defaults.includes(storage.defaultTvDirectory.directoryId)) {
      defaults.push(storage.defaultTvDirectory.directoryId);
    }
    return {
      sourceRoots: defaults,
      movieTarget: storage?.defaultMovieDirectory?.directoryId ?? null,
      tvTarget: storage?.defaultTvDirectory?.directoryId ?? null,
      mediaKind: "mixed",
      dailyScheduleEnabled: false,
      dailyScheduleTime: null,
      autoOrganize: true,
      organizeConcurrency: DEFAULT_ORGANIZE_CONCURRENCY,
    };
  }, [selectedConfiguration, storage?.defaultMovieDirectory, storage?.defaultTvDirectory]);

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

  const applyConfiguration = useCallback((configuration: LibraryScanConfiguration | null, targetStorage: SafeLibraryStorage | null) => {
    setSelectedConfigId(configuration?.configId ?? null);
    if (!configuration) {
      const defMovie = targetStorage?.defaultMovieDirectory ?? null;
      const defTv = targetStorage?.defaultTvDirectory ?? null;
      setMovieTarget(defMovie);
      setTvTarget(defTv);
      setIncludeMovieSource(Boolean(defMovie));
      setIncludeTvSource(Boolean(defTv));
      setExtraRoots([]);
      setMediaKind("mixed");
      setDailyScheduleEnabled(false);
      setDailyScheduleTime("03:00");
      setAutoOrganize(true);
      setOrganizeConcurrency(DEFAULT_ORGANIZE_CONCURRENCY);
      setTemplates(defaultTemplates);
      return;
    }

    const nextMovie = configuration.movieTargetDirectoryId
      ? {
          directoryId: configuration.movieTargetDirectoryId,
          name: configuration.movieTargetDirectoryName
            || (targetStorage?.defaultMovieDirectory?.directoryId === configuration.movieTargetDirectoryId
              ? targetStorage.defaultMovieDirectory.name
              : "已保存电影目标目录"),
        }
      : (targetStorage?.defaultMovieDirectory ?? null);
    const nextTv = configuration.tvTargetDirectoryId
      ? {
          directoryId: configuration.tvTargetDirectoryId,
          name: configuration.tvTargetDirectoryName
            || (targetStorage?.defaultTvDirectory?.directoryId === configuration.tvTargetDirectoryId
              ? targetStorage.defaultTvDirectory.name
              : "已保存剧集目标目录"),
        }
      : (targetStorage?.defaultTvDirectory ?? null);

    setMovieTarget(nextMovie);
    setTvTarget(nextTv);
    const sourceIdSet = new Set(configuration.sourceRoots.map((root) => root.directoryId));
    setIncludeMovieSource(Boolean(nextMovie && sourceIdSet.has(nextMovie.directoryId)));
    setIncludeTvSource(Boolean(nextTv && sourceIdSet.has(nextTv.directoryId)));
    const targetIds = new Set([nextMovie?.directoryId, nextTv?.directoryId].filter((value): value is string => Boolean(value)));
    setExtraRoots(
      configuration.sourceRoots
        .filter((root) => !targetIds.has(root.directoryId))
        .map((root) => ({ directoryId: root.directoryId, name: root.name, checked: true })),
    );
    setMediaKind(configuration.mediaKind);
    setDailyScheduleEnabled(configuration.dailyScheduleEnabled);
    setDailyScheduleTime(configuration.dailyScheduleTime ?? "03:00");
    setAutoOrganize(configuration.autoOrganize);
    setOrganizeConcurrency(clampConcurrency(configuration.organizeConcurrency));
    setTemplates(normalizeTemplates(configuration.templates, defaultTemplates));
  }, [defaultTemplates]);

  const loadStorageData = useCallback(async (id: string, signal: AbortSignal, currentGeneration: number) => {
    const targetStorage = storages.find((item) => item.id === id) ?? null;
    setLoading(true);
    setPageError(null);
    setConfigurations([]);
    setTasks([]);
    setSelectedTaskId(null);
    setTaskCursor(null);
    setTaskHasMore(false);
    applyConfiguration(null, targetStorage);
    try {
      const [allConfigs, nextTasks] = await Promise.all([
        loadAllScanConfigurations(id, signal),
        loadScanTaskPage(id, null, signal),
      ]);
      if (generation.current !== currentGeneration) return;
      const userConfigs = allConfigs.filter((item) => !item.configId.startsWith("msg_"));
      const visibleConfigs = userConfigs.length > 0 ? userConfigs : allConfigs;
      const primaryConfig = visibleConfigs[0] ?? null;
      setConfigurations(visibleConfigs);
      setTasks(nextTasks.items);
      setTaskCursor(nextTasks.nextCursor);
      setTaskHasMore(nextTasks.hasMore);
      applyConfiguration(primaryConfig, targetStorage);
      const preferredTask = (primaryConfig
        ? nextTasks.items.find((task) => task.configId === primaryConfig.configId)
        : undefined) ?? nextTasks.items[0] ?? null;
      setSelectedTaskId(preferredTask?.taskId ?? null);
    } catch (error) {
      if (!signal.aborted && generation.current === currentGeneration) {
        setPageError(error instanceof Error ? error.message : "加载库整理设置失败。");
      }
    } finally {
      if (generation.current === currentGeneration) setLoading(false);
    }
  }, [applyConfiguration, storages]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    mainController.current?.abort();
    pickerGeneration.current += 1;
    pickerController.current?.abort();
    pickerController.current = null;
    setPickerKind(null);
    setLoading(false);
    setSaving(false);
    setStarting(false);
    setBusyTaskId(null);
    setDirectoryLoading(false);
    setScanNotice(null);
    setSaveNotice(null);
    const controller = new AbortController();
    mainController.current = controller;
    if (storageId) void loadStorageData(storageId, controller.signal, currentGeneration);
    else {
      setConfigurations([]);
      setTasks([]);
      setSelectedConfigId(null);
      setSelectedTaskId(null);
      setLoading(false);
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
        if (isCurrentScope(id, scopeGeneration, controller.signal)) {
          setPageError(error instanceof Error ? error.message : "刷新扫描状态失败。");
        }
      }
    };
    const timer = window.setInterval(() => void poll(), 4_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); controller.abort(); };
  }, [storageId, activeTaskId, tasks, isCurrentScope]);

  const canEdit = storage?.status === "active";
  const allAddedDirectoryIds = useMemo(() => {
    const ids = new Set<string>(extraRoots.map((root) => root.directoryId));
    if (movieTarget) ids.add(movieTarget.directoryId);
    if (tvTarget) ids.add(tvTarget.directoryId);
    return ids;
  }, [extraRoots, movieTarget, tvTarget]);

  const changeStorage = (id: string) => {
    if (id === storageId) return;
    selectionVersion.current += 1;
    const targetStorage = storages.find((item) => item.id === id) ?? null;
    setStorageId(id);
    setScanNotice(null);
    setSaveNotice(null);
    applyConfiguration(null, targetStorage);
    setSelectedConfigId(null);
    setSelectedTaskId(null);
    notifySelection(id, null, null, false);
  };

  const selectConfiguration = (id: string) => {
    selectionVersion.current += 1;
    const configuration = configurations.find((item) => item.configId === id) ?? null;
    applyConfiguration(configuration, storage);
    if (selectedTaskId && tasks.find((task) => task.taskId === selectedTaskId)?.configId !== id) {
      const nextMatch = tasks.find((task) => task.configId === id) ?? null;
      setSelectedTaskId(nextMatch?.taskId ?? null);
    }
  };

  const selectTask = (task: LibraryScanTask, knownConfiguration?: LibraryScanConfiguration) => {
    selectionVersion.current += 1;
    setSelectedTaskId(task.taskId);
    const configuration = knownConfiguration ?? configurations.find((item) => item.configId === task.configId) ?? null;
    if (configuration) applyConfiguration(configuration, storage);
  };

  const reload = () => {
    if (!storageId) return;
    mainController.current?.abort();
    const controller = new AbortController();
    mainController.current = controller;
    const currentGeneration = ++generation.current;
    setSaving(false);
    setStarting(false);
    setBusyTaskId(null);
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
      if (!controller.signal.aborted && pickerGeneration.current === currentPickerGeneration) {
        setDirectoryError(error instanceof Error ? error.message : "读取目录失败。");
      }
    } finally {
      if (!controller.signal.aborted && generation.current === currentGeneration && pickerGeneration.current === currentPickerGeneration) {
        setDirectoryLoading(false);
      }
    }
  }, [storageId]);

  const openPicker = (kind: PickerKind) => {
    setPickerKind(kind);
    const rootId = storage?.rootDirectoryId ?? "";
    setPickerPath([{ id: rootId, label: `${storage?.label ?? "网盘"}根目录` }]);
    setDirectoryItems([]);
    setDirectoryNextPage(null);
    setDirectoryNextCursor(null);
    setDirectoryError(null);
    void loadDirectory(rootId, 0, null, true);
  };

  const enterDirectory = (item: LibraryDirectoryChoice) => {
    const path = [...pickerPath, { id: item.directoryId, label: item.name }];
    setPickerPath(path);
    setDirectoryItems([]);
    setDirectoryNextPage(null);
    setDirectoryNextCursor(null);
    void loadDirectory(item.directoryId, 0, null, true);
  };

  const goBackInPicker = (index: number) => {
    const path = pickerPath.slice(0, index + 1);
    setPickerPath(path);
    setDirectoryItems([]);
    setDirectoryNextPage(null);
    setDirectoryNextCursor(null);
    void loadDirectory(path[path.length - 1]?.id ?? "", 0, null, true);
  };

  const chooseDirectory = (item: LibraryDirectoryChoice) => {
    if (pickerKind === "extra") {
      setExtraRoots((current) => current.some((root) => root.directoryId === item.directoryId)
        ? current
        : [...current, { directoryId: item.directoryId, name: item.name, selectionToken: item.selectionToken, checked: true }]);
    } else if (pickerKind === "movie") {
      setMovieTarget({ directoryId: item.directoryId, name: item.name, selectionToken: item.selectionToken });
      setIncludeMovieSource(true);
    } else if (pickerKind === "tv") {
      setTvTarget({ directoryId: item.directoryId, name: item.name, selectionToken: item.selectionToken });
      setIncludeTvSource(true);
    }
    setPickerKind(null);
  };

  const buildPayload = (id: string, useDefaultWhenEmpty: boolean) => ({
    ...(selectedConfigId ? { configId: selectedConfigId } : {}),
    storageId: id,
    sourceRoots: selectedSourceRoots.map(({ directoryId, selectionToken }) => ({
      directoryId,
      ...(selectionToken ? { selectionToken } : {}),
    })),
    ...(useDefaultWhenEmpty && selectedSourceRoots.length === 0 ? { useDefaultLibraryDirectories: true } : {}),
    movieTargetDirectoryId: movieTarget?.directoryId ?? null,
    ...(movieTarget?.selectionToken ? { movieTargetSelectionToken: movieTarget.selectionToken } : {}),
    tvTargetDirectoryId: tvTarget?.directoryId ?? null,
    ...(tvTarget?.selectionToken ? { tvTargetSelectionToken: tvTarget.selectionToken } : {}),
    mediaKind,
    dailyScheduleEnabled,
    autoOrganize,
    organizeConcurrency,
    dailyScheduleTime: dailyScheduleEnabled ? (dailyScheduleTime || "03:00") : null,
    templates,
  });

  const persistConfiguration = async (
    id: string,
    scopeGeneration: number,
    signal: AbortSignal,
    useDefaultWhenEmpty: boolean,
  ): Promise<LibraryScanConfiguration> => {
    if (!isCurrentScope(id, scopeGeneration, signal)) throw new DOMException("Aborted", "AbortError");
    const draftAtSave = draftSignatureRef.current;
    const selectionAtSave = selectionVersion.current;
    const targetStorage = storages.find((item) => item.id === id) ?? null;
    const saved = await saveScanConfiguration(buildPayload(id, useDefaultWhenEmpty), signal);
    if (!isCurrentScope(id, scopeGeneration, signal)) throw new DOMException("Aborted", "AbortError");
    setConfigurations((current) => isCurrentScope(id, scopeGeneration, signal)
      ? [saved, ...current.filter((item) => item.configId !== saved.configId)] : current);
    if (selectionVersion.current === selectionAtSave) {
      if (draftSignatureRef.current === draftAtSave) applyConfiguration(saved, targetStorage);
      else setSelectedConfigId(saved.configId);
    }
    return saved;
  };

  const canSaveSettings = !formDisabled && !templatesInvalid && (
    selectedSourceRoots.length > 0
    || Boolean(storage?.defaultMovieDirectory || storage?.defaultTvDirectory)
  );

  const save = async () => {
    if (!storageId || !canSaveSettings) return;
    const id = storageId;
    const scopeGeneration = generation.current;
    const signal = mainController.current?.signal;
    if (!signal) return;
    setSaving(true);
    setPageError(null);
    setSaveNotice(null);
    try {
      await persistConfiguration(id, scopeGeneration, signal, true);
      if (isCurrentScope(id, scopeGeneration, signal)) {
        setSaveNotice("设置已保存，新片入库与后续整理将立即采用当前规则与并发数。");
      }
    } catch (error) {
      if (isCurrentScope(id, scopeGeneration, signal)) {
        setPageError(error instanceof Error ? error.message : "保存整理设置失败。");
      }
    } finally {
      if (isCurrentScope(id, scopeGeneration, signal)) setSaving(false);
    }
  };

  const start = async () => {
    if (!storageId || !canEdit || templatesInvalid || selectedSourceRoots.length < 1 || saving || starting) return;
    const selectionAtStart = selectionVersion.current;
    const id = storageId;
    const scopeGeneration = generation.current;
    const signal = mainController.current?.signal;
    if (!signal) return;
    setStarting(true);
    setPageError(null);
    setScanNotice(null);
    setSaveNotice(null);
    try {
      const saved = await persistConfiguration(id, scopeGeneration, signal, false);
      if (!isCurrentScope(id, scopeGeneration, signal)) return;
      const task = await startLibraryScan(id, saved.configId, signal);
      if (!isCurrentScope(id, scopeGeneration, signal)) return;
      setTasks((current) => isCurrentScope(id, scopeGeneration, signal)
        ? [task, ...current.filter((item) => item.taskId !== task.taskId)] : current);
      if (selectionVersion.current === selectionAtStart) selectTask(task, saved);
      setScanNotice(`已开始单次整理（并发 ${organizeConcurrency}）：已入库影片自动复用数据库身份，正在实时更新下方整理记录。`);
      onScanStarted?.();
    } catch (error) {
      if (isCurrentScope(id, scopeGeneration, signal)) {
        setPageError(error instanceof Error ? error.message : "开始单次整理失败。");
      }
    } finally {
      if (isCurrentScope(id, scopeGeneration, signal)) setStarting(false);
    }
  };

  const controlTask = async (task: LibraryScanTask, action: "pause" | "resume" | "cancel" | "retry") => {
    if (!storageId || !canEdit || busyTaskId) return;
    const id = storageId;
    const scopeGeneration = generation.current;
    const signal = mainController.current?.signal;
    if (!signal) return;
    setBusyTaskId(task.taskId);
    setPageError(null);
    try {
      const updated = await controlLibraryScan(id, task.taskId, action, signal);
      if (!isCurrentScope(id, scopeGeneration, signal)) return;
      setTasks((current) => isCurrentScope(id, scopeGeneration, signal)
        ? current.map((item) => item.taskId === updated.taskId ? updated : item) : current);
      selectTask(updated);
    } catch (error) {
      if (isCurrentScope(id, scopeGeneration, signal)) {
        setPageError(error instanceof Error ? error.message : "扫描操作失败。");
      }
    } finally {
      if (isCurrentScope(id, scopeGeneration, signal)) setBusyTaskId(null);
    }
  };

  const handleStopWork = async () => {
    if (!storageId || stoppingWork) return;
    const id = storageId;
    const scopeGeneration = generation.current;
    const signal = mainController.current?.signal;
    setStoppingWork(true);
    setPageError(null);
    setScanNotice(null);
    try {
      await stopOrganizations(id, signal);
      if (generation.current !== scopeGeneration || storageId !== id || signal?.aborted) return;
      setScanNotice("已停止当前网盘的扫描与整理任务。");
      onStopWork?.();
      await loadMoreSafeRefresh(id, scopeGeneration, signal);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setPageError(error instanceof Error ? error.message : "停止整理失败。");
      }
    } finally {
      if (generation.current === scopeGeneration && storageId === id) {
        setStoppingWork(false);
      }
    }
  };

  const loadMoreSafeRefresh = async (id: string, scopeGeneration: number, signal?: AbortSignal) => {
    if (!signal || !isCurrentScope(id, scopeGeneration, signal)) return;
    try {
      const page = await loadScanTaskPage(id, null, signal);
      if (!isCurrentScope(id, scopeGeneration, signal)) return;
      setTasks(page.items);
      setTaskCursor(page.nextCursor);
      setTaskHasMore(page.hasMore);
    } catch {
      // 忽略刷新任务列表时的次要异常
    }
  };

  const loadMoreTasks = async () => {
    if (!storageId || !taskCursor || loading) return;
    const id = storageId;
    const scopeGeneration = generation.current;
    const cursor = taskCursor;
    const scopeSignal = mainController.current?.signal;
    if (!scopeSignal) return;
    const controller = new AbortController();
    const abortOnScopeChange = () => controller.abort();
    scopeSignal.addEventListener("abort", abortOnScopeChange, { once: true });
    setLoading(true);
    setPageError(null);
    try {
      const page = await loadScanTaskPage(id, cursor, controller.signal);
      if (!isCurrentScope(id, scopeGeneration, controller.signal)) return;
      setTasks((current) => isCurrentScope(id, scopeGeneration, controller.signal)
        ? [...current, ...page.items.filter((item) => !current.some((known) => known.taskId === item.taskId))] : current);
      setTaskCursor(page.nextCursor);
      setTaskHasMore(page.hasMore);
    } catch (error) {
      if (isCurrentScope(id, scopeGeneration, controller.signal)) {
        setPageError(error instanceof Error ? error.message : "加载更多任务失败。");
      }
    } finally {
      scopeSignal.removeEventListener("abort", abortOnScopeChange);
      if (isCurrentScope(id, scopeGeneration, controller.signal)) setLoading(false);
    }
  };

  const defaultMovie = storage?.defaultMovieDirectory ?? null;
  const defaultTv = storage?.defaultTvDirectory ?? null;
  const movieIsCustom = Boolean(defaultMovie && movieTarget?.directoryId !== defaultMovie.directoryId);
  const tvIsCustom = Boolean(defaultTv && tvTarget?.directoryId !== defaultTv.directoryId);

  const emptyStorages = storages.length === 0;
  return (
    <div className={styles.root}>
      {emptyStorages ? <section className={`panel ${styles.empty}`}>
        <strong>还没有连接可用网盘</strong>
        <p>连接网盘后即可配置入库整理规则并发起单次存量整理。</p>
        <Link className="primary-button" href={settingsHref}>前往设置连接</Link>
      </section> : <>
        {/* 顶部：纯胶囊网盘切换（去掉重复下拉框）+ 入库整理与并发控制条 */}
        <section className={`panel ${styles.panel}`}>
          <div className={styles.toolbar}>
            <div className={styles.storagePills} role="group" aria-label="当前网盘">
              {storages.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={item.id === storageId}
                  className={`${styles.storagePill} ${item.id === storageId ? styles.storagePillActive : ""}`}
                  onClick={() => changeStorage(item.id)}
                >
                  <span>{item.label}</span>
                  {item.status === "frozen" && <span className={styles.pillFrozen}>已冻结</span>}
                </button>
              ))}
            </div>

            {configurations.length > 1 && (
              <label className={styles.inlineSelectField}>
                <span>历史规则</span>
                <select
                  aria-label="历史规则"
                  value={selectedConfigId ?? ""}
                  onChange={(event) => selectConfiguration(event.target.value)}
                  disabled={formDisabled}
                >
                  {configurations.map((item, index) => (
                    <option key={item.configId} value={item.configId}>
                      规则 {configurations.length - index}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className={`${styles.autoHero} ${autoOrganize ? "" : styles.autoHeroPaused}`} style={{ marginTop: 14 }}>
            <div className={styles.heroLeft}>
              <div className={styles.heroIcon}><Sparkles size={20} /></div>
              <div className={styles.heroCopy}>
                <div className={styles.heroTitle}>
                  <span>{autoOrganize ? "入库自动整理已默认开启" : "当前网盘自动整理已暂停"}</span>
                  <span className={styles.heroBadge}>{autoOrganize ? "实时自动整理" : "手动暂停中"}</span>
                </div>
                <p>新片获取、追更或机器人转存落盘后直接并发整理归档；定时扫描自动跳过已整理且未变动文件，仅处理新增与被修改项。</p>
              </div>
            </div>
            <div className={styles.heroActions}>
              <label className={styles.switchCard}>
                <span>启用自动整理</span>
                <input
                  type="checkbox"
                  checked={autoOrganize}
                  onChange={(event) => setAutoOrganize(event.target.checked)}
                  disabled={formDisabled}
                />
              </label>
              <label className={styles.switchCard}>
                <span>每日定时扫描</span>
                <input
                  type="checkbox"
                  checked={dailyScheduleEnabled}
                  onChange={(event) => setDailyScheduleEnabled(event.target.checked)}
                  disabled={formDisabled}
                />
              </label>
              {dailyScheduleEnabled && (
                <label className={styles.inlineSelectField}>
                  <span>扫描时间</span>
                  <input
                    type="time"
                    className={styles.scheduleTimeInput}
                    aria-label="每日定时扫描时间"
                    value={dailyScheduleTime}
                    onChange={(event) => setDailyScheduleTime(event.target.value)}
                    disabled={formDisabled}
                  />
                </label>
              )}
              <label className={styles.inlineSelectField}>
                <span>整理并发</span>
                <select
                  aria-label="整理并发"
                  value={organizeConcurrency}
                  onChange={(event) => setOrganizeConcurrency(Number(event.target.value))}
                  disabled={formDisabled}
                >
                  {CONCURRENCY_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value === DEFAULT_ORGANIZE_CONCURRENCY ? `${value}（推荐）` : `${value}`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void save()}
                disabled={!canSaveSettings}
              >
                <Save size={15} />{saving ? "保存中…" : "保存设置"}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void start()}
                disabled={formDisabled || templatesInvalid || selectedSourceRoots.length === 0}
              >
                <Play size={15} />{starting ? "启动中…" : "开始单次整理"}
              </button>
              {(hasActiveWork || Boolean(activeTaskId)) && (
                <button
                  className={styles.stopButton}
                  type="button"
                  onClick={() => void handleStopWork()}
                  disabled={stoppingWork || loading}
                >
                  <Square size={14} />{stoppingWork ? "停止中…" : "停止整理"}
                </button>
              )}
            </div>
          </div>

          {storage?.status === "frozen" && <div className={styles.notice} style={{ marginTop: 12 }}>该网盘连接已冻结，可查看历史整理记录；恢复连接后才能修改设置或开始整理。</div>}
          {pageError && <div className={styles.error} role="alert" style={{ marginTop: 12 }}><CircleAlert size={17} /><span>{pageError}</span><button className="secondary-button" onClick={reload}><RefreshCw size={14} />重试</button></div>}
          {saveNotice && <div className={styles.successNotice} role="status" style={{ marginTop: 12 }}><span>{saveNotice}</span></div>}
          {scanNotice && <div className={styles.successNotice} role="status" style={{ marginTop: 12 }}><span>{scanNotice}</span>{onSwitchTab && activeTab !== "pending" && <button className="secondary-button" type="button" onClick={() => onSwitchTab("pending")}>查看待确认与任务明细</button>}</div>}
          {dirty && <div className={styles.notice} role="status" style={{ marginTop: 12 }}>设置或命名规则尚未保存；点击「保存设置」或「开始单次整理」即可生效。</div>}
          {loading && configurations.length === 0 && <div className={styles.loading}><LoaderCircle size={18} className={styles.spin} />正在读取网盘设置…</div>}
        </section>

        {/* 标签一：勾选整理目录 + 极简命名方案 */}
        {activeTab === "organize" && (
          <section className={`panel ${styles.panel}`}>
            <div className={styles.panelHeader}>
              <div>
                <h2>整理目录与命名规则</h2>
                <p>已自动读取网盘电影与剧集库目录；勾选参与「开始单次整理」的目录，整理保留多版本与字幕语言标记。</p>
              </div>
              <div className={styles.headerExtraActions}>
                <div className={styles.mediaKindRow} role="radiogroup" aria-label="媒体类型">
                  {([["mixed", "全部类型"], ["movie", "仅电影"], ["tv", "仅剧集"]] as const).map(([value, label]) => (
                    <label className={styles.mediaKindPill} key={value}>
                      <input type="radio" name="media-kind" value={value} checked={mediaKind === value} onChange={() => setMediaKind(value)} disabled={formDisabled} />
                      {label}
                    </label>
                  ))}
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => openPicker("extra")}
                  disabled={formDisabled || selectedSourceRoots.length >= 20}
                >
                  <Plus size={15} />添加其他目录
                </button>
              </div>
            </div>

            <div className={styles.directoryChecklist}>
              <DirectoryCheckRow
                tag="电影库"
                value={movieTarget}
                checked={includeMovieSource}
                isCustom={movieIsCustom}
                onToggle={(checked) => setIncludeMovieSource(checked)}
                onChoose={() => openPicker("movie")}
                onReset={defaultMovie ? () => { setMovieTarget(defaultMovie); setIncludeMovieSource(true); } : undefined}
                disabled={formDisabled}
              />
              <DirectoryCheckRow
                tag="剧集库"
                isTv
                value={tvTarget}
                checked={includeTvSource}
                isCustom={tvIsCustom}
                onToggle={(checked) => setIncludeTvSource(checked)}
                onChoose={() => openPicker("tv")}
                onReset={defaultTv ? () => { setTvTarget(defaultTv); setIncludeTvSource(true); } : undefined}
                disabled={formDisabled}
              />
              {extraRoots.map((root) => (
                <div className={styles.dirCheckRow} key={root.directoryId}>
                  <label className={styles.dirCheckMain}>
                    <input
                      type="checkbox"
                      checked={root.checked}
                      onChange={(event) => setExtraRoots((current) => current.map((entry) =>
                        entry.directoryId === root.directoryId ? { ...entry, checked: event.target.checked } : entry))}
                      disabled={formDisabled}
                    />
                    <span className={`${styles.targetTag} ${styles.targetTagExtra}`}>导入目录</span>
                    <span className={styles.dirCheckPath} title={root.directoryId}>{root.name}</span>
                  </label>
                  <div className={styles.dirCheckOps}>
                    <button
                      type="button"
                      className={styles.clearTarget}
                      aria-label={`移除${root.name}`}
                      onClick={() => setExtraRoots((current) => current.filter((entry) => entry.directoryId !== root.directoryId))}
                      disabled={formDisabled}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
              {selectedSourceRoots.length === 0 && (
                <p className={styles.hint}>请至少勾选一个目录（或点击右上角「添加其他目录」）后再点击「开始单次整理」。</p>
              )}
            </div>

            <div className={styles.dividerLine} />

            <LibraryNamingTemplates
              value={templates}
              savedValue={savedTemplates}
              onChange={setTemplates}
              disabled={formDisabled}
              movieRootLabel={movieTarget?.name ?? "电影目标"}
              tvRootLabel={tvTarget?.name ?? "剧集目标"}
            />
          </section>
        )}

        {/* 标签二：待确认与扫描任务明细 */}
        {activeTab === "pending" && (
          <section className={`panel ${styles.panel}`}>
            <div className={styles.panelHeader}>
              <div><h2>扫描任务</h2><p>每次「开始单次整理」会生成一条扫描任务记录；点击任务可查看待确认片名与按批预览。</p></div>
              <button className="secondary-button" type="button" onClick={reload} disabled={loading}><RefreshCw size={14} />刷新</button>
            </div>
            {tasks.length === 0 && !loading ? <div className={styles.emptyTasks}>还没有扫描任务。回到「库整理」勾选目录后点击「开始单次整理」，任务会显示在这里。</div> : <div className={styles.taskList}>
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
          <div className={styles.pickerHeader}><div><h2 id="directory-picker-title">选择{pickerKind === "extra" ? "要导入整理的" : pickerKind === "movie" ? "电影目标" : "剧集目标"}目录</h2><p>只能选择此账号中实际浏览到的目录。</p></div><button className="secondary-button" onClick={() => setPickerKind(null)} aria-label="关闭目录选择器"><X size={16} /></button></div>
          <nav className={styles.breadcrumb} aria-label="目录路径">{pickerPath.map((entry, index) => <span key={`${entry.id}-${index}`}><button type="button" onClick={() => goBackInPicker(index)}>{entry.label}</button>{index < pickerPath.length - 1 && <ChevronRight size={14} />}</span>)}</nav>
          {directoryError && <div className={styles.error} role="alert"><span>{directoryError}</span><button className="secondary-button" onClick={() => void loadDirectory(pickerPath[pickerPath.length - 1]?.id ?? "", directoryItems.length ? (directoryNextPage ?? 0) : 0, directoryItems.length ? directoryNextCursor : null, directoryItems.length === 0)}>重试</button></div>}
          {directoryLoading && directoryItems.length === 0 && <div className={styles.loading}><LoaderCircle size={18} className={styles.spin} />正在读取目录…</div>}
          <div className={styles.directoryList}>
            {directoryItems.map((item) => <div className={styles.directoryRow} key={item.directoryId}>
              <button className={styles.directoryName} type="button" onClick={() => enterDirectory(item)}><Folder size={17} /><span>{item.name}</span><ChevronRight size={15} /></button>
              <button className="secondary-button" type="button" onClick={() => chooseDirectory(item)} disabled={pickerKind === "extra" && (allAddedDirectoryIds.has(item.directoryId) || selectedSourceRoots.length >= 20)}>
                {pickerKind === "extra"
                  ? (allAddedDirectoryIds.has(item.directoryId) ? <><Check size={14} />已存在</> : <><Plus size={14} />添加目录</>)
                  : "选择此目录"}
              </button>
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

function DirectoryCheckRow({
  tag,
  value,
  checked,
  isCustom,
  onToggle,
  onChoose,
  onReset,
  disabled,
  isTv = false,
}: {
  tag: string;
  value: PickedRoot | null;
  checked: boolean;
  isCustom: boolean;
  onToggle: (checked: boolean) => void;
  onChoose: () => void;
  onReset?: (() => void) | undefined;
  disabled: boolean;
  isTv?: boolean;
}) {
  return (
    <div className={styles.dirCheckRow}>
      <label className={styles.dirCheckMain}>
        <input
          type="checkbox"
          checked={Boolean(value) && checked}
          onChange={(event) => onToggle(event.target.checked)}
          disabled={disabled || !value}
          aria-label={`勾选${tag}`}
        />
        <span className={`${styles.targetTag} ${isTv ? styles.targetTagTv : ""}`}>{tag}</span>
        <span className={styles.dirCheckPath} title={value?.directoryId}>
          {value?.name ?? "尚未设置目录（点击右侧选择）"}
        </span>
      </label>
      <div className={styles.dirCheckOps}>
        {isCustom && onReset && (
          <button type="button" className="secondary-button" onClick={onReset} disabled={disabled}>
            <RotateCcw size={13} />恢复默认
          </button>
        )}
        <button type="button" className="secondary-button" onClick={onChoose} disabled={disabled}>
          更改目录
        </button>
      </div>
    </div>
  );
}

function clampConcurrency(value: number | undefined): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_ORGANIZE_CONCURRENCY && value <= MAX_ORGANIZE_CONCURRENCY) {
    return value;
  }
  return DEFAULT_ORGANIZE_CONCURRENCY;
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
