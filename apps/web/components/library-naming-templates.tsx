"use client";

import { useMemo, useRef, useState } from "react";
import {
  DEFAULT_NAMING_TEMPLATES,
  NAMING_TEMPLATE_PRESETS,
  deriveSubtitlePath,
  extractMediaTechTags,
  previewNamingTemplate,
  validateNamingTemplate,
  type NamingTemplateKind,
} from "@media-track/workflow/naming";
import styles from "./library-scan-settings.module.css";

type TemplateSet = Readonly<Record<NamingTemplateKind, string>>;

interface SandboxScenario {
  readonly id: string;
  readonly label: string;
  readonly mediaType: "movie" | "tv";
  readonly title: string;
  readonly originalTitle: string;
  readonly year: number;
  readonly tmdbId: number;
  readonly season: number;
  readonly episode: number;
  readonly filename: string;
  readonly subSuffix: string;
}

const TEMPLATE_ITEMS: readonly { kind: NamingTemplateKind; label: string }[] = [
  { kind: "movieDirectory", label: "电影目录" },
  { kind: "movieFile", label: "电影文件" },
  { kind: "tvDirectory", label: "剧集目录" },
  { kind: "seasonDirectory", label: "季目录" },
  { kind: "episodeFile", label: "剧集文件" },
];

const TEMPLATE_TOKENS: readonly { token: string; label: string }[] = [
  { token: "{title}", label: "标题" },
  { token: "{originalTitle}", label: "原名" },
  { token: "{{ ({year})}}", label: "年份" },
  { token: "{{ [tmdbid={tmdbId}]}}", label: "TMDB" },
  { token: "{{ - {mediaTags}}}", label: "全息标签" },
  { token: "{resolution}", label: "清晰度" },
  { token: "{videoSource}", label: "片源" },
  { token: "{dynamicRange}", label: "杜比/HDR" },
  { token: "{videoCodec}", label: "视频编码" },
  { token: "{audioCodec}", label: "音轨" },
  { token: "{fps}", label: "帧率" },
  { token: "{edition}", label: "版本" },
  { token: "{{-{releaseGroup}}}", label: "压制组" },
  { token: "{episodeCode}", label: "集号" },
  { token: "{season:02}", label: "两位季" },
  { token: "{ext}", label: "扩展名" },
];

const SCENARIOS: readonly SandboxScenario[] = [
  {
    id: "dune",
    label: "4K 杜比视界原盘电影",
    mediaType: "movie",
    title: "沙丘2",
    originalTitle: "Dune: Part Two",
    year: 2024,
    tmdbId: 693134,
    season: 1,
    episode: 1,
    filename: "Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10+.HEVC.TrueHD.7.1.Atmos-CHD.mkv",
    subSuffix: ".zh-Hans.forced.ass",
  },
  {
    id: "severance",
    label: "4K 杜比全景声剧集",
    mediaType: "tv",
    title: "人生切割术",
    originalTitle: "Severance",
    year: 2022,
    tmdbId: 95396,
    season: 1,
    episode: 1,
    filename: "Severance.S01E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.H.265-NTb.mkv",
    subSuffix: ".chi.eng.srt",
  },
  {
    id: "budapest",
    label: "1080p 普通电影（缺杜比/组名）",
    mediaType: "movie",
    title: "布达佩斯大饭店",
    originalTitle: "The Grand Budapest Hotel",
    year: 2014,
    tmdbId: 120467,
    season: 1,
    episode: 1,
    filename: "The.Grand.Budapest.Hotel.2014.1080p.WEB-DL.x265.mkv",
    subSuffix: ".zh-Hans.srt",
  },
  {
    id: "bare",
    label: "纯裸文件名（无任何技术标签）",
    mediaType: "movie",
    title: "奥本海默",
    originalTitle: "Oppenheimer",
    year: 2023,
    tmdbId: 872585,
    season: 1,
    episode: 1,
    filename: "奥本海默.mkv",
    subSuffix: ".srt",
  },
];

function stripExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: ".mkv" };
}

