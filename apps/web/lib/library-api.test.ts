import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = vi.hoisted(() => ({ requireAccount: vi.fn<() => Promise<string>>() }));
const demo = vi.hoisted(() => ({ enabled: false }));
vi.mock("./workflow-runtime", () => ({ requireAuthenticatedAccountId: auth.requireAccount }));
vi.mock("./demo-mode", () => ({ isDemoMode: () => demo.enabled }));

import { LibraryApiError, libraryAccount, readJson } from "./library-api";

function request(headers: Record<string, string> = {}, body = "{}"): NextRequest {
  return new NextRequest("https://library.example/api/library/scans", { method: "POST", headers, body });
}

function oversizedStreamRequest(headers: Record<string, string>) {
  const counts = { pulls: 0, cancelled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      counts.pulls += 1;
      controller.enqueue(new Uint8Array(5));
    },
    cancel() { counts.cancelled += 1; },
  });
  const streamed = new NextRequest("https://library.example/api/library/scans", {
    method: "POST", headers, body, duplex: "half",
  });
  return { streamed, counts };
}

describe("library API request guard", () => {
  beforeEach(() => {
    demo.enabled = false;
    auth.requireAccount.mockResolvedValue("current-account");
  });

  it("accepts the externally visible forwarded origin and returns the server account", async () => {
    await expect(libraryAccount(request({ origin: "https://library.example", host: "internal:3000", "x-forwarded-host": "library.example", "x-forwarded-proto": "https" }), true)).resolves.toBe("current-account");
  });

  it("rejects missing or mismatched origins, demo writes, and expired authentication", async () => {
    await expect(libraryAccount(request({ host: "library.example", "x-forwarded-proto": "https" }), true)).rejects.toMatchObject({ status: 403 });
    await expect(libraryAccount(request({ origin: "https://attacker.example", host: "library.example", "x-forwarded-proto": "https" }), true)).rejects.toMatchObject({ status: 403 });
    demo.enabled = true;
    await expect(libraryAccount(request({ origin: "https://library.example", host: "library.example", "x-forwarded-proto": "https" }), true)).rejects.toMatchObject({ status: 403 });
    demo.enabled = false;
    auth.requireAccount.mockRejectedValueOnce(new Error("no session"));
    await expect(libraryAccount(request(), false)).rejects.toMatchObject({ status: 401 });
  });

  it("bounds and parses JSON request bodies", async () => {
    await expect(readJson(request({}, "{\"value\":1}"))).resolves.toEqual({ value: 1 });
    await expect(readJson(request({}, "[]"))).rejects.toBeInstanceOf(LibraryApiError);
    await expect(readJson(request({}, "not json"))).rejects.toMatchObject({ status: 400 });
    await expect(readJson(request({}, JSON.stringify({ value: "x".repeat(100) })), 20)).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    ["missing content length", {}],
    ["dishonest short content length", { "content-length": "1" }],
  ])("cancels an oversized stream immediately with %s", async (_label, headers) => {
    const { streamed, counts } = oversizedStreamRequest(headers);
    await expect(readJson(streamed, 6)).rejects.toMatchObject({ status: 400 });
    expect(counts.cancelled).toBe(1);
    expect(counts.pulls).toBeLessThan(10);
  });
});
