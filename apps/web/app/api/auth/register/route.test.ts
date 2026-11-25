import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../lib/demo-mode", () => ({ isDemoMode: () => false }));
vi.mock("../../../../lib/workflow-runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/workflow-runtime")>(
    "../../../../lib/workflow-runtime",
  );
  return {
    isRemoteRequest: actual.isRemoteRequest,
    SESSION_COOKIE_NAME: "mt_session",
    isMultiUserEnabled: vi.fn(() => true),
    isCookieSecure: vi.fn(() => false),
    ensureEnvBootstrapOwner: vi.fn(async () => undefined),
    getBootstrapState: vi.fn(),
    isPublicRegistrationEnabled: vi.fn(async () => false),
    registerAccount: vi.fn(async () => ({ ok: true, accountId: "acct_default", signedCookie: "signed" })),
  };
});

import { POST } from "./route";
import * as runtime from "../../../../lib/workflow-runtime";

const TUNNEL = { "cf-ray": "8f3-abc", "cf-connecting-ip": "203.0.113.7" };

function post(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ username: "owner", password: "correct horse" }),
  });
}

const prevDisableWeb = process.env.MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP;

describe("POST /api/auth/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP;
    vi.mocked(runtime.isMultiUserEnabled).mockReturnValue(true);
    vi.mocked(runtime.isPublicRegistrationEnabled).mockResolvedValue(false);
  });

  afterEach(() => {
    if (prevDisableWeb === undefined) delete process.env.MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP;
    else process.env.MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP = prevDisableWeb;
  });

  it("allows first-time claim even from remote/public requests and auto-sets session cookie", async () => {
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: true, hasExistingLibrary: true });
    const res = await POST(post(TUNNEL));
    expect(res.status).toBe(200);
    expect(runtime.ensureEnvBootstrapOwner).toHaveBeenCalledOnce();
    expect(runtime.registerAccount).toHaveBeenCalled();
    expect(res.cookies.get("mt_session")?.value).toBe("signed");
  });

  it("rejects first-time web claim with 403 when MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP=1", async () => {
    process.env.MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP = "1";
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: true, hasExistingLibrary: false });
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect(runtime.registerAccount).not.toHaveBeenCalled();
  });

  it("rejects subsequent public registration with 403 by default once claimed", async () => {
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: false, hasExistingLibrary: true });
    vi.mocked(runtime.isPublicRegistrationEnabled).mockResolvedValue(false);
    const res = await POST(post(TUNNEL));
    expect(res.status).toBe(403);
    expect(runtime.registerAccount).not.toHaveBeenCalled();
  });

  it("allows registration once claimed if public registration is explicitly enabled", async () => {
    vi.mocked(runtime.getBootstrapState).mockResolvedValue({ needsClaim: false, hasExistingLibrary: true });
    vi.mocked(runtime.isPublicRegistrationEnabled).mockResolvedValue(true);
    const res = await POST(post(TUNNEL));
    expect(res.status).toBe(200);
    expect(runtime.registerAccount).toHaveBeenCalled();
  });
});
