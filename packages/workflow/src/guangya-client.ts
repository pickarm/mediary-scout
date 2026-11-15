import { parseFiniteMetric } from "./domain.js";
import { fetchWithTimeout } from "./fetch-with-timeout.js";
import type { GuangYaAuthCoordinator } from "./library/guangya-auth-coordinator.js";
import type { GuangYaCredentialSnapshot } from "./library/guangya-token-persister.js";
import type { GuangYaRequestPriority, GuangYaRequestScheduler } from "./library/guangya-request-scheduler.js";

/**
 * 光鸭云盘 (GuangYaPan) HTTP client — the brand-3 analogue of Pan115CookieClient
 * and QuarkCookieClient. Unlike those two (cookie auth), 光鸭 uses OAuth Bearer
 * tokens (access_token + refresh_token) issued by `account.guangyapan.com`.
 *
 * Two hosts:
 *  - account.guangyapan.com — auth (validate user, refresh token). Bearer only.
 *  - api.guangyapan.com     — files + offline. Bearer + `Did:<deviceId>` + `Dt:4`.
 *
 * SUCCESS SIGNAL: `msg === ""` OR `msg.toLowerCase() === "success"`. The `code`
 * field is null on every response and MUST NOT be used as the signal.
 *
 * On a 401 the access_token is stale; we refresh once (POST /v1/auth/token with
 * the refresh_token) and retry the call. A fresh access/refresh pair is surfaced
 * via `onTokensRefreshed` so the executor can persist it. The executor that uses
 * this client (StorageExecutor) is a later task — this file is the API layer only.
 */

export const GUANGYA_CLIENT_ID = "aMe-8VSlkrbQXpUR";

const AUTH_HOST = "https://account.guangyapan.com";
const API_HOST = "https://api.guangyapan.com";

const DEFAULT_LIST_PAGE_SIZE = 100;
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
/** HTTP 200 envelope codes that mean the access_token is expired (per official
 *  guangyapan-drive v1.0.2 `src/api-client.mjs`: `const AUTH_CODES = new Set([110, 117, 118])`). */
const GUANGYA_AUTH_EXPIRED_CODES = new Set([110, 117, 118]);
const GUANGYA_WRITE_PATHS = new Set([
  "/nd.bizuserres.s/v1/file/create_dir",
  "/nd.bizuserres.s/v1/file/rename",
  "/nd.bizuserres.s/v1/file/delete_file",
  "/nd.bizuserres.s/v1/file/move_file",
  "/cloudcollection/v1/create_task",
  "/userres/v1/restore_share",
]);

/** A directory listing entry from get_file_list. */
export interface GuangYaItem {
  fileId: string;
  parentId: string;
  fileName: string;
  fileSize: number;
  resType: number;
}

/** One subfile inside a bt/磁力 resource (fileIndex is null when the API omits it;
 *  nested directories carry `isDir: true` and `subfiles`). */
export interface GuangYaSubfile {
  fileName: string;
  fileIndex: number | null;
  fileSize: number;
  isDir?: boolean;
  subfiles?: GuangYaSubfile[];
}

/** resolve_res result, parsed into the typed shape the executor relies on. */
export interface GuangYaResolvedRes {
  resType: number;
  url?: string;
  btResInfo?: {
    infoHash: string;
    fileName: string;
    subfiles: GuangYaSubfile[];
    /** Server-recommended junk/ad file indexes to exclude (from official skill). */
    excludeIndices?: number[];
  };
}

/** One offline-task status row from list_task. */
export interface GuangYaTaskStatus {
  taskId: string;
  status: number;
  progress: number;
  fileId: string;
}

/** The token pair (+ the device id they were bound to) handed to the persist hook. */
export interface GuangYaTokens {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
}

