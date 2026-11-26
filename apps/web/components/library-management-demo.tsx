"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import {
  DEFAULT_NAMING_TEMPLATES,
  extractMediaTechTags,
  previewNamingTemplate,
} from "@media-track/workflow/naming";
import { LibraryNamingTemplates } from "./library-naming-templates";
import "./library-management.css";

type ScanState = "idle" | "running" | "paused" | "cancelled" | "done";
export type TemplateKey = "电影目录" | "电影文件" | "剧集目录" | "季目录" | "剧集文件";

export const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
  电影目录: DEFAULT_NAMING_TEMPLATES.movieDirectory,
  电影文件: DEFAULT_NAMING_TEMPLATES.movieFile,
  剧集目录: DEFAULT_NAMING_TEMPLATES.tvDirectory,
  季目录: DEFAULT_NAMING_TEMPLATES.seasonDirectory,
  剧集文件: DEFAULT_NAMING_TEMPLATES.episodeFile,
};

export function buildTemplatePreview(key: TemplateKey, template: string): { before: string; after: string } {
  const isTv = key === "剧集目录" || key === "季目录" || key === "剧集文件";
  const sampleFile = isTv
    ? "Severance.S01E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.H.265-NTb.mkv"
    : "Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10+.HEVC.TrueHD.7.1.Atmos-CHD.mkv";
  const tech = extractMediaTechTags(sampleFile);
  const rendered = previewNamingTemplate(template, {
    title: isTv ? "人生切割术" : "沙丘2",
    originalTitle: isTv ? "Severance" : "Dune: Part Two",
    year: isTv ? 2022 : 2024,
    tmdbId: isTv ? 95396 : 693134,
    season: 1,
    episode: 1,
    episodeCode: "S01E01",
    ext: ".mkv",
    ...tech,
  });
  const before = key === "季目录"
    ? "Season 1"
    : key === "电影目录"
      ? "沙丘2 (2024)"
      : key === "剧集目录"
        ? "人生切割术 (2022)"
        : sampleFile;
  return {
    before,
    after: rendered.ok ? rendered.path : rendered.errors.join("；"),
  };
}

const candidates = [
  { id: 1, name: "Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10+.HEVC.TrueHD.7.1.Atmos-CHD.mkv", folder: "电影/待整理", confidence: "高置信度", title: "沙丘2", type: "电影", status: "已识别" },
  { id: 2, name: "Severance.S01E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.H.265-NTb.mkv", folder: "剧集/人生切割术/Season 1", confidence: "高置信度", title: "人生切割术 · S01E01", type: "剧集", status: "已识别" },
  { id: 3, name: "The.Bear.S01E01.2160p.HDR10.DDP5.1.mkv", folder: "剧集/待确认", confidence: "需要确认", title: "熊家餐馆？", type: "剧集", status: "待确认" },
];

