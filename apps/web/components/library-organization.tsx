"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, ChevronRight, LoaderCircle, Pause, Play, RefreshCw, WandSparkles } from "lucide-react";
import { extractMediaTechTags } from "@media-track/workflow/naming";
import { loadIdentificationPage, type IdentificationResultItem } from "./library-identification-client";
import { ApiRequestError } from "./library-scan-client";
import { OrganizationPayloadError, controlOrganizationPlan, createOrganizationPreview, loadOrganizationOperations, loadOrganizationPlans, type OrganizationOperation, type OrganizationPlanSummary } from "./library-organization-client";
import styles from "./library-organization.module.css";

const BATCH_SIZE = 20;
const PLAN_LIST_LIMIT = 100;

export function LibraryOrganization({ storageId, configId, taskId, dirty, frozen }: {
  storageId: string | null; configId: string | null; taskId: string | null; dirty: boolean; frozen: boolean;
}) {
  const [identifications, setIdentifications] = useState<readonly IdentificationResultItem[]>([]);
  const [identityCursor, setIdentityCursor] = useState<string | null>(null);
  const [identityHistory, setIdentityHistory] = useState<readonly (string | null)[]>([null]);
  const [selectedFiles, setSelectedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [plans, setPlans] = useState<readonly OrganizationPlanSummary[]>([]);
  const [planCursor, setPlanCursor] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<OrganizationPlanSummary | null>(null);
  const [operations, setOperations] = useState<readonly OrganizationOperation[]>([]);
  const [operationCursor, setOperationCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const pendingReads = useRef(0);
  const selectedPlanKey = useRef<string | null>(null);
  const selectedPlanSummary = useRef<OrganizationPlanSummary | null>(null);
  const identityRequest = useRef(0);
  const planListRequest = useRef(0);
  const planDetailRequest = useRef(0);
  const identityNavigation = useRef(false);
  const planPageNavigation = useRef(false);
  const operationPageNavigation = useRef(false);
  const scopeKey = useMemo(() => `${storageId ?? ""}\u0000${configId ?? ""}\u0000${taskId ?? ""}`, [storageId, configId, taskId]);
  const usable = Boolean(storageId && configId && taskId);

  const isCurrent = useCallback((value: number, signal: AbortSignal) => generation.current === value && !signal.aborted, []);
  const beginRead = (scopeGeneration: number, signal: AbortSignal) => { if (isCurrent(scopeGeneration, signal)) { pendingReads.current += 1; setLoading(true); } };
  const endRead = (scopeGeneration: number, signal: AbortSignal) => { if (isCurrent(scopeGeneration, signal)) { pendingReads.current = Math.max(0, pendingReads.current - 1); setLoading(pendingReads.current > 0); } };
  const selectPlan = useCallback((plan: OrganizationPlanSummary | null) => {
    selectedPlanKey.current = plan?.operationKey ?? null;
    selectedPlanSummary.current = plan;
    setSelectedPlan(plan);
  }, []);

  const loadIdentity = useCallback(async (cursor: string | null, scopeGeneration: number, signal: AbortSignal, clearError = true): Promise<boolean> => {
    if (!storageId || !taskId) return false;
    const request = ++identityRequest.current;
    beginRead(scopeGeneration, signal); if (clearError) setError(null);
    try {
      const page = await loadIdentificationPage(storageId, taskId, BATCH_SIZE, cursor, "confirmed", signal);
      if (!isCurrent(scopeGeneration, signal) || request !== identityRequest.current) return false;
      const items = Array.isArray(page.items) ? page.items : [];
      setIdentifications(items.filter((item) => item.status === "confirmed" && item.importStatus === "imported" && item.file && !item.file.isDirectory));
      setIdentityCursor(page.nextCursor ?? null);
      setSelectedFiles(new Set());
      return true;
    } catch (cause) {
      if (isCurrent(scopeGeneration, signal) && request === identityRequest.current) setError(cause instanceof Error ? cause.message : "读取已导入识别结果失败。");
      return false;
    } finally { endRead(scopeGeneration, signal); }
  }, [storageId, taskId, isCurrent]);

  const loadPlans = useCallback(async (cursor: string | null, scopeGeneration: number, signal: AbortSignal, append: boolean, clearError = true) => {
    if (!storageId || !taskId) return;
    const request = ++planListRequest.current;
    beginRead(scopeGeneration, signal); if (clearError) setError(null);
    try {
      const page = await loadOrganizationPlans(storageId, taskId, cursor, signal);
      if (!isCurrent(scopeGeneration, signal) || request !== planListRequest.current) return;
      const nextPlans = Array.isArray(page.plans) ? page.plans : [];
      setPlans((current) => pinSelectedPlan(append ? [...current, ...nextPlans] : nextPlans, selectedPlanKey.current, selectedPlanSummary.current));
      setPlanCursor(page.nextCursor ?? null);
    } catch (cause) {
      if (isCurrent(scopeGeneration, signal) && request === planListRequest.current) setError(cause instanceof Error ? cause.message : "读取整理清单失败。");
    } finally { endRead(scopeGeneration, signal); }
  }, [storageId, taskId, isCurrent]);

  const loadPlanDetail = useCallback(async (operationKey: string, cursor: string | null, scopeGeneration: number, signal: AbortSignal, append: boolean, clearError = true): Promise<boolean> => {
    if (!storageId || !taskId) return false;
    const request = ++planDetailRequest.current;
    beginRead(scopeGeneration, signal); if (clearError) setError(null);
    try {
      const page = await loadOrganizationOperations(storageId, taskId, operationKey, cursor, signal);
      if (!isCurrent(scopeGeneration, signal) || request !== planDetailRequest.current || selectedPlanKey.current !== operationKey) return false;
      if (page.plan) selectPlan(page.plan);
      const nextOperations = Array.isArray(page.operations) ? page.operations : [];
      setOperations((current) => append ? mergeOperations(current, nextOperations) : nextOperations);
      setOperationCursor(page.nextCursor ?? null);
      return true;
    } catch (cause) {
      if (isCurrent(scopeGeneration, signal) && request === planDetailRequest.current && selectedPlanKey.current === operationKey) {
        setError(cause instanceof Error ? cause.message : append ? "加载更多操作失败。" : "读取操作明细失败。");
      }
      return false;
    } finally { endRead(scopeGeneration, signal); }
  }, [storageId, taskId, isCurrent, selectPlan]);

  useEffect(() => {
    const scopeGeneration = ++generation.current;
    controllerRef.current?.abort();
    pendingReads.current = 0;
    identityRequest.current += 1;
    planListRequest.current += 1;
    planDetailRequest.current += 1;
    selectedPlanKey.current = null;
    identityNavigation.current = false;
    planPageNavigation.current = false;
    operationPageNavigation.current = false;
    const controller = new AbortController(); controllerRef.current = controller;
    setIdentifications([]); setIdentityCursor(null); setIdentityHistory([null]); setSelectedFiles(new Set());
    setPlans([]); setPlanCursor(null); selectPlan(null); setOperations([]); setOperationCursor(null);
    setError(null); setNotice(null); setLoading(false); setBusy(false);
    if (usable) {
      void loadIdentity(null, scopeGeneration, controller.signal);
      void loadPlans(null, scopeGeneration, controller.signal, false);
    }
    return () => { controller.abort(); if (controllerRef.current === controller) controllerRef.current = null; };
  }, [scopeKey, usable, loadIdentity, loadPlans, selectPlan]);

  const refresh = async (clearNotice = true, clearError = true) => {
    const signal = controllerRef.current?.signal;
    if (!signal || !storageId || !taskId) return;
    const scopeGeneration = generation.current;
    const planKey = selectedPlanKey.current;
    if (clearNotice) setNotice(null);
    await Promise.all([loadPlans(null, scopeGeneration, signal, false, clearError), loadIdentity(identityHistory.at(-1) ?? null, scopeGeneration, signal, clearError)]);
    if (planKey && selectedPlanKey.current === planKey) await loadPlanDetail(planKey, null, scopeGeneration, signal, false, clearError);
  };

  const choosePlan = async (plan: OrganizationPlanSummary) => {
    const signal = controllerRef.current?.signal;
    if (!signal || !storageId || !taskId) return;
    const scopeGeneration = generation.current;
    selectPlan(plan); setOperations([]); setOperationCursor(null); setError(null);
    await loadPlanDetail(plan.operationKey, null, scopeGeneration, signal, false);
  };

  const createPreview = async () => {
    const signal = controllerRef.current?.signal;
    if (!signal || !storageId || !taskId || !selectedFiles.size || dirty || frozen || busy || loading) return;
    const scopeGeneration = generation.current; setBusy(true); setError(null); setNotice(null);
    let failure: OrganizationFailureNotice | null = null;
    try {
      const created = await createOrganizationPreview(storageId, taskId, [...selectedFiles], signal);
      if (!isCurrent(scopeGeneration, signal)) return;
      setNotice("整理预览清单已创建；这一步没有执行文件移动或改名。");
      selectPlan(created);
      setPlans((current) => pinSelectedPlan([created, ...current], created.operationKey, created));
      await choosePlan(created);
    } catch (cause) {
      if (!isCurrent(scopeGeneration, signal)) return;
      failure = describeOrganizationFailure(cause, "preview");
      await refresh(false, false);
      if (isCurrent(scopeGeneration, signal)) { setNotice(failure.notice); setError(failure.error); }
    } finally { if (isCurrent(scopeGeneration, signal)) setBusy(false); }
  };

  const controlPlan = async (action: "execute" | "pause") => {
    const signal = controllerRef.current?.signal;
    if (!signal || !storageId || !taskId || !selectedPlan || dirty || frozen || busy || loading) return;
    const scopeGeneration = generation.current; setBusy(true); setError(null); setNotice(null);
    let failure: OrganizationFailureNotice | null = null;
    try {
      const accepted = await controlOrganizationPlan(storageId, taskId, selectedPlan.operationKey, action, signal);
      if (!isCurrent(scopeGeneration, signal)) return;
      setNotice(accepted.accepted ? (action === "pause" ? "暂停请求已提交。刷新状态确认执行器已暂停。" : "整理请求已提交。刷新清单可查看持久化执行状态。") : "服务器未确认整理操作。");
    } catch (cause) {
      if (!isCurrent(scopeGeneration, signal)) return;
      failure = describeOrganizationFailure(cause, action === "pause" ? "pause" : "execute");
      setNotice(failure.notice); setError(failure.error);
    } finally {
      if (isCurrent(scopeGeneration, signal)) {
        await refresh(false, false);
        if (failure && isCurrent(scopeGeneration, signal)) { setNotice(failure.notice); setError(failure.error); }
        if (isCurrent(scopeGeneration, signal)) setBusy(false);
      }
    }
  };

  const loadMoreOperations = async () => {
    const signal = controllerRef.current?.signal;
    const planKey = selectedPlanKey.current;
    if (!signal || !storageId || !taskId || !planKey || !operationCursor || loading || operationPageNavigation.current) return;
    operationPageNavigation.current = true;
    try { await loadPlanDetail(planKey, operationCursor, generation.current, signal, true); }
    finally { operationPageNavigation.current = false; }
  };

  const loadMorePlans = async () => {
    const signal = controllerRef.current?.signal;
    if (!signal || !planCursor || loading || planPageNavigation.current) return;
    planPageNavigation.current = true;
    try { await loadPlans(planCursor, generation.current, signal, true); }
    finally { planPageNavigation.current = false; }
  };

  const nextIdentityPage = async () => {
    const signal = controllerRef.current?.signal;
    if (!signal || !identityCursor || loading || identityNavigation.current) return;
    const next = identityCursor; const scopeGeneration = generation.current;
    identityNavigation.current = true;
    try {
      if (await loadIdentity(next, scopeGeneration, signal)) setIdentityHistory((current) => [...current, next]);
    } finally { identityNavigation.current = false; }
  };
  const previousIdentityPage = async () => {
    const signal = controllerRef.current?.signal;
    if (!signal || identityHistory.length < 2 || loading || identityNavigation.current) return;
    const previous = identityHistory[identityHistory.length - 2]!; const scopeGeneration = generation.current;
    identityNavigation.current = true;
    try {
      if (await loadIdentity(previous, scopeGeneration, signal)) setIdentityHistory((current) => current.length > 1 ? current.slice(0, -1) : current);
    } finally { identityNavigation.current = false; }
  };

  const toggleFile = (fileId: string) => setSelectedFiles((current) => {
    const next = new Set(current);
    if (next.has(fileId)) next.delete(fileId); else if (next.size < BATCH_SIZE) next.add(fileId);
    return next;
  });
  const toggleVisible = () => setSelectedFiles((current) => {
    const eligible = identifications.map((item) => item.file!.fileId);
    return eligible.length && eligible.every((id) => current.has(id)) ? new Set() : new Set(eligible.slice(0, BATCH_SIZE));
  });

  return <section className={`panel ${styles.panel}`}>
    <div className={styles.header}><div><h2>整理管理</h2><p>使用已确认并入库的文件创建整理预览，预览不会移动或改名。</p></div><button className="secondary-button" type="button" onClick={() => void refresh()} disabled={!usable || loading || busy}><RefreshCw size={14} />刷新</button></div>
    {frozen && <div className={styles.notice}>此连接已冻结：可查看整理清单，不能创建预览或提交执行操作。</div>}
    {dirty && <div className={styles.notice}>扫描配置有未保存修改。请先保存配置，再预览或执行整理。</div>}
    {!usable && <div className={styles.empty}>选择一个已保存配置和扫描任务后，可查看已导入文件及整理清单。</div>}
    {error && <div className={styles.error} role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {usable && <div className={styles.columns}>
      <div className={styles.batch}>
        <h3>已导入文件批次</h3><p>每批最多 {BATCH_SIZE} 个文件；仅列出已确认身份并完成入库的文件。</p>
        {identifications.length > 0 && <button className="secondary-button" type="button" onClick={toggleVisible} disabled={loading || busy || frozen}>全选/清空本页</button>}
        <div className={styles.fileList}>
          {identifications.map((item) => <label className={styles.fileRow} key={item.fileId}>
            <input type="checkbox" checked={selectedFiles.has(item.fileId)} onChange={() => toggleFile(item.fileId)} disabled={loading || busy || frozen || (!selectedFiles.has(item.fileId) && selectedFiles.size >= BATCH_SIZE)} />
            <span><strong>{item.file?.name}</strong><small>文件 ID：{item.fileId}</small><small>来源目录 ID：{item.file?.parentDirectoryId}</small></span>
          </label>)}
          {!loading && identifications.length === 0 && <div className={styles.empty}>本页没有已确认且已导入的文件。</div>}
        </div>
        <div className={styles.actions}>
          <button className="secondary-button" type="button" onClick={() => void previousIdentityPage()} disabled={loading || busy || identityHistory.length < 2}>上一批</button>
          <button className="secondary-button" type="button" onClick={() => void nextIdentityPage()} disabled={loading || busy || !identityCursor}>下一批<ChevronRight size={14} /></button>
          <button className="primary-button" type="button" onClick={() => void createPreview()} disabled={!selectedFiles.size || loading || busy || dirty || frozen}><WandSparkles size={15} />{busy ? "处理中…" : `创建预览（${selectedFiles.size}）`}</button>
        </div>
      </div>
      <div className={styles.plans}>
        <h3>整理清单历史</h3>
        <div className={styles.planList}>{plans.map((plan) => <button key={plan.operationKey} className={`${styles.planRow} ${selectedPlan?.operationKey === plan.operationKey ? styles.selected : ""}`} type="button" onClick={() => void choosePlan(plan)} disabled={loading || busy}>
          <span><strong>{planStatusLabel(plan)}{selectedPlan?.operationKey === plan.operationKey && <em className={styles.currentPlan}>当前</em>}</strong><small>{plan.operationCount} 项操作 · {formatDate(plan.updatedAt)}</small></span><code>{plan.operationKey}</code>
        </button>)}{!plans.length && !loading && <div className={styles.empty}>还没有整理清单。</div>}</div>
        {planCursor && <button className="secondary-button" type="button" onClick={() => void loadMorePlans()} disabled={loading || busy}>加载更多清单<ChevronRight size={14} /></button>}
        {selectedPlan && <div className={styles.planDetail}>
          <div className={styles.planHeading}><div><h4>清单状态：{planStatusLabel(selectedPlan)}</h4><p>{selectedPlan.operationCount} 项 · 最近更新 {formatDate(selectedPlan.updatedAt)}</p></div>
            {selectedPlan.status !== "completed" && <div className={styles.actions}>{selectedPlan.status === "running" || isAwaitingExecution(selectedPlan) ? <button className="secondary-button" type="button" onClick={() => void controlPlan("pause")} disabled={loading || busy || dirty || frozen}><Pause size={14} />暂停</button> : <button className="primary-button" type="button" onClick={() => void controlPlan("execute")} disabled={loading || busy || dirty || frozen}><Play size={14} />{selectedPlan.status === "paused" ? "继续整理" : "开始整理"}</button>}</div>}
          </div>
          {selectedPlan.skippedFiles.length > 0 && <details className={styles.skips} open><summary>跳过的文件（{selectedPlan.skippedFiles.length}）</summary><ul>{selectedPlan.skippedFiles.map((item) => <li key={item.fileId}><code>{item.fileId}</code>：{item.reason}</li>)}</ul></details>}
          <div className={styles.operations}>{operations.map((operation) => {
            const tech = extractMediaTechTags(operation.originalName);
            const badges = [tech.resolution, tech.videoSource, tech.dynamicRange, tech.videoCodec, tech.audioCodec, tech.fps, tech.releaseGroup].filter(Boolean);
            return (
              <article className={styles.operation} key={operation.operationId}>
                <strong>{operationStatus(operation.status)}</strong>
                <div>
                  {badges.length > 0 && (
                    <div className={styles.techRow}>
                      {badges.map((badge) => <span key={badge} className={styles.techChip}>{badge}</span>)}
                    </div>
                  )}
                  <div className={styles.pathBox}>
                    <small className={styles.pathOld}>来源：{operation.originalParentId}/{operation.originalName}</small>
                    <small className={styles.pathNew}>目标：{operation.targetRootId}/{operation.targetRelativePath}</small>
                  </div>
                  {operation.pairedFileId !== operation.fileId && <small>配对字幕 ID：{operation.pairedFileId} → {operation.pairedVideoTargetPath}</small>}
                  {operation.error && <small className={styles.errorText}>失败：{operation.error}</small>}
                </div>
              </article>
            );
          })}{!operations.length && !loading && <div className={styles.empty}>该清单没有操作项，跳过原因见上方。</div>}</div>
          {operationCursor && <button className="secondary-button" type="button" onClick={() => void loadMoreOperations()} disabled={loading || busy}>加载更多操作<ChevronRight size={14} /></button>}
        </div>}
      </div>
    </div>}
    {loading && <div className={styles.loading}><LoaderCircle size={16} className={styles.spin} />正在读取整理信息…</div>}
  </section>;
}

function planStatus(status: OrganizationPlanSummary["status"]): string { return ({ planned: "待执行", running: "执行中", paused: "已暂停", completed: "已完成", failed: "失败" })[status]; }
function isAwaitingExecution(plan: OrganizationPlanSummary): boolean {
  return plan.executeRequested === true && (plan.status === "planned" || plan.status === "paused");
}
function planStatusLabel(plan: OrganizationPlanSummary): string {
  if (plan.executeRequested === true && plan.status === "paused") return "等待继续执行";
  if (plan.executeRequested === true && plan.status === "planned") return "已提交等待";
  return planStatus(plan.status);
}
function operationStatus(status: OrganizationOperation["status"]): string { return ({ planned: "待处理", running: "处理中", verified: "已核实", failed: "失败" })[status]; }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date); }
function mergeOperations(current: readonly OrganizationOperation[], next: readonly OrganizationOperation[]): OrganizationOperation[] {
  const seen = new Set(current.map((operation) => operation.operationId));
  return [...current, ...next.filter((operation) => !seen.has(operation.operationId))];
}
interface OrganizationFailureNotice { notice: string; error: string }
function describeOrganizationFailure(cause: unknown, action: "preview" | "execute" | "pause"): OrganizationFailureNotice {
  const label = action === "preview" ? "创建整理预览" : action === "pause" ? "暂停整理" : "开始整理";
  if (cause instanceof OrganizationPayloadError) {
    return { notice: "服务器返回的整理数据格式无效；当前页面已保留。", error: cause.message };
  }
  if (cause instanceof ApiRequestError) {
    const error = `${cause.message}（HTTP ${cause.status}）`;
    if (cause.status >= 400 && cause.status < 500) return { notice: `服务器拒绝${label}：${cause.message}`, error };
    return { notice: `${label}请求结果未能确认。请刷新清单，核实持久化状态后再重试。`, error };
  }
  const error = cause instanceof Error ? cause.message : "请求失败，请稍后重试。";
  return { notice: `${label}请求结果未能确认。请刷新清单，核实持久化状态后再重试。`, error };
}
function pinSelectedPlan(list: readonly OrganizationPlanSummary[], selectedKey: string | null, selected: OrganizationPlanSummary | null): OrganizationPlanSummary[] {
  const seen = new Set<string>();
  const deduped = list.filter((plan) => {
    if (seen.has(plan.operationKey)) return false;
    seen.add(plan.operationKey);
    return true;
  });
  if (selectedKey && selected && !seen.has(selectedKey)) deduped.unshift(selected);
  return deduped.slice(0, PLAN_LIST_LIMIT);
}