export type GuangYaFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GuangYaClientOptions {
  accessToken: string;
  refreshToken: string;
  /** Stable per-install device id sent as the `Did` header. Auto-generated (32 hex) if empty. */
  deviceId?: string;
  /** Called after a successful refresh so the caller can persist the new tokens. */
  onTokensRefreshed?: (tokens: GuangYaTokens, expectedSnapshot?: GuangYaCredentialSnapshot) => void | boolean | Promise<void | boolean>;
  /** Optional process-wide refresh lock. All three auth options must be supplied together. */
  authCoordinator?: GuangYaAuthCoordinator;
  authAccountKey?: string;
  /** Reads the currently active credentials for this exact connected storage row. */
  loadCurrentCredentials?: () => Promise<GuangYaTokens | { tokens: GuangYaTokens; snapshot: GuangYaCredentialSnapshot } | null>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: GuangYaFetch;
  /** Optional shared account queue. Omitted direct clients preserve their old behavior. */
  requestScheduler?: GuangYaRequestScheduler;
  /** Optional fence run inside the request slot immediately before mutations. */
  beforeWrite?: () => void | Promise<void>;
  /** Priority used by API calls other than explicit scan listings. Defaults to writes. */
  requestPriority?: GuangYaRequestPriority;
}

/**
 * The token pair is dead / refresh failed — distinct from a generic API error so
 * the worker can FREEZE the drive on this specifically. Mirrors QuarkAuthError /
 * Pan115AuthError.
 */
export class GuangYaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuangYaAuthError";
  }
}

const authFailureSnapshots = new WeakMap<Error, GuangYaCredentialSnapshot>();

/** Private credential context for CAS freezing; never stored on enumerable error fields. */
export function getGuangYaAuthFailureSnapshot(error: unknown): GuangYaCredentialSnapshot | null {
  return error instanceof Error ? authFailureSnapshots.get(error) ?? null : null;
}

function bindAuthFailureSnapshot(error: unknown, snapshot: GuangYaCredentialSnapshot | undefined): void {
  if (error instanceof GuangYaAuthError && snapshot) {
    authFailureSnapshots.set(error, snapshot);
  }
}

/** The client is bound to a row that was unbound, frozen, or rebound while it was running. */
export class GuangYaConnectionChangedError extends Error {
  constructor() {
    super("GUANGYA_CONNECTION_CHANGED: connected storage no longer matches this client");
    this.name = "GuangYaConnectionChangedError";
  }
}

export function isGuangYaAuthError(error: unknown): error is GuangYaAuthError {
  return error instanceof GuangYaAuthError;
}

/**
 * Decode the `sub` (user id) from a 光鸭 access_token (a JWT). Returns the sub
 * string, or null when the token is malformed / missing a sub. Keys the
 * instance-wide UNIQUE(provider, provider_uid).
 */