export default function LibraryManagementDemo() {
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [progress, setProgress] = useState(0);
  const [templates, setTemplates] = useState(DEFAULT_NAMING_TEMPLATES);
  const [autoOrganize, setAutoOrganize] = useState(true);
  const [confirmed, setConfirmed] = useState<number[]>([]);
  const [identityInputs, setIdentityInputs] = useState<Record<number, string>>({ 3: "熊家餐馆 (2022)" });
  const [autoFill, setAutoFill] = useState(false);

  useEffect(() => {
    if (scanState !== "running") return;
    const timer = window.setInterval(() => setProgress((value) => {
      if (value >= 100) { setScanState("done"); return 100; }
      return Math.min(100, value + 5);
    }), 350);
    return () => window.clearInterval(timer);
  }, [scanState]);

  return (
    <main className="library-demo">
      <header className="library-demo-heading">
        <div>
          <div className="library-demo-eyebrow">媒体库 · 演示模式</div>
          <h1>库管理交互演示</h1>
          <p>默认开启入库自动整理，并内置参考 MoviePilot 社区实践的完美全息命名规则。</p>
        </div>
        <span className="library-demo-status"><i /> 本地交互演示</span>
      </header>

      <section className={`panel library-demo-panel library-demo-hero ${autoOrganize ? "" : "is-paused"}`}>
        <div className="library-demo-hero-copy">
          <Sparkles size={20} />
          <div>
            <strong>{autoOrganize ? "入库自动整理已默认开启" : "入库自动整理已暂停"}</strong>
            <p>搜片下载、追更或机器人转存落盘后即刻自动重命名并归类，无需定时扫描。</p>
          </div>
        </div>
        <label className="library-demo-switch">
          <input type="checkbox" checked={autoOrganize} onChange={(event) => setAutoOrganize(event.target.checked)} />
          <span>{autoOrganize ? "已开启" : "已暂停"}</span>
        </label>
      </section>

      <section className="panel library-demo-panel">
        <LibraryNamingTemplates
          value={templates}
          savedValue={DEFAULT_NAMING_TEMPLATES}
          onChange={setTemplates}
          disabled={false}
          movieRootLabel="/媒体库/电影"
          tvRootLabel="/媒体库/剧集"
        />
      </section>

      <section className="panel library-demo-panel">
        <div className="panel-header">
          <div><div className="panel-title">存量目录扫描与待确认识别</div><div className="panel-note">仅针对历史老文件按需扫描</div></div>
          <div className="library-demo-actions" style={{ marginTop: 0 }}>
            {scanState === "idle" || scanState === "cancelled" || scanState === "done" ? <button className="primary-button" onClick={() => { setProgress(0); setScanState("running"); }}>立即扫描存量</button> : null}
            {scanState === "running" ? <button className="secondary-button" onClick={() => setScanState("paused")}>暂停扫描</button> : null}
            {scanState === "paused" ? <button className="primary-button" onClick={() => setScanState("running")}>继续扫描</button> : null}
            {(scanState === "running" || scanState === "paused") ? <button className="secondary-button" onClick={() => setScanState("cancelled")}>取消</button> : null}
          </div>
        </div>
        {scanState !== "idle" ? <div className="library-demo-progress"><div className="library-demo-progress-label"><strong>{scanState === "running" ? "正在遍历目录" : scanState === "paused" ? "扫描已暂停" : scanState === "done" ? "扫描完成" : "扫描已取消"}</strong><span>{progress}% · 已检查 {Math.round(progress * 1.24)} / 124 个项目</span></div><div className="library-demo-track"><i style={{ width: `${progress}%` }} /></div></div> : null}

        <div className="library-demo-list" style={{ marginTop: 14 }}>
          {candidates.map((item) => {
            const isConfirmed = confirmed.includes(item.id);
            const tech = extractMediaTechTags(item.name);
            const badges = [tech.resolution, tech.videoSource, tech.dynamicRange, tech.videoCodec, tech.audioCodec, tech.releaseGroup].filter(Boolean);
            return (
              <article className="library-demo-item" key={item.id}>
                <div className="library-demo-item-top">
                  <span className={`library-demo-badge ${item.status === "已识别" || isConfirmed ? "is-ok" : "is-pending"}`}>{isConfirmed ? "已确认" : item.status}</span>
                  <span>{item.type} · {isConfirmed ? "人工确认" : item.confidence}</span>
                </div>
                <strong>{isConfirmed ? identityInputs[item.id] : item.title}</strong>
                <div className="library-demo-filename">{item.name}</div>
                {badges.length > 0 && <div className="library-demo-badges">{badges.map((b) => <span key={b}>{b}</span>)}</div>}
                <div className="library-demo-path">来源：{item.folder}</div>
                {item.status === "待确认" ? <div className="library-demo-confirm"><input aria-label={`确认身份 ${item.id}`} value={identityInputs[item.id] ?? ""} onChange={(event) => setIdentityInputs((xs) => ({ ...xs, [item.id]: event.target.value }))} /><button className="secondary-button" onClick={() => setConfirmed((xs) => xs.includes(item.id) ? xs : [...xs, item.id])} disabled={!identityInputs[item.id]?.trim()}>{isConfirmed ? "已确认" : "确认身份"}</button></div> : null}
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel library-demo-panel library-demo-autofill">
        <div><div className="panel-title">新导入剧季自动补缺</div><div className="panel-note">默认关闭，避免存量老片意外自动下载</div></div>
        <label className="library-demo-switch"><input type="checkbox" checked={autoFill} onChange={(event) => setAutoFill(event.target.checked)} /><span>{autoFill ? "已开启" : "默认关闭"}</span></label>
      </section>

      <footer className="library-demo-footer">演示数据仅保存在浏览器当前页面，刷新后恢复初始状态。</footer>
    </main>
  );
}
