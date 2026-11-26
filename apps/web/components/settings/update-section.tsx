import { connection } from "next/server";
import { isDemoMode } from "../../lib/demo-mode";
import { getAutoUpdateSettings, getWorkflowRepository, resolveIsDesktop } from "../../lib/workflow-runtime";
import { ACTIVE_UPDATER_PHASES, type ImageUpdateInfo, type UpdateView } from "../../lib/update-state";
import { loadUpdateView } from "../../lib/update-view-server";
import { resolveCurrentIsOwner } from "../../lib/settings-attention-server";
import type { UpdaterPhase } from "../../lib/updater-client";
import {
  FORK_IMAGE,
  FORK_RELEASES_URL,
  FORK_REPO_URL,
  imageUpdateCommand,
  resolveUpdateDistribution,
} from "../../lib/fork-release";
import { AutoUpdateSwitch, CheckUpdatesButton, CopyCommandButton, UpdateNowButton } from "./update-actions";
import styles from "./update-section.module.css";

const MIGRATE_COMMAND = "./scripts/deploy.sh";
const IMAGE_UPDATE_COMMAND = imageUpdateCommand();
const DEFAULT_AUTO_UPDATE = { enabled: false, time: "04:00" };

const KIND_LABEL = { add: "新增", improve: "改进", fix: "修复" } as const;

/** How to install the download, by installer type ("page" = the release page). */
const INSTALL_HINT = {
  dmg: "下载后打开 .dmg，先从菜单栏图标退出巡影，再把新版拖进「应用程序」替换。数据和设置都会保留。",
  exe: "下载后运行安装包，它会先关掉正在运行的巡影再安装。数据和设置都会保留。",
  page: "在发布页下载对应系统的安装包。数据和设置都会保留。",
} as const;

/* Hallmark · component: update-tab · genre: modern-minimal · theme: project (apps/web/DESIGN.md, Spotify)
 * states: up-to-date · update-available · image-update · desktop-download · updating · waiting · rolled-back · no-updater · offline feed · auto-update row
 * 方向 A：状态卡在上 · 更新日志在下。 */
export async function UpdateSection() {
  await connection();
  if (isDemoMode() || !(await resolveCurrentIsOwner())) return null;
  const desktop = resolveIsDesktop();
  const forkImage = !desktop && resolveUpdateDistribution(process.env) === "fork-image";
  const [view, autoUpdate] = await Promise.all([
    loadUpdateView(),
    forkImage ? Promise.resolve(DEFAULT_AUTO_UPDATE) : getAutoUpdateSettings(getWorkflowRepository()),
  ]);
  return <UpdateTab view={view} desktop={desktop} autoUpdate={autoUpdate} />;
}

