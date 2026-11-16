"use client";

import { previewNamingTemplate, validateNamingTemplate, type NamingTemplateKind } from "@media-track/workflow/naming";
import styles from "./library-scan-settings.module.css";

type TemplateSet = Readonly<Record<NamingTemplateKind, string>>;
const templates: readonly { kind: NamingTemplateKind; label: string; before: string; values: Parameters<typeof previewNamingTemplate>[1] }[] = [
  { kind: "movieDirectory", label: "电影目录", before: "未整理/Grand.Budapest.2014.1080p.mkv", values: { title: "布达佩斯大饭店", originalTitle: "The Grand Budapest Hotel", year: 2014, tmdbId: 120467 } },
  { kind: "movieFile", label: "电影文件", before: "未整理/Grand.Budapest.2014.1080p.mkv", values: { title: "布达佩斯大饭店", originalTitle: "The Grand Budapest Hotel", year: 2014, tmdbId: 120467, resolution: "1080p", ext: ".mkv" } },
  { kind: "tvDirectory", label: "剧集目录", before: "未整理/Severance.S01E01.mkv", values: { title: "人生切割术", originalTitle: "Severance", year: 2022, tmdbId: 95396 } },
  { kind: "seasonDirectory", label: "季目录", before: "未整理/Severance.S01E01.mkv", values: { title: "人生切割术", year: 2022, season: 1 } },
  { kind: "episodeFile", label: "剧集文件", before: "未整理/Severance.S01E01.mkv", values: { title: "人生切割术", originalTitle: "Severance", season: 1, episode: 1, episodeCode: "S01E01", resolution: "1080p", ext: ".mkv" } },
];

export function LibraryNamingTemplates({ value, savedValue, onChange, disabled }: {
  value: TemplateSet; savedValue: TemplateSet; onChange: (value: TemplateSet) => void; disabled: boolean;
}) {
  const render = (kind: NamingTemplateKind): string | null => {
    const sample = templates.find((item) => item.kind === kind)!;
    const result = previewNamingTemplate(value[kind], sample.values);
    return result.ok ? result.path : null;
  };
  return <fieldset className={styles.fieldset}>
    <legend>整理命名模板</legend>
    <p className={styles.hint}>字段使用大括号，例如 {'{title}'}、{'{year}'}、{'{episodeCode}'}；用 / 表示子目录。保存后，整理预览会使用这组模板。</p>
    <div className={styles.namingGrid}>
      {templates.map(({ kind, label, before, values }) => {
        const errors = validateNamingTemplate(value[kind]);
        const preview = errors.length ? null : previewNamingTemplate(value[kind], values);
        const path = preview?.ok ? preview.path : null;
        const parents = kind === "movieDirectory" || kind === "movieFile"
          ? ["电影目标", ...(kind === "movieFile" ? [render("movieDirectory") ?? ""] : [])]
          : ["剧集目标", ...((kind === "seasonDirectory" || kind === "episodeFile") ? [render("tvDirectory") ?? ""] : []), ...(kind === "episodeFile" ? [render("seasonDirectory") ?? ""] : [])];
        const after = path === null ? (preview && !preview.ok ? preview.errors.join("；") : "模板无效") : [...parents, path].filter(Boolean).join("/");
        return <label className={styles.namingField} key={kind}>
          <span className={styles.namingLabel}>{label}{value[kind] !== savedValue[kind] && <em className={styles.namingDirty}>未保存</em>}</span>
          <input aria-label={`${label}模板`} value={value[kind]} onChange={(event) => onChange({ ...value, [kind]: event.target.value })} disabled={disabled} aria-invalid={errors.length > 0} />
          {errors.map((error) => <span className={styles.namingError} key={error}>{error}</span>)}
          {!errors.length && <span className={styles.namingPreview}><small>原路径</small><code>{before}</code><small>整理后</small><code>{after}</code></span>}
        </label>;
      })}
    </div>
  </fieldset>;
}
