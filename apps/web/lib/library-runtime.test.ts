import { describe, expect, it } from "vitest";
import { issueDirectorySelectionTicket, verifyDirectorySelectionTicket } from "./library-runtime";

describe("directory selection tickets", () => {
  const scope = { accountId: "account-a", connectedStorageId: "storage-a" };
  const input = {
    ...scope,
    directoryId: "deep-directory",
    parentId: "nested-parent",
    name: "Season 2",
    page: 17,
  };

  it("binds a deep paginated selection to account, storage, parent, name and page", () => {
    const token = issueDirectorySelectionTicket(input, 1_000);
    expect(verifyDirectorySelectionTicket(token, scope, 2_000)).toEqual({ ...input, expiresAt: 601_000 });
    expect(verifyDirectorySelectionTicket(token, { accountId: "account-b", connectedStorageId: "storage-a" }, 2_000)).toBeNull();
    expect(verifyDirectorySelectionTicket(token, { accountId: "account-a", connectedStorageId: "storage-b" }, 2_000)).toBeNull();
  });

  it("rejects expired, modified and malformed selections", () => {
    const token = issueDirectorySelectionTicket(input, 1_000);
    expect(verifyDirectorySelectionTicket(token, scope, 601_000)).toBeNull();
    const replacement = token.endsWith("A") ? "B" : "A";
    expect(replacement).not.toBe(token.at(-1));
    expect(verifyDirectorySelectionTicket(`${token.slice(0, -1)}${replacement}`, scope, 2_000)).toBeNull();
    expect(verifyDirectorySelectionTicket("not-a-ticket", scope, 2_000)).toBeNull();
  });

  it("rejects a non-canonical Base64URL signature alias with identical bytes", () => {
    const token = issueDirectorySelectionTicket(input, 1_000);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(token.at(-1)!);
    const alias = alphabet[(lastIndex & 0b111100) | 0b000001]!;
    const aliased = `${token.slice(0, -1)}${alias}`;
    expect(aliased).not.toBe(token);
    expect(Buffer.from(aliased.slice(aliased.lastIndexOf(".") + 1), "base64url"))
      .toEqual(Buffer.from(token.slice(token.lastIndexOf(".") + 1), "base64url"));
    expect(verifyDirectorySelectionTicket(aliased, scope, 2_000)).toBeNull();
  });
});
