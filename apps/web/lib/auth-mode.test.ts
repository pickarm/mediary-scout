import { describe, expect, it } from "vitest";
import {
  isAccountAuthEnabled,
  isWebBootstrapDisabled,
  resolveEnvBootstrapOwner,
  resolvePublicRegistrationState,
  resolveSafeNextPath,
  validateUsernameInput,
} from "./auth-mode";

describe("isAccountAuthEnabled", () => {
  it("enables account login by default when no opt-out flag is set", () => {
    expect(isAccountAuthEnabled({})).toBe(true);
    expect(isAccountAuthEnabled({ MEDIA_TRACK_MULTI_USER: "" })).toBe(true);
    expect(isAccountAuthEnabled({ MEDIA_TRACK_MULTI_USER: "1" })).toBe(true);
  });

  it("allows explicit opt-out via MEDIA_TRACK_MULTI_USER=0", () => {
    expect(isAccountAuthEnabled({ MEDIA_TRACK_MULTI_USER: "0" })).toBe(false);
  });

  it("keeps demo mode unauthenticated even if multi-user is set", () => {
    expect(isAccountAuthEnabled({ MEDIA_TRACK_DEMO_MODE: "1" })).toBe(false);
    expect(isAccountAuthEnabled({ MEDIA_TRACK_DEMO_MODE: "1", MEDIA_TRACK_MULTI_USER: "1" })).toBe(false);
  });

  it("keeps desktop mode single-user unless MEDIA_TRACK_MULTI_USER=1", () => {
    expect(isAccountAuthEnabled({ MEDIA_TRACK_DESKTOP: "1" })).toBe(false);
    expect(isAccountAuthEnabled({ MEDIA_TRACK_DESKTOP: "1", MEDIA_TRACK_MULTI_USER: "1" })).toBe(true);
  });
});

describe("isWebBootstrapDisabled", () => {
  it("returns true only when MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP=1", () => {
    expect(isWebBootstrapDisabled({})).toBe(false);
    expect(isWebBootstrapDisabled({ MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP: "0" })).toBe(false);
    expect(isWebBootstrapDisabled({ MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP: "1" })).toBe(true);
  });
});

describe("validateUsernameInput", () => {
  it("trims valid usernames and enforces length/control character boundaries", () => {
    expect(validateUsernameInput("  admin  ")).toEqual({ ok: true, username: "admin" });
    expect(validateUsernameInput("a").ok).toBe(false);
    expect(validateUsernameInput("x".repeat(65)).ok).toBe(false);
    expect(validateUsernameInput("admin\nline").ok).toBe(false);
  });
});

describe("resolveEnvBootstrapOwner", () => {
  it("returns none when both env vars are absent or blank", () => {
    expect(resolveEnvBootstrapOwner({})).toEqual({ status: "none" });
    expect(resolveEnvBootstrapOwner({ MEDIA_TRACK_ADMIN_USERNAME: "   ", MEDIA_TRACK_ADMIN_PASSWORD: "" })).toEqual({
      status: "none",
    });
  });

  it("returns invalid when only one variable is set or credentials violate constraints", () => {
    expect(resolveEnvBootstrapOwner({ MEDIA_TRACK_ADMIN_USERNAME: "owner" }).status).toBe("invalid");
    expect(resolveEnvBootstrapOwner({ MEDIA_TRACK_ADMIN_PASSWORD: "secret-password" }).status).toBe("invalid");
    expect(
      resolveEnvBootstrapOwner({ MEDIA_TRACK_ADMIN_USERNAME: "a", MEDIA_TRACK_ADMIN_PASSWORD: "secret-password" }).status,
    ).toBe("invalid");
    expect(
      resolveEnvBootstrapOwner({
        MEDIA_TRACK_ADMIN_USERNAME: "x".repeat(65),
        MEDIA_TRACK_ADMIN_PASSWORD: "secret-password",
      }).status,
    ).toBe("invalid");
    expect(
      resolveEnvBootstrapOwner({
        MEDIA_TRACK_ADMIN_USERNAME: "admin\r",
        MEDIA_TRACK_ADMIN_PASSWORD: "secret-password",
      }).status,
    ).toBe("invalid");
    expect(
      resolveEnvBootstrapOwner({ MEDIA_TRACK_ADMIN_USERNAME: "owner", MEDIA_TRACK_ADMIN_PASSWORD: "12345" }).status,
    ).toBe("invalid");
  });

  it("returns valid with trimmed username and un-trimmed password", () => {
    expect(
      resolveEnvBootstrapOwner({
        MEDIA_TRACK_ADMIN_USERNAME: "  pickarm  ",
        MEDIA_TRACK_ADMIN_PASSWORD: " secret ",
      }),
    ).toEqual({
      status: "valid",
      username: "pickarm",
      password: " secret ",
    });
  });
});

describe("resolvePublicRegistrationState", () => {
  it("defaults to closed and falls back to DB when env is unset", () => {
    expect(resolvePublicRegistrationState({ dbValue: null })).toEqual({ allowed: false, lockedByEnv: false });
    expect(resolvePublicRegistrationState({ dbValue: "0" })).toEqual({ allowed: false, lockedByEnv: false });
    expect(resolvePublicRegistrationState({ dbValue: "1" })).toEqual({ allowed: true, lockedByEnv: false });
  });

  it("lets explicit env override DB and marks state locked", () => {
    expect(resolvePublicRegistrationState({ envValue: "1", dbValue: "0" })).toEqual({
      allowed: true,
      lockedByEnv: true,
    });
    expect(resolvePublicRegistrationState({ envValue: "0", dbValue: "1" })).toEqual({
      allowed: false,
      lockedByEnv: true,
    });
  });
});

describe("resolveSafeNextPath", () => {
  it("keeps safe relative in-app paths", () => {
    expect(resolveSafeNextPath("/settings?tab=account#password")).toBe("/settings?tab=account#password");
    expect(resolveSafeNextPath("/w/cs_1?tab=library")).toBe("/w/cs_1?tab=library");
    expect(resolveSafeNextPath(" /notifications ")).toBe("/notifications");
  });

  it("falls back to / for unsafe, external, login, api, or empty paths", () => {
    expect(resolveSafeNextPath(null)).toBe("/");
    expect(resolveSafeNextPath(undefined)).toBe("/");
    expect(resolveSafeNextPath("")).toBe("/");
    expect(resolveSafeNextPath("https://evil.example/steal")).toBe("/");
    expect(resolveSafeNextPath("//evil.example")).toBe("/");
    expect(resolveSafeNextPath("/\\evil.example")).toBe("/");
    expect(resolveSafeNextPath("/foo\\bar")).toBe("/");
    expect(resolveSafeNextPath("/settings\r\nSet-Cookie: a=1")).toBe("/");
    expect(resolveSafeNextPath("/login")).toBe("/");
    expect(resolveSafeNextPath("/login?next=/settings")).toBe("/");
    expect(resolveSafeNextPath("/login#hash")).toBe("/");
    expect(resolveSafeNextPath("/./login")).toBe("/");
    expect(resolveSafeNextPath("/foo/../login")).toBe("/");
    expect(resolveSafeNextPath("/login/extra")).toBe("/");
    expect(resolveSafeNextPath("/api")).toBe("/");
    expect(resolveSafeNextPath("/foo/../api/auth")).toBe("/");
    expect(resolveSafeNextPath("/api/auth/logout")).toBe("/");
  });
});