export function parseGuangYaUid(accessToken: string): string | null {
  const segments = accessToken.split(".");
  const payloadSegment = segments[1];
  if (!payloadSegment) {
    return null;
  }
  try {
    const payloadJson = Buffer.from(payloadSegment, "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as unknown;
    const sub = recordValue(payload, "sub");
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Parse a 光鸭 share link. The shareId is the WHOLE path segment after /s/
 * (`1947864096514232347_amtV6IXLP9l33m6z` — splitting on "_" is rejected with 112
 * 参数错误, real probe 2026-09-24). The 提取码 rides in `?pwd=` / `?code=`.
 * Returns null for anything that is not a 光鸭 share URL.
 */
export function parseGuangYaShareUrl(url: string): { shareId: string; code: string } | null {
  const noFragment = url.split("#")[0] ?? url;
  // The id must be the WHOLE segment: it ends at the url end, "?" or a single
  // trailing "/" — never "/s/abc/other" or "/s/abc.evil".
  const m = /^https?:\/\/(?:www\.)?guangyapan\.com\/s\/([0-9A-Za-z_-]+)\/?(?:\?|$)/.exec(noFragment);
  if (!m?.[1]) {
    return null;
  }
  const params = new URLSearchParams(noFragment.split("?")[1] ?? "");
  return { shareId: m[1], code: params.get("pwd") ?? params.get("code") ?? params.get("password") ?? "" };
}

export class GuangYaClient {
  private accessToken: string;
  private refreshToken: string;
  private deviceId: string;
  private readonly onTokensRefreshed: ((tokens: GuangYaTokens, expectedSnapshot?: GuangYaCredentialSnapshot) => void | boolean | Promise<void | boolean>) | undefined;
  private readonly fetchImpl: GuangYaFetch;
  private readonly requestScheduler: GuangYaRequestScheduler | undefined;
  private readonly requestPriority: GuangYaRequestPriority;
  private readonly beforeWrite: (() => void | Promise<void>) | undefined;
  private readonly authCoordinator: GuangYaAuthCoordinator | undefined;
  private readonly authAccountKey: string | undefined;
  private readonly loadCurrentCredentials: (() => Promise<GuangYaTokens | { tokens: GuangYaTokens; snapshot: GuangYaCredentialSnapshot } | null>) | undefined;
  private activeAuthSnapshot: GuangYaCredentialSnapshot | undefined;

  constructor(options: GuangYaClientOptions) {
    // Trim tokens defensively (mirrors TianyiClient): the credential extraction now
    // hands over the raw stored blob, so the client is the single place that
    // sanitizes — a stray-whitespace token (e.g. from a refresh response) never
    // reaches the `Bearer` header.
    this.accessToken = options.accessToken.trim();
    this.refreshToken = options.refreshToken.trim();
    this.deviceId = options.deviceId?.trim() || generateGuangYaDeviceId();
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetchWithTimeout(url, init, DEFAULT_HTTP_TIMEOUT_MS));
    this.requestScheduler = options.requestScheduler;
    this.requestPriority = options.requestPriority ?? "write";
    this.beforeWrite = options.beforeWrite;
    const authPortCount = [options.authCoordinator, options.authAccountKey, options.loadCurrentCredentials]
      .filter((value) => value !== undefined).length;
    if (authPortCount !== 0 && authPortCount !== 3) throw new Error("GUANGYA_AUTH_COORDINATION_PORT_INCOMPLETE");
    if (authPortCount === 3 && !options.authAccountKey?.trim()) throw new Error("GUANGYA_AUTH_ACCOUNT_KEY_REQUIRED");
    if (authPortCount === 3 && !options.onTokensRefreshed) throw new Error("GUANGYA_AUTH_PERSISTER_REQUIRED");
    this.authCoordinator = options.authCoordinator;
    this.authAccountKey = options.authAccountKey?.trim();
    this.loadCurrentCredentials = options.loadCurrentCredentials;
  }

  /** GET account/v1/user/me (Bearer); refresh+retry once on 401. Returns `sub`. */
  async validateToken(): Promise<string> {
    const sub = await this.getMeSub(false);
    if (!sub) {
      throw new GuangYaAuthError("GUANGYA_VALIDATE_FAILED: response missing sub");
    }
    return sub;
  }

  private async getMeSub(retried: boolean): Promise<string> {
    let requestSnapshot: GuangYaCredentialSnapshot | undefined;
    const response = await this.fetchScheduled(
      `${AUTH_HOST}/v1/user/me`,
      () => ({ method: "GET", headers: this.authHeaders(() => { requestSnapshot = this.activeAuthSnapshot; }) }),
      "read",
    );
    if (response.status === 401) {
      if (retried) {
        const error = new GuangYaAuthError("GUANGYA_VALIDATE_FAILED: 401 after refresh");
        bindAuthFailureSnapshot(error, requestSnapshot);
        throw error;
      }
      await this.refreshTokens();
      return this.getMeSub(true);
    }
    const body = (await response.json()) as unknown;
    const sub = recordValue(body, "sub");
    return typeof sub === "string" ? sub : "";
  }

  /** Paginate get_file_list into a flat GuangYaItem[]. */
  async listFiles(parentId: string, page = 0, pageSize = DEFAULT_LIST_PAGE_SIZE): Promise<GuangYaItem[]> {
    const items: GuangYaItem[] = [];
    let currentPage = page;
    for (;;) {
      const data = await this.postAPI("/userres/v1/file/get_file_list", {
        parentId,
        page: currentPage,
        pageSize,
        orderBy: 3,
        sortType: 1,
        fileTypes: [],
      }, false, undefined, "scan-read");
      const list = arrayValue(recordValue(data, "list")).filter(isRecord);
      for (const raw of list) {
        items.push(toItem(raw));
      }
      if (list.length < pageSize) {
        break;
      }
      currentPage += 1;
    }
    return items;
  }

  /** Fetch exactly one get_file_list page; existing listFiles callers retain auto-pagination. */
  async listFilesPage(
    parentId: string,
    page: number,
    pageSize = DEFAULT_LIST_PAGE_SIZE,
  ): Promise<{ items: GuangYaItem[]; hasMore: boolean }> {
    if (!Number.isSafeInteger(page) || page < 0) throw new RangeError("page must be a non-negative integer");
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new RangeError("pageSize must be between 1 and 500");
    const data = await this.postAPI("/userres/v1/file/get_file_list", {
      parentId,
      page,
      pageSize,
      orderBy: 3,
      sortType: 1,
      fileTypes: [],
    }, false, undefined, "scan-read");
    const list = arrayValue(recordValue(data, "list")).filter(isRecord);
    return { items: list.map(toItem), hasMore: list.length === pageSize };
  }

  /** Create a directory under `parentId`; returns the new fileId. */
  async createDir(parentId: string, dirName: string): Promise<string> {
    const data = await this.postAPI("/nd.bizuserres.s/v1/file/create_dir", { parentId, dirName });
    const fileId = stringValue(recordValue(data, "fileId"));
    if (!fileId) {
      throw new Error("GUANGYA_CREATE_DIR_FAILED: response missing data.fileId");
    }
    return fileId;
  }

  async renameFile(fileId: string, newName: string): Promise<void> {
    await this.postAPI("/nd.bizuserres.s/v1/file/rename", { fileId, newName });
  }

  async deleteFiles(fileIds: string[]): Promise<void> {
    await this.postAPI("/nd.bizuserres.s/v1/file/delete_file", { fileIds });
  }

  async moveFiles(fileIds: string[], parentId: string): Promise<void> {
    await this.postAPI("/nd.bizuserres.s/v1/file/move_file", { fileIds, parentId });
  }

  /** Resolve a share/magnet URL to its resType + (for bt) subfile listing. */
  async resolveRes(url: string): Promise<GuangYaResolvedRes> {
    const data = await this.postAPI("/cloudcollection/v1/resolve_res", { url }, false, undefined, "read");
    return toResolvedRes(data);
  }

  /** Create an offline-download task; returns the taskId. */
  async createTask(input: {
    url: string;
    parentId: string;
    newName: string;
    fileIndexes?: number[];
  }): Promise<string> {
    const body: Record<string, unknown> = {
      url: input.url,
      parentId: input.parentId,
      newName: input.newName,
    };
    if (input.fileIndexes !== undefined) {
      body.fileIndexes = input.fileIndexes;
    }
    const data = await this.postAPI("/cloudcollection/v1/create_task", body);
    const taskId = stringValue(recordValue(data, "taskId"));
    if (!taskId) {
      throw new Error("GUANGYA_CREATE_TASK_FAILED: response missing data.taskId");
    }
    return taskId;
  }

  // ── 分享链转存 ──────────────────────────────────────────────────────────────
  // Protocol from github.com/BugGeeker/guangyaclient-go (2026-09-20) + the official
  // web bundle, verified against the real drive 2026-09-24 (docs/claude-memory/
  // guangya-share-transfer-api.md). All calls ride postAPI (Bearer + Did + Dt:4,
  // 401 → refresh once) — the share endpoints accept the logged-in headers.

  /** Exchange (shareId, 提取码) for a share accessToken. A dead share comes back as
   *  a business code (201 分享已失效 / 200 分享链接错误 / 112 参数错误) with HTTP 200,
   *  which postAPI already turns into a loud GUANGYA_API_FAILED carrying the msg. */
  async getShareAccessToken(shareId: string, code: string): Promise<string> {
    const envelope: { top?: unknown } = {};
    const data = await this.postAPI("/userres/v1/get_share_access_token", { shareId, code }, false, envelope, "read");
    // Real responses carry data.accessToken (probe 2026-09-24); guangyaclient-go also
    // models a top-level access_token, so accept either rather than call a live share dead.
    const token = stringValue(recordValue(data, "accessToken")) || stringValue(recordValue(envelope.top, "access_token"));
    if (!token) {
      throw new Error("GUANGYA_SHARE_TOKEN_FAILED: response missing data.accessToken");
    }
    return token;
  }

  /** List one directory of a share (parentId "" = share root). Cursor mode, exactly
   *  the web client's body; `cursor` MUST be a number (a string is rejected with a
   *  bind error). A response with no `list` is an empty page — seen on half of the
   *  real shares probed, where summary and token succeed but nothing is listable. */
  async listShareFiles(
    accessToken: string,
    parentId: string,
    options: { pageSize?: number; maxPages?: number } = {},
  ): Promise<GuangYaItem[]> {
    const pageSize = options.pageSize ?? DEFAULT_LIST_PAGE_SIZE;
    // Pagination is by RESPONSE cursor echoed back (real-drive walk 2026-09-24: cursor
    // 1→2→end enumerates; `page` repeats page 0). The cap is a runaway guard, and
    // hitting it FAILS LOUD — restoring a silently partial root would be a lie.
    const maxPages = options.maxPages ?? 50;
    const items: GuangYaItem[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const body: Record<string, unknown> = { pageSize, accessToken, orderBy: 0, sortType: 0, parentId };
      if (cursor !== undefined) body.cursor = cursor;
      const data = await this.postAPI("/userres/v1/get_share_page_files_list", body, false, undefined, "read");
      const list = arrayValue(recordValue(data, "list")).filter(isRecord);
      for (const raw of list) items.push(toItem(raw));
      const next = numberValue(recordValue(data, "cursor"));
      // The CURSOR drives pagination. Stop only on a definite end: an empty page, no /
      // repeated cursor, or an explicit hasMore:false. `total` is NOT trusted as a stop
      // — the real probes could not tell a directory total from a page count, and
      // stopping on a page count would restore a partial root. (Real walk 2026-09-24:
      // cursor 1 → 2 → {cursor:2} empty.)
      if (list.length === 0 || next <= 0 || next === cursor || recordValue(data, "hasMore") === false) return items;
      cursor = next;
    }
    throw new Error(`GUANGYA_SHARE_TOO_LARGE: 分享目录超过 ${maxPages} 页仍未列完,拒绝只转存一部分`);
  }

  /** Save share files into our `parentId`; returns the restore taskId. Folder ids are
   *  restored whole (a folder share landed its 92GB file in ~4s on the real drive). */
  async restoreShare(input: { accessToken: string; fileIds: string[]; parentId: string }): Promise<string> {
    const data = await this.postAPI("/userres/v1/restore_share", {
      accessToken: input.accessToken,
      fileIds: input.fileIds,
      parentId: input.parentId,
    });
    const taskId = stringValue(recordValue(data, "taskId"));
    if (!taskId) {
      throw new Error("GUANGYA_RESTORE_SHARE_FAILED: response missing data.taskId");
    }
    return taskId;
  }

  /** Status of a file task (restore/copy/move/delete): 1 = running, 2 = done. */
  async getTaskStatus(taskId: string): Promise<{ status: number }> {
    const data = await this.postAPI("/userres/v1/get_task_status", { taskId }, false, undefined, "read");
    return { status: numberValue(recordValue(data, "status")) };
  }

  /** Poll the status/progress of offline tasks. */
  async listTask(taskIds: string[]): Promise<GuangYaTaskStatus[]> {
    const data = await this.postAPI("/cloudcollection/v1/list_task", { taskIds }, false, undefined, "read");
    return arrayValue(recordValue(data, "list")).filter(isRecord).map(toTaskStatus);
  }

  /** Query total and used storage capacity (`POST /assets/v1/get_assets`). */
  async getSpace(): Promise<{ totalBytes: number; usedBytes: number } | null> {
    const data = await this.postAPI("/assets/v1/get_assets", {}, false, undefined, "read");
    const totalBytes = parseFiniteMetric(recordValue(data, "totalSpaceSize"));
    const usedBytes = parseFiniteMetric(recordValue(data, "usedSpaceSize"));
    if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes) || totalBytes <= 0) {
      return null;
    }
    return { totalBytes, usedBytes };
  }

  /**
   * POST to the api host with Bearer + Did + Dt:4. On 401 or HTTP 200 with
   * business auth code 110/117/118 (once) refresh and retry. Success =
   * `msg===""||msg==="success"`; otherwise throw (GuangYaAuthError on auth
   * failure, plain Error otherwise) carrying the server msg.
   */
  private async postAPI(
    path: string,
    body: unknown,
    retried = false,
    envelope?: { top?: unknown },
    priority: GuangYaRequestPriority = this.requestPriority,
  ): Promise<unknown> {
    let requestSnapshot: GuangYaCredentialSnapshot | undefined;
    const response = await this.fetchScheduled(`${API_HOST}${path}`, () => ({
      method: "POST",
      headers: this.apiHeaders(() => { requestSnapshot = this.activeAuthSnapshot; }),
      body: JSON.stringify(body),
    }), priority, GUANGYA_WRITE_PATHS.has(path));
    const json = (await response.json().catch(() => ({}))) as unknown;
    if (envelope) envelope.top = json;
    const numericCode = parseEnvelopeCode(recordValue(json, "code"));
    const authExpired =
      response.status === 401 ||
      (response.ok && numericCode !== null && GUANGYA_AUTH_EXPIRED_CODES.has(numericCode));
    if (authExpired) {
      if (retried) {
        const error = new GuangYaAuthError(
          `GUANGYA_AUTH_FAILED: ${response.status === 401 ? "401" : `code=${numericCode}`} after refresh (${path})`,
        );
        bindAuthFailureSnapshot(error, requestSnapshot);
        throw error;
      }
      await this.refreshTokens();
      return this.postAPI(path, body, true, envelope, priority);
    }
    const msg = stringValue(recordValue(json, "msg"));
    if (response.ok && (numericCode === null || numericCode === 0) && (msg === "" || msg.toLowerCase() === "success")) {
      return recordValue(json, "data");
    }
    const codeSuffix = numericCode !== null && numericCode !== 0 ? ` code=${numericCode}` : "";
    throw new Error(`GUANGYA_API_FAILED: ${path} status=${response.status}${codeSuffix} msg=${msg}`);
  }

  /**
   * Exchange the refresh_token for a fresh access (and possibly refresh) token.
   * Updates in-memory tokens and notifies onTokensRefreshed. Throws
   * GuangYaAuthError on failure (refresh token dead).
   */
  private async refreshTokens(): Promise<void> {
    if (this.authCoordinator && this.authAccountKey && this.loadCurrentCredentials) {
      await this.authCoordinator.runExclusive(this.authAccountKey, async () => {
        const current = await this.requireCurrentCredentials();
        const beforeRefresh = this.currentTokens();
        if (!sameTokens(current.tokens, beforeRefresh)) {
          this.activeAuthSnapshot = current.snapshot;
          this.installTokens(current.tokens);
          return;
        }

        let refreshed: GuangYaTokens;
        try {
          refreshed = await this.exchangeRefreshToken();
        } catch (error) {
          if (!(error instanceof GuangYaAuthError)) throw error;
          const afterFailure = await this.requireCurrentCredentials();
          if (!sameTokens(afterFailure.tokens, beforeRefresh)) {
            this.activeAuthSnapshot = afterFailure.snapshot;
            this.installTokens(afterFailure.tokens);
            return;
          }
          bindAuthFailureSnapshot(error, afterFailure.snapshot ?? current.snapshot);
          throw error;
        }

        this.installTokens(refreshed);
        if (!this.onTokensRefreshed) return;
        const persisted = await this.onTokensRefreshed(refreshed, current.snapshot);
        if (persisted !== false) {
          this.activeAuthSnapshot = current.snapshot ? {
            ...current.snapshot,
            credentials: { ...refreshed },
            ...(current.snapshot.expectedStatus === undefined ? {} : { expectedStatus: current.snapshot.expectedStatus }),
          } : undefined;
          return;
        }

        const afterCas = await this.requireCurrentCredentials();
        if (sameTokens(afterCas.tokens, beforeRefresh)) {
          throw new Error("GUANGYA_CREDENTIAL_PERSIST_CONFLICT");
        }
        this.activeAuthSnapshot = afterCas.snapshot;
        this.installTokens(afterCas.tokens);
      });
      return;
    }

    const refreshed = await this.exchangeRefreshToken();
    this.installTokens(refreshed);
    await this.onTokensRefreshed?.(refreshed);
  }

  private async exchangeRefreshToken(): Promise<GuangYaTokens> {
    const response = await this.fetchScheduled(`${AUTH_HOST}/v1/auth/token`, () => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: GUANGYA_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
      }),
    }), this.requestPriority);
    const json = (await response.json()) as unknown;
    const accessToken = stringValue(recordValue(json, "access_token"));
    if (!response.ok || !accessToken) {
      const error = stringValue(recordValue(json, "error"));
      const description = stringValue(recordValue(json, "error_description"));
      throw new GuangYaAuthError(
        `GUANGYA_REFRESH_FAILED: ${error || response.status} ${description}`.trim(),
      );
    }
    const nextAccessToken = accessToken.trim();
    const refreshToken = stringValue(recordValue(json, "refresh_token"));
    return {
      accessToken: nextAccessToken,
      refreshToken: refreshToken ? refreshToken.trim() : this.refreshToken,
      deviceId: this.deviceId,
    };
  }

  private async requireCurrentCredentials(): Promise<{ tokens: GuangYaTokens; snapshot?: GuangYaCredentialSnapshot }> {
    const current = await this.loadCurrentCredentials?.();
    if (!current) throw new GuangYaConnectionChangedError();
    if ("tokens" in current) {
      return {
        tokens: { accessToken: current.tokens.accessToken.trim(), refreshToken: current.tokens.refreshToken.trim(), deviceId: current.tokens.deviceId.trim() },
        snapshot: current.snapshot,
      };
    }
    return { tokens: { accessToken: current.accessToken.trim(), refreshToken: current.refreshToken.trim(), deviceId: current.deviceId.trim() } };
  }

  private currentTokens(): GuangYaTokens {
    return { accessToken: this.accessToken, refreshToken: this.refreshToken, deviceId: this.deviceId };
  }

  private installTokens(tokens: GuangYaTokens): void {
    this.accessToken = tokens.accessToken.trim();
    this.refreshToken = tokens.refreshToken.trim();
    this.deviceId = tokens.deviceId.trim();
  }

  private authHeaders(onSnapshot?: () => void): Record<string, string> {
    onSnapshot?.();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  private apiHeaders(onSnapshot?: () => void): Record<string, string> {
    onSnapshot?.();
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      Did: this.deviceId,
      Dt: "4",
    };
  }

  private fetchScheduled(url: string, init: () => RequestInit, priority: GuangYaRequestPriority, isWrite = false): Promise<Response> {
    const perform = async () => {
      if (isWrite) await this.beforeWrite?.();
      return this.fetchImpl(url, init());
    };
    return this.requestScheduler ? this.requestScheduler.schedule(perform, priority) : perform();
  }
}

