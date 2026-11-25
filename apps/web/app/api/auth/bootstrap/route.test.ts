import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("../../../../lib/workflow-runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/workflow-runtime")>(
    "../../../../lib/workflow-runtime",
  );
  return {
    SESSION_COOKIE_NAME: "mt_session",
    isRemoteRequest: actual.isRemoteRequest,
    isCookieSecure: vi.fn(() => false),
    isMultiUserEnabled: vi.fn(() => true),
    hasLoginPassword: vi.fn(async () => false),
    getBootstrapState: vi.fn(async () => ({ needsClaim: true, hasExistingLibrary: false })),
    ensureEnvBootstrapOwner: vi.fn(async () => undefined),
    getPublicRegistrationState: vi.fn(async () => ({ allowed: false, lockedByEnv: false })),
    resolveSessionAccountId: vi.fn(async () => null),
  };
});

import { GET } from "./route";
import * as runtime from "../../../../lib/workflow-runtime";

const TUNNEL = { "cf-ray": "8f3-abc", "cf-connecting-ip": "203.0.113.7" };
const get = (headers: Record<string, string> = {}) =>
  GET(new NextRequest("http://localhost:3000/api/auth/bootstrap", { headers }));

const prevDisableWeb = process.env.MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP;

describe("GET /api/auth/bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP;
    vi.mocked(runtime.isMultiUserEnabled).mockReturnValue(true);
    vi.mocked(runtime.resolveSessionAccountId).mockResolvedValue(null);
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({
      needsClaim: true,
      hasExistingLibrary: false,
    });
    vi.mocked(runtime.getPublicRegistrationState).mockResolvedValue({
      allowed: false,
      lockedByEnv: false,
    });
  });

  afterEach(() => {
    if (prevDisableWeb === undefined) delete process.env.MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP;
    else process.env.MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP = prevDisableWeb;
  });

  it("returns account-auth bootstrap fields including allowRegistration, webBootstrapDisabled, and authenticated", async () => {
    const res = await get(TUNNEL);
    expect(runtime.ensureEnvBootstrapOwner).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({
      singleUser: false,
      needsClaim: true,
      hasExistingLibrary: false,
      remote: true,
      allowRegistration: false,
      webBootstrapDisabled: false,
      authenticated: false,
    });
  });

  it("reflects MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP=1 and open registration", async () => {
    process.env.MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP = "1";
    vi.mocked(runtime.getPublicRegistrationState).mockResolvedValueOnce({
      allowed: true,
      lockedByEnv: true,
    });
    const res = await get();
    expect(await res.json()).toMatchObject({
      singleUser: false,
      allowRegistration: true,
      webBootstrapDisabled: true,
      authenticated: false,
    });
  });

  it("reports authenticated=true for valid session cookie and clears invalid/expired cookie", async () => {
    vi.mocked(runtime.resolveSessionAccountId).mockResolvedValueOnce("acct_default");
    const validRes = await get({ cookie: "mt_session=valid.sig" });
    expect(await validRes.json()).toMatchObject({ authenticated: true });
    expect(validRes.cookies.get("mt_session")).toBeUndefined();

    vi.mocked(runtime.resolveSessionAccountId).mockResolvedValueOnce(null);
    const staleRes = await get({ cookie: "mt_session=stale.sig" });
    expect(await staleRes.json()).toMatchObject({ authenticated: false });
    const cleared = staleRes.cookies.get("mt_session");
    expect(cleared?.value).toBe("");
    expect(cleared?.maxAge).toBe(0);
  });

  it("tells the login page whether the visitor came through the tunnel in single-user opt-out mode", async () => {
    vi.mocked(runtime.isMultiUserEnabled).mockReturnValue(false);
    expect(await (await get(TUNNEL)).json()).toMatchObject({
      singleUser: true,
      passwordSet: false,
      remote: true,
      allowRegistration: false,
      webBootstrapDisabled: false,
      authenticated: false,
    });
    expect(await (await get()).json()).toMatchObject({
      singleUser: true,
      passwordSet: false,
      remote: false,
    });
  });
});
