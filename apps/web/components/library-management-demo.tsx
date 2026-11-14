"use client";

import { useEffect, useState } from "react";
import "./library-management.css";

type ScanState = "idle" | "running" | "paused" | "cancelled" | "done";
type TemplateKey = "电影目录" | "电影文件" | "剧集目录" | "季目录" | "剧集文件";

export const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
  电影目录: "{title} ({year})",
  电影文件: "{title} ({year}){ext}",
  剧集目录: "{title} ({year})",
  季目录: "Season {season:02}",
  剧集文件: "{title} - {episodeCode}{ext}",
};

const templatesSeed = { ...DEFAULT_TEMPLATES };
export function buildTemplatePreview(key: TemplateKey, template: string): { before: string; after: string } {
  const isTvTemplate = key === "剧集目录" || key === "季目录" || key === "剧集文件";
  const isFolderTemplate = key === "电影目录" || key === "剧集目录" || key === "季目录";
  const title = isTvTemplate ? "人生切割术" : "布达佩斯大饭店";
  const year = isTvTemplate ? "2022" : "2014";
  const before = key === "季目录" ? "Season 1" : isFolderTemplate ? `${title} (${year})` : `${title} - ${isTvTemplate ? "S01E01" : year}.mkv`;
  return {
    before,
    after: template.replaceAll("{title}", title).replaceAll("{year}", year)
      .replaceAll("{season:02}", "01").replaceAll("{episodeCode}", "S01E01").replaceAll("{ext}", ".mkv"),
  };
}

const candidates = [
  { id: 1, name: "The Grand Budapest Hotel (2014).mkv", folder: "电影/布达佩斯大饭店", confidence: "高置信度", title: "布达佩斯大饭店", type: "电影", status: "已识别" },
  { id: 2, name: "Severance.S02E03.1080p.mkv", folder: "剧集/人生切割术/Season 2", confidence: "高置信度", title: "人生切割术 · S02E03", type: "剧集", status: "已识别" },
  { id: 3, name: "The.Bear.S01E01.mkv", folder: "剧集/待确认", confidence: "需要确认", title: "熊家餐馆？", type: "剧集", status: "待确认" },
];