export function LibraryNamingTemplates({
  value,
  savedValue,
  onChange,
  disabled,
  movieRootLabel = "电影目标",
  tvRootLabel = "剧集目标",
}: {
  value: TemplateSet;
  savedValue: TemplateSet;
  onChange: (value: TemplateSet) => void;
  disabled: boolean;
  movieRootLabel?: string;
  tvRootLabel?: string;
}) {
  const [focusedKind, setFocusedKind] = useState<NamingTemplateKind>("movieFile");
  const [scenarioId, setScenarioId] = useState<string>("dune");
  const [mediaType, setMediaType] = useState<"movie" | "tv">("movie");
  const [rawFilename, setRawFilename] = useState<string>(SCENARIOS[0]!.filename);
  const inputRefs = useRef<Partial<Record<NamingTemplateKind, HTMLInputElement | null>>>({});

  const activePresetId = useMemo(() => {
    const matched = NAMING_TEMPLATE_PRESETS.find((preset) =>
      TEMPLATE_ITEMS.every(({ kind }) => preset.templates[kind] === value[kind]),
    );
    return matched?.id ?? null;
  }, [value]);

  const activeScenario = SCENARIOS.find((item) => item.id === scenarioId) ?? SCENARIOS[0]!;

  const sandbox = useMemo(() => {
    const effectiveFilename = rawFilename.trim() || activeScenario.filename;
    const { stem, ext } = stripExt(effectiveFilename);
    const episodeCode = `S${String(activeScenario.season).padStart(2, "0")}E${String(activeScenario.episode).padStart(2, "0")}`;
    const tech = extractMediaTechTags(effectiveFilename);
    const values = {
      title: activeScenario.title,
      originalTitle: activeScenario.originalTitle,
      year: activeScenario.year,
      tmdbId: activeScenario.tmdbId,
      season: activeScenario.season,
      episode: activeScenario.episode,
      episodeCode,
      originalName: stem,
      ext: ext || ".mkv",
      ...tech,
    };

    const movieDirRes = previewNamingTemplate(value.movieDirectory, values);
    const movieFileRes = previewNamingTemplate(value.movieFile, values);
    const tvDirRes = previewNamingTemplate(value.tvDirectory, values);
    const seasonDirRes = previewNamingTemplate(value.seasonDirectory, values);
    const episodeFileRes = previewNamingTemplate(value.episodeFile, values);

    let fullAfter = "";
    let subtitleAfter = "";
    if (mediaType === "movie") {
      fullAfter = movieDirRes.ok && movieFileRes.ok
        ? `${movieRootLabel}/${movieDirRes.path}/${movieFileRes.path}`
        : [...(movieDirRes.ok ? [] : movieDirRes.errors), ...(movieFileRes.ok ? [] : movieFileRes.errors)].join("；");
      if (movieDirRes.ok && movieFileRes.ok) {
        const relativeVideo = `${movieDirRes.path}/${movieFileRes.path}`;
        const derived = deriveSubtitlePath(effectiveFilename, `${stem}${activeScenario.subSuffix}`, movieFileRes.path);
        subtitleAfter = derived ? `${movieRootLabel}/${movieDirRes.path}/${derived}` : `${movieRootLabel}/${relativeVideo.replace(/\.[^.]+$/, "")}${activeScenario.subSuffix}`;
      }
    } else {
      fullAfter = tvDirRes.ok && seasonDirRes.ok && episodeFileRes.ok
        ? `${tvRootLabel}/${tvDirRes.path}/${seasonDirRes.path}/${episodeFileRes.path}`
        : [
            ...(tvDirRes.ok ? [] : tvDirRes.errors),
            ...(seasonDirRes.ok ? [] : seasonDirRes.errors),
            ...(episodeFileRes.ok ? [] : episodeFileRes.errors),
          ].join("；");
      if (tvDirRes.ok && seasonDirRes.ok && episodeFileRes.ok) {
        const derived = deriveSubtitlePath(effectiveFilename, `${stem}${activeScenario.subSuffix}`, episodeFileRes.path);
        subtitleAfter = derived
          ? `${tvRootLabel}/${tvDirRes.path}/${seasonDirRes.path}/${derived}`
          : `${tvRootLabel}/${tvDirRes.path}/${seasonDirRes.path}/${episodeFileRes.path.replace(/\.[^.]+$/, "")}${activeScenario.subSuffix}`;
      }
    }

    const badges = [
      tech.resolution ? { text: tech.resolution, tone: "res" as const } : null,
      tech.videoSource ? { text: tech.videoSource, tone: "src" as const } : null,
      tech.dynamicRange ? { text: tech.dynamicRange, tone: "dr" as const } : null,
      tech.videoCodec ? { text: tech.videoCodec, tone: "codec" as const } : null,
      tech.audioCodec ? { text: tech.audioCodec, tone: "audio" as const } : null,
      tech.fps ? { text: tech.fps, tone: "res" as const } : null,
      tech.edition ? { text: tech.edition, tone: "src" as const } : null,
      tech.releaseGroup ? { text: `组:${tech.releaseGroup}`, tone: "group" as const } : null,
    ].filter((item): item is NonNullable<typeof item> => item !== null);

    return { effectiveFilename, fullAfter, subtitleAfter, badges };
  }, [activeScenario, mediaType, movieRootLabel, rawFilename, tvRootLabel, value]);

  const insertToken = (token: string) => {
    if (disabled) return;
    const input = inputRefs.current[focusedKind];
    const current = value[focusedKind];
    if (!input) {
      onChange({ ...value, [focusedKind]: `${current}${token}` });
      return;
    }
    const start = input.selectionStart ?? current.length;
    const end = input.selectionEnd ?? current.length;
    const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
    onChange({ ...value, [focusedKind]: next });
    window.requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <fieldset className={styles.workshopFieldset}>
      <div className={styles.workshopHead}>
        <div>
          <legend className={styles.workshopTitle}>完美命名工坊</legend>
          <p className={styles.hint}>
            默认采用参考 MoviePilot 最佳实践的「完美全息版」规则；支持 <code>{"{{...}}"}</code> 可选片段，缺失画质或压制组时自动隐藏分隔符。
          </p>
        </div>
        {!activePresetId && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => onChange({ ...DEFAULT_NAMING_TEMPLATES })}
            disabled={disabled}
          >
            恢复默认全息版
          </button>
        )}
      </div>

      <div className={styles.presetsGrid} role="group" aria-label="命名预设模板">
        {NAMING_TEMPLATE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`${styles.presetCard} ${activePresetId === preset.id ? styles.presetActive : ""}`}
            onClick={() => onChange({ ...preset.templates })}
            disabled={disabled}
          >
            <div className={styles.presetTop}>
              <strong>{preset.name}</strong>
              <span className={styles.presetBadge}>{preset.badge}</span>
            </div>
            <p>{preset.description}</p>
            <code className={styles.presetSample}>{preset.sample}</code>
          </button>
        ))}
      </div>

      <div className={styles.workshopSplit}>
        <div className={styles.templateColumn}>
          {TEMPLATE_ITEMS.map(({ kind, label }) => {
            const errors = validateNamingTemplate(value[kind]);
            const dirty = value[kind] !== savedValue[kind];
            return (
              <label className={styles.namingField} key={kind}>
                <span className={styles.namingLabel}>
                  <span>
                    {label}
                    {dirty && <em className={styles.namingDirty}>未保存</em>}
                  </span>
                  <span className={errors.length ? styles.tplStatusErr : styles.tplStatusOk}>
                    {errors.length ? `✕ ${errors[0]}` : "✓ 语法有效"}
                  </span>
                </span>
                <input
                  ref={(el) => {
                    inputRefs.current[kind] = el;
                  }}
                  aria-label={`${label}模板`}
                  value={value[kind]}
                  onFocus={() => setFocusedKind(kind)}
                  onChange={(event) => onChange({ ...value, [kind]: event.target.value })}
                  disabled={disabled}
                  aria-invalid={errors.length > 0}
                />
              </label>
            );
          })}

          <div className={styles.chipDrawer}>
            <div className={styles.chipDrawerHead}>
              <strong>点击插入变量（插入当前聚焦输入框）</strong>
              <span>支持 <code>{"{{前缀{字段}}}"}</code> 空值自动折叠</span>
            </div>
            <div className={styles.chipList}>
              {TEMPLATE_TOKENS.map((item) => (
                <button
                  key={item.token}
                  type="button"
                  className={styles.tokenChip}
                  onClick={() => insertToken(item.token)}
                  disabled={disabled}
                >
                  <span>{item.label}</span>
                  <code>{item.token}</code>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.sandboxCard}>
          <div className={styles.sandboxHeader}>
            <strong>实时命名预览沙盒</strong>
            <span>切换典型样本或粘贴任意原文件名，实时查看提取徽章与最终入库路径</span>
          </div>

          <div className={styles.scenarioPills} role="group" aria-label="预览样本场景">
            {SCENARIOS.map((sc) => (
              <button
                key={sc.id}
                type="button"
                className={`${styles.scenarioPill} ${scenarioId === sc.id ? styles.scenarioActive : ""}`}
                onClick={() => {
                  setScenarioId(sc.id);
                  setMediaType(sc.mediaType);
                  setRawFilename(sc.filename);
                }}
              >
                {sc.label}
              </button>
            ))}
          </div>

          <div className={styles.sandboxInputRow}>
            <select
              aria-label="预览媒体类型"
              value={mediaType}
              onChange={(event) => setMediaType(event.target.value as "movie" | "tv")}
            >
              <option value="movie">电影</option>
              <option value="tv">剧集</option>
            </select>
            <input
              aria-label="测试原文件名"
              value={rawFilename}
              onChange={(event) => setRawFilename(event.target.value)}
              placeholder="粘贴带清晰度、杜比、全景声、压制组的文件名..."
            />
          </div>

          <div className={styles.techBadgesWrap}>
            <small>自动识别技术特征</small>
            <div className={styles.techBadgesBar}>
              {sandbox.badges.length > 0 ? (
                sandbox.badges.map((badge) => (
                  <span key={`${badge.tone}-${badge.text}`} className={`${styles.techBadge} ${styles[`tb_${badge.tone}`]}`}>
                    {badge.text}
                  </span>
                ))
              ) : (
                <span className={styles.tbEmpty}>未检测到画质/杜比/压制组标签 — 可选分隔符已自动隐藏</span>
              )}
            </div>
          </div>

          <div className={styles.sandboxResultBox}>
            <div>
              <span>原文件</span>
              <code className={styles.beforeCode}>{sandbox.effectiveFilename}</code>
            </div>
            <div>
              <span>整理后完整路径</span>
              <code className={styles.afterCode}>{sandbox.fullAfter}</code>
            </div>
            {sandbox.subtitleAfter && (
              <div>
                <span>随行字幕联动示例</span>
                <code className={styles.subCode}>{sandbox.subtitleAfter}</code>
              </div>
            )}
          </div>
        </div>
      </div>
    </fieldset>
  );
}