/**
 * Generate a stable 光鸭 device id (32 hex chars) for the `Did` header. Call this
 * ONCE at connect time and persist the result so every worker run reuses the same
 * id — a fresh id each run looks like many devices to 光鸭's risk control. The
 * client's internal default (when no deviceId is supplied) calls this same helper.
 */
export function generateGuangYaDeviceId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

function toItem(raw: Record<string, unknown>): GuangYaItem {
  return {
    fileId: stringValue(raw.fileId),
    parentId: stringValue(raw.parentId),
    fileName: stringValue(raw.fileName),
    fileSize: numberValue(raw.fileSize),
    resType: numberValue(raw.resType),
  };
}

function toResolvedRes(data: unknown): GuangYaResolvedRes {
  const resolved: GuangYaResolvedRes = { resType: numberValue(recordValue(data, "resType")) };
  const url = recordValue(data, "url");
  if (typeof url === "string" && url.length > 0) {
    resolved.url = url;
  }
  const btRaw = recordValue(data, "btResInfo");
  if (isRecord(btRaw)) {
    const rawExcluded = arrayValue(recordValue(btRaw, "excludeIndices"))
      .map((v) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : Number.NaN))
      .filter((n) => Number.isSafeInteger(n) && n >= 0);
    resolved.btResInfo = {
      infoHash: stringValue(recordValue(btRaw, "infoHash")),
      fileName: stringValue(recordValue(btRaw, "fileName")),
      subfiles: arrayValue(recordValue(btRaw, "subfiles"))
        .filter(isRecord)
        .map((sub) => toSubfile(sub)),
      ...(rawExcluded.length > 0 ? { excludeIndices: [...new Set(rawExcluded)] } : {}),
    };
  }
  return resolved;
}