export default function LibraryManagementDemo() {
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [progress, setProgress] = useState(0);
  const [templates, setTemplates] = useState(templatesSeed);
  const [activeTemplate, setActiveTemplate] = useState<TemplateKey>("电影文件");
  const [confirmed, setConfirmed] = useState<number[]>([]);
  const [identityInputs, setIdentityInputs] = useState<Record<number, string>>({ 3: "熊家餐馆 (2022)" });
  const [autoFill, setAutoFill] = useState(false);

  useEffect(() => {
    if (scanState !== "running") return;
    const timer = window.setInterval(() => setProgress((value) => {
      if (value >= 100) { setScanState("done"); return 100; }
      return Math.min(100, value + 5);
    }), 500);
    return () => window.clearInterval(timer);
  }, [scanState]);

  const preview = buildTemplatePreview(activeTemplate, templates[activeTemplate]);

  return <main className="library-demo">
    <header className="library-demo-heading">
      <div><div className="library-demo-eyebrow">媒体库 · 演示模式</div><h1>已有库管理</h1><p>扫描已有目录，确认作品身份，并预览统一命名结果。</p></div>
      <span className="library-demo-status"><i /> 本地交互演示</span>
    </header>

    <section className="panel library-demo-panel">
      <div className="panel-header"><div><div className="panel-title">扫描配置</div><div className="panel-note">配置光鸭目录来源与媒体库目标</div></div><span className="library-demo-tag">未连接网盘</span></div>
      <div className="library-demo-config">
        <label>扫描来源<select defaultValue="guangya"><option value="guangya">光鸭云盘 · 我的资源</option><option>光鸭云盘 · 家庭共享</option></select></label>
        <label>扫描目录<input defaultValue="/媒体库/待整理" /></label>
        <label>媒体类型<select defaultValue="mixed"><option value="mixed">电影 + 剧集</option><option>电影</option><option>剧集</option></select></label>
        <label>整理目标<input defaultValue="/媒体库/已整理" /></label>
      </div>
      <div className="library-demo-actions">
        {scanState === "idle" || scanState === "cancelled" || scanState === "done" ? <button className="primary-button" onClick={() => { setProgress(0); setScanState("running"); }}>立即扫描</button> : null}
        {scanState === "running" ? <button className="secondary-button" onClick={() => setScanState("paused")}>暂停扫描</button> : null}
        {scanState === "paused" ? <button className="primary-button" onClick={() => setScanState("running")}>继续扫描</button> : null}
        {(scanState === "running" || scanState === "paused") ? <button className="secondary-button" onClick={() => setScanState("cancelled")}>取消</button> : null}
        <span className="library-demo-disclaimer">所有操作仅更新当前页面的演示状态</span>
      </div>
      {scanState !== "idle" ? <div className="library-demo-progress"><div className="library-demo-progress-label"><strong>{scanState === "running" ? "正在遍历目录" : scanState === "paused" ? "扫描已暂停" : scanState === "done" ? "扫描完成" : "扫描已取消"}</strong><span>{progress}% · 已检查 {Math.round(progress * 1.24)} / 124 个项目</span></div><div className="library-demo-track"><i style={{ width: `${progress}%` }} /></div><div className="library-demo-note">已发现 2 个目录 · 3 个媒体文件 · 1 个待确认</div></div> : null}
    </section>

    <div className="library-demo-columns">
      <section className="panel library-demo-panel"><div className="panel-header"><div><div className="panel-title">识别结果</div><div className="panel-note">确认内容身份，不涉及下载资源选择</div></div><span className="library-demo-count">3 项</span></div>
        <div className="library-demo-list">{candidates.map((item) => { const isConfirmed = confirmed.includes(item.id); return <article className="library-demo-item" key={item.id}><div className="library-demo-item-top"><span className={`library-demo-badge ${item.status === "已识别" || isConfirmed ? "is-ok" : "is-pending"}`}>{isConfirmed ? "已确认" : item.status}</span><span>{item.type} · {isConfirmed ? "人工确认" : item.confidence}</span></div><strong>{isConfirmed ? identityInputs[item.id] : item.title}</strong><div className="library-demo-filename">{item.name}</div><div className="library-demo-path">来源：{item.folder}</div>{item.status === "待确认" ? <div className="library-demo-confirm"><input aria-label={`确认身份 ${item.id}`} value={identityInputs[item.id] ?? ""} onChange={(event) => setIdentityInputs((xs) => ({ ...xs, [item.id]: event.target.value }))} /><button className="secondary-button" onClick={() => setConfirmed((xs) => xs.includes(item.id) ? xs : [...xs, item.id])} disabled={!identityInputs[item.id]?.trim()}>{isConfirmed ? "已确认" : "确认身份"}</button></div> : null}</article>; })}</div>
      </section>

      <div className="library-demo-side">
        <section className="panel library-demo-panel"><div className="panel-header"><div><div className="panel-title">命名模板</div><div className="panel-note">分别设置电影和剧集目录与文件</div></div></div>
          <label className="library-demo-field">模板类型<select value={activeTemplate} onChange={(event) => setActiveTemplate(event.target.value as TemplateKey)}>{Object.keys(DEFAULT_TEMPLATES).map((key) => <option key={key}>{key}</option>)}</select></label>
          <label className="library-demo-field">模板内容<input value={templates[activeTemplate]} onChange={(event) => setTemplates((previous) => ({ ...previous, [activeTemplate]: event.target.value }))} /></label>
          <div className="library-demo-tokens">可用字段：<code>{"{title}"}</code> <code>{"{year}"}</code> <code>{"{season:02}"}</code> <code>{"{episodeCode}"}</code> <code>{"{ext}"}</code></div>
          <div className="library-demo-preview"><div><span>修改前</span><code>{preview.before}</code></div><div><span>修改后预览</span><code>{preview.after}</code></div></div>
        </section>
        <section className="panel library-demo-panel library-demo-autofill"><div><div className="panel-title">自动补缺</div><div className="panel-note">新导入作品自动加入追更</div></div><label className="library-demo-switch"><input type="checkbox" checked={autoFill} onChange={(event) => setAutoFill(event.target.checked)} /><span>{autoFill ? "已开启" : "默认关闭"}</span></label></section>
      </div>
    </div>
    <footer className="library-demo-footer">演示数据仅保存在浏览器当前页面，刷新后恢复初始状态。</footer>
  </main>;
}
