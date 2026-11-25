import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { _resetLoginThrottleForTest } from "../../../../lib/login-throttle";

const CRYPTO_TIMEOUT_MS = 30_000;

const ENV_KEYS = [
  "MEDIA_TRACK_SQLITE_PATH",
  "MEDIA_TRACK_POSTGRES_URL",
  "MEDIA_TRACK_MULTI_USER",
  "MEDIA_TRACK_DEMO_MODE",
  "MEDIA_TRACK_COOKIE_SECURE",
  "MEDIA_TRACK_ADMIN_USERNAME",
  "MEDIA_TRACK_ADMIN_PASSWORD",
] as const;

const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

let activeRuntime: typeof import("../../../../lib/workflow-runtime") | null = null;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const prev = savedEnv.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

async function bootRoute() {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  delete process.env.MEDIA_TRACK_MULTI_USER;
  delete process.env.MEDIA_TRACK_DEMO_MODE;
  delete process.env.MEDIA_TRACK_COOKIE_SECURE;
  _resetLoginThrottleForTest();
  vi.resetModules();
  activeRuntime = await import("../../../../lib/workflow-runtime");
  const route = await import("./route");
  return { POST: route.POST, rt: activeRuntime };
}

function post(
  body: unknown,
  opts?: { url?: string; headers?: Record<string, string> },
): NextRequest {
  return new NextRequest(opts?.url ?? "http://198.51.100.10:3000/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts?.headers ?? {}) },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  if (activeRuntime) {
    await activeRuntime.closeWorkflowRepositoryForTests();
    activeRuntime = null;
  }
  vi.resetModules();
  restoreEnv();
});

describe("POST /api/auth/login", () => {
  it(
    "sets non-secure mt_session over plain HTTP and secure cookie behind HTTPS proxy",
    async () => {
      const { POST, rt } = await bootRoute();
      await rt.registerAccount("owner", "secret-123");

      const httpRes = await POST(post({ username: "owner", password: "secret-123" }));
      expect(httpRes.status).toBe(200);
      const httpCookie = httpRes.cookies.get(rt.SESSION_COOKIE_NAME);
      expect(httpCookie?.value).toBeTruthy();
      expect(httpCookie?.httpOnly).toBe(true);
      expect(httpCookie?.sameSite).toBe("lax");
      expect(httpCookie?.secure).toBe(false);

      const httpsRes = await POST(
        post(
          { username: "owner", password: "secret-123" },
          { headers: { "x-forwarded-proto": "https" } },
        ),
      );
      expect(httpsRes.status).toBe(200);
      expect(httpsRes.cookies.get(rt.SESSION_COOKIE_NAME)?.secure).toBe(true);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "returns 401 on bad password and enforces rate limiting after repeated failures",
    async () => {
      const { POST, rt } = await bootRoute();
      await rt.registerAccount("owner", "secret-123");

      for (let i = 0; i < 5; i++) {
        const res = await POST(
          post(
            { username: "owner", password: "wrong-password" },
            { headers: { "x-forwarded-for": "198.51.100.10" } },
          ),
        );
        expect(res.status).toBe(401);
        expect(res.cookies.get(rt.SESSION_COOKIE_NAME)).toBeUndefined();
      }

      const throttled = await POST(
        post(
          { username: "owner", password: "secret-123" },
          { headers: { "x-forwarded-for": "198.51.100.10" } },
        ),
      );
      expect(throttled.status).toBe(401);
      const payload = (await throttled.json()) as { error?: string };
      expect(payload.error).toContain("尝试过于频繁");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "allows immediate login using env-bootstrapped owner credentials without calling /bootstrap first",
    async () => {
      process.env.MEDIA_TRACK_ADMIN_USERNAME = "envadmin";
      process.env.MEDIA_TRACK_ADMIN_PASSWORD = "env-password-123";
      const { POST, rt } = await bootRoute();

      const res = await POST(post({ username: "envadmin", password: "env-password-123" }));
      expect(res.status).toBe(200);
      const sessionCookie = res.cookies.get(rt.SESSION_COOKIE_NAME);
      expect(sessionCookie?.value).toBeTruthy();
      expect(await rt.resolveSessionAccountId(sessionCookie!.value)).toBe("acct_default");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it("returns 403 in demo mode", async () => {
    const { POST } = await bootRoute();
    process.env.MEDIA_TRACK_DEMO_MODE = "1";
    const res = await POST(post({ username: "owner", password: "secret-123" }));
    expect(res.status).toBe(403);
  });
});