function parseEnvelopeCode(rawCode: unknown): number | null {
  if (typeof rawCode === "number" && Number.isFinite(rawCode)) {
    return rawCode;
  }
  if (typeof rawCode === "string" && /^\d+$/.test(rawCode)) {
    return Number(rawCode);
  }
  return null;
}

function parseLeafFileIndex(idx: unknown, isDir: boolean): number | null {
  if (isDir) {
    return null;
  }
  if (typeof idx === "number" && Number.isFinite(idx) && idx >= 0) {
    return idx;
  }
  // Per official guangyapan-drive skill (`src/cloud-collection.mjs:189`):
  // "protobuf JSON may omit uint32 zero values; the Web client also treats omission as index 0."
  if (idx === undefined || idx === null) {
    return 0;
  }
  return null;
}

function toSubfile(raw: Record<string, unknown>, depth = 1): GuangYaSubfile {
  const isDir = raw.isDir === true || raw.isDir === 1;
  const parsedIdx = parseLeafFileIndex(raw.fileIndex, isDir);
  const children =
    isDir && depth < 16
      ? arrayValue(raw.subfiles)
          .filter(isRecord)
          .map((child) => toSubfile(child, depth + 1))
      : undefined;
  return {
    fileName: stringValue(raw.fileName),
    fileIndex: parsedIdx,
    fileSize: numberValue(raw.fileSize),
    ...(isDir ? { isDir: true } : {}),
    ...(children && children.length > 0 ? { subfiles: children } : {}),
  };
}

function toTaskStatus(raw: Record<string, unknown>): GuangYaTaskStatus {
  return {
    taskId: stringValue(raw.taskId),
    status: numberValue(raw.status),
    progress: numberValue(raw.progress),
    fileId: stringValue(raw.fileId),
  };
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function sameTokens(left: GuangYaTokens, right: GuangYaTokens): boolean {
  return left.accessToken === right.accessToken && left.refreshToken === right.refreshToken && left.deviceId === right.deviceId;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