export function ReleaseBlock({ release }: { release: UpdateView["releases"][number] }) {
  return (
    <div className="update-release">
      <div className="update-release-head">
        <strong>{release.tag}</strong>
        <span className="update-faint">{release.date}</span>
        {release.isCurrent ? <span className="service-pill">当前</span> : null}
      </div>
      <ul>
        {release.notes.map((note, index) => (
          <li key={`${index}:${note.text}`}>
            <span className={`update-kind is-${note.kind}`}>{KIND_LABEL[note.kind]}</span>
            {note.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Desktop: a newer published release → download it here; cannot tell → the release page; up to date → nothing. */
function DesktopUpdateHint({ view }: { view: UpdateView }) {
  if (view.download) {
    return (
      <div className="update-download">
        <a className="primary-button" href={view.download.url} target="_blank" rel="noopener noreferrer">
          下载新版本
        </a>
        <p className="update-muted">{INSTALL_HINT[view.download.file ?? "page"]}</p>
      </div>
    );
  }
  if (view.status === "latest") return null;
  return (
    <p className="update-muted">
      桌面版在{" "}
      <a href={`${FORK_RELEASES_URL}/latest`} target="_blank" rel="noopener noreferrer">
        发布页
      </a>{" "}
      下载新版本安装包。
    </p>
  );
}

function truncateDigest(digest: string): string {
  return digest.length > 20 ? `${digest.slice(0, 19)}…` : digest;
}

function imageReasonMessage(image: ImageUpdateInfo): string | null {
  switch (image.reason) {
    case "unauthorized":
      return "镜像仓库需要认证或未公开，请在 GitHub Packages 将包设为 Public。";
    case "not_found":
      return `远端未找到镜像标签「${image.tag}」，请核对 MEDIA_TRACK_IMAGE / MEDIA_TRACK_IMAGE_TAG。`;
    case "invalid_ref":
      return "环境变量 MEDIA_TRACK_IMAGE 或 MEDIA_TRACK_IMAGE_TAG 格式无效，请检查配置。";
    case "unreachable":
      return "暂时无法连接镜像仓库，请检查网络连接或配置 HTTPS_PROXY / MEDIA_TRACK_IMAGE 镜像代理。";
    case "missing_local_commit":
      return "当前为本地开发构建（未记录构建提交），仅 CI 构建镜像支持自动比对。";
    case "missing_remote_revision":
      return "远端镜像缺少提交标签（org.opencontainers.image.revision），暂无法比对版本。";
    default:
      return null;
  }
}

function ImageMetadataSection({ image }: { image: ImageUpdateInfo }) {
  const reasonText = imageReasonMessage(image);
  const currentShort = image.currentCommit ? image.currentCommit.slice(0, 8) : null;
  const remoteShort = image.remoteCommit ? image.remoteCommit.slice(0, 8) : null;

  return (
    <>
      {reasonText ? <p className="update-muted">{reasonText}</p> : null}
      <div className={styles.metaGrid}>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>跟踪镜像</span>
          <div className={styles.metaValue}>
            <code className={styles.metaCode}>{image.fullRef}</code>
          </div>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>当前提交</span>
          <div className={styles.metaValue}>
            <code className={styles.metaCode} title={image.currentCommit ?? undefined}>
              {currentShort ?? "本地开发版（未记录构建提交）"}
            </code>
            {image.currentVersion ? <span>({image.currentVersion})</span> : null}
          </div>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>远端镜像提交</span>
          <div className={styles.metaValue}>
            <code className={styles.metaCode} title={image.remoteCommit ?? undefined}>
              {remoteShort ?? "未知"}
            </code>
            {image.remoteVersion ? <span>({image.remoteVersion})</span> : null}
            {image.compareUrl ? (
              <a
                className={styles.compareLink}
                href={image.compareUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                查看提交差异
              </a>
            ) : null}
          </div>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>远端构建时间</span>
          <div className={styles.metaValue}>
            {image.remoteCreatedAt ? formatUpdateFinishedAt(image.remoteCreatedAt) : "未知"}
          </div>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>远端 Digest</span>
          <div className={styles.metaValue}>
            <code className={styles.metaCode} title={image.manifestDigest ?? undefined}>
              {image.manifestDigest ? truncateDigest(image.manifestDigest) : "未知"}
            </code>
          </div>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>上次检查</span>
          <div className={styles.metaValue}>{formatUpdateFinishedAt(image.checkedAt)}</div>
        </div>
      </div>
    </>
  );
}

/** NAS deployments pull the published image; they never build this checkout. */
function ImageUpdateHint({ view }: { view: UpdateView }) {
  const fullRef = view.image?.fullRef ?? `${FORK_IMAGE}:latest`;
  return (
    <div className="update-migrate">
      <p className="update-muted">
        {view.available
          ? "检测到远端镜像已更新，请拉取最新镜像并重建容器："
          : "更新时在部署目录拉取最新镜像并重建容器："}
      </p>
      <pre className="update-cmd">{IMAGE_UPDATE_COMMAND}</pre>
      <CopyCommandButton command={IMAGE_UPDATE_COMMAND} />
      <p className="update-muted">
        如通过群晖/威联通/飞牛/Portainer 等直接运行镜像，重新拉取 {fullRef} 并重建容器即可；固定版本可在 .env 设置 MEDIA_TRACK_IMAGE_TAG。
      </p>
    </div>
  );
}

function outcomeLabel(phase: UpdaterPhase): string {
  if (phase === "done") return "成功";
  if (phase === "rolled_back") return "已回滚";
  return "没成功";
}

export function formatUpdateFinishedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function StatusPill({ view, forkImage }: { view: UpdateView; forkImage: boolean }) {
  if (forkImage) {
    if (view.available) {
      return <span className="service-pill is-on">检测到新镜像，请更新容器</span>;
    }
    if (view.status === "offline") {
      return <span className="service-pill is-off">暂时无法检查更新</span>;
    }
    if (view.status === "unknown") {
      return <span className="service-pill is-off">无法比对镜像版本</span>;
    }
    return <span className="service-pill">已是最新镜像</span>;
  }

  if (view.available) {
    return <span className="service-pill is-on">有新版本 {view.available.tag}</span>;
  }
  if (view.status === "offline") {
    return <span className="service-pill is-off">暂时查不到新版本</span>;
  }
  if (view.status === "unknown") {
    return <span className="service-pill is-off">无法确认是否最新</span>;
  }
  return <span className="service-pill">已是最新</span>;
}

export function UpdateTab({
  view,
  desktop,
  autoUpdate,
}: {
  view: UpdateView;
  desktop: boolean;
  autoUpdate: { enabled: boolean; time: string };
}) {
  const forkImage = !desktop && view.distribution === "fork-image";
  const updating = !forkImage && Boolean(view.updater && ACTIVE_UPDATER_PHASES.has(view.updater.phase));
  const failed = !forkImage && Boolean(view.updater && (view.updater.phase === "rolled_back" || view.updater.phase === "failed"));
  const showCheckButton = !desktop && (forkImage || (!updating && !view.available));

  return (
    <div className="update-tab">
      <section className="panel update-status">
        <div className="update-status-head">
          <div>
            <div className="update-faint">{forkImage ? "当前运行镜像" : "当前版本"}</div>
            <div className="update-version">{view.current.label}</div>
          </div>
          <div className="update-status-side">
            <StatusPill view={view} forkImage={forkImage} />
            {showCheckButton ? <CheckUpdatesButton /> : null}
          </div>
        </div>
        {desktop ? <DesktopUpdateHint view={view} /> : null}
        {forkImage && view.image ? <ImageMetadataSection image={view.image} /> : null}
        {forkImage ? <ImageUpdateHint view={view} /> : null}
        {!desktop && !forkImage && view.updater && (updating || (view.available && !view.updater.needsManualRecovery && !view.updater.servingUnknown)) ? (
          <UpdateNowButton tag={updating ? null : (view.available?.tag ?? null)} initial={view.updater} />
        ) : null}
        {!desktop && !forkImage && !updating && view.available && !view.updater && view.updaterInstalled ? (
          <p className="update-muted">更新助手暂时没有回应，稍后刷新再试。</p>
        ) : null}
        {!desktop && !forkImage && !updating && view.available && !view.updater && !view.updaterInstalled ? (
          <div className="update-migrate">
            <p className="update-muted">一键更新需要先完成一次手动升级。在部署目录运行：</p>
            <pre className="update-cmd">{MIGRATE_COMMAND}</pre>
            <CopyCommandButton command={MIGRATE_COMMAND} />
          </div>
        ) : null}
        {!desktop && !forkImage && failed && view.updater ? (
          <div className="update-failure">
            <p className="update-warn">{view.updater.message}</p>
            <details>
              <summary>查看详情</summary>
              <pre className="update-cmd">{view.updater.logTail}</pre>
            </details>
          </div>
        ) : null}
        {!desktop && !forkImage && view.updater?.finishedAt ? (
          <p className="update-muted">
            上次更新：{formatUpdateFinishedAt(view.updater.finishedAt)} · {outcomeLabel(view.updater.phase)}
          </p>
        ) : null}
      </section>
      {!desktop && !forkImage && view.updaterInstalled ? (
        <section className="panel update-auto">
          <AutoUpdateSwitch initial={autoUpdate} />
          <p className="update-muted">
            有新版本时，每天这个时间自动更新；有获取任务在进行时会等它结束。更新需要几分钟，期间网页会短暂打不开。同一个版本连续两次没更新成功，就不再自动重试，等你点「立即更新」。
          </p>
        </section>
      ) : null}
      <section className="panel update-log">
        <h3 className="update-log-title">更新日志</h3>
        {view.releases.length === 0 ? (
          forkImage ? (
            <p className="update-muted">
              当前跟踪镜像更新记录，可前往{" "}
              <a href={`${FORK_REPO_URL}/commits/main`} target="_blank" rel="noopener noreferrer">
                查看提交记录
              </a>{" "}
              或{" "}
              <a href={FORK_RELEASES_URL} target="_blank" rel="noopener noreferrer">
                查看发布页
              </a>
              。
            </p>
          ) : (
            <p className="update-muted">暂时查不到更新日志。</p>
          )
        ) : null}
        {view.releases.slice(0, 3).map((release) => (
          <ReleaseBlock key={release.tag} release={release} />
        ))}
        {view.releases.length > 3 ? (
          <details className="update-older">
            <summary>更早的版本</summary>
            {view.releases.slice(3, 10).map((release) => (
              <ReleaseBlock key={release.tag} release={release} />
            ))}
            {view.releases.length > 10 ? (
              <p className="update-muted">
                这里只列最近 10 个版本，更早的见{" "}
                <a href={`${FORK_REPO_URL}/tree/main/release-notes`} target="_blank" rel="noopener noreferrer">
                  全部发布说明
                </a>
                。
              </p>
            ) : null}
          </details>
        ) : null}
      </section>
    </div>
  );
}
