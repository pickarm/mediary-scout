import { beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(readonly target: string) {
    super(`NEXT_REDIRECT:${target}`);
  }
}

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("next/navigation", () => ({
  redirect: vi.fn((target: string) => {
    throw new RedirectSignal(target);
  }),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("../lib/demo-mode", () => ({
  isDemoMode: vi.fn(() => false),
}));

vi.mock("../lib/workflow-runtime", () => ({
  UNAUTHENTICATED_ACCOUNT_ID: "acct_unauthenticated",
  isMultiUserEnabled: vi.fn(() => true),
  hasLoginPassword: vi.fn(async () => true),
  getCurrentAccountId: vi.fn(async () => "acct_default"),
  getCurrentAccountSummary: vi.fn(async () => ({ username: "pickarm", isOwner: true })),
}));

import { redirect } from "next/navigation";
import { isDemoMode } from "../lib/demo-mode";
import * as runtime from "../lib/workflow-runtime";
import { AccountIdentityLoader } from "./account-identity-loader";

describe("AccountIdentityLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(runtime.isMultiUserEnabled).mockReturnValue(true);
    vi.mocked(runtime.hasLoginPassword).mockResolvedValue(true);
    vi.mocked(runtime.getCurrentAccountId).mockResolvedValue("acct_default");
    vi.mocked(runtime.getCurrentAccountSummary).mockResolvedValue({
      username: "pickarm",
      isOwner: true,
    });
    delete process.env.MEDIA_TRACK_DESKTOP;
  });

  it("redirects to /login when session resolved to UNAUTHENTICATED_ACCOUNT_ID or missing summary", async () => {
    vi.mocked(runtime.getCurrentAccountId).mockResolvedValueOnce(runtime.UNAUTHENTICATED_ACCOUNT_ID);
    await expect(AccountIdentityLoader()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirect).toHaveBeenCalledWith("/login");

    vi.mocked(runtime.getCurrentAccountSummary).mockResolvedValueOnce(null);
    await expect(AccountIdentityLoader()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(redirect).toHaveBeenCalledTimes(2);
  });

  it("renders AccountIdentity when authenticated", async () => {
    const el = await AccountIdentityLoader();
    expect(el).not.toBeNull();
    expect((el as { props: { username: string; isOwner: boolean } }).props).toEqual({
      username: "pickarm",
      isOwner: true,
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("returns null in demo mode or single-user mode when password is set, and redirects if single-user password is unset", async () => {
    vi.mocked(isDemoMode).mockReturnValueOnce(true);
    expect(await AccountIdentityLoader()).toBeNull();

    vi.mocked(runtime.isMultiUserEnabled).mockReturnValueOnce(false);
    vi.mocked(runtime.hasLoginPassword).mockResolvedValueOnce(true);
    expect(await AccountIdentityLoader()).toBeNull();
    expect(redirect).not.toHaveBeenCalled();

    vi.mocked(runtime.isMultiUserEnabled).mockReturnValueOnce(false);
    vi.mocked(runtime.hasLoginPassword).mockResolvedValueOnce(false);
    await expect(AccountIdentityLoader()).rejects.toThrow("NEXT_REDIRECT:/login");

    process.env.MEDIA_TRACK_DESKTOP = "1";
    vi.mocked(runtime.isMultiUserEnabled).mockReturnValueOnce(false);
    expect(await AccountIdentityLoader()).toBeNull();
    delete process.env.MEDIA_TRACK_DESKTOP;
  });
});
