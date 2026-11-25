import { describe, expect, it } from "vitest";
import { libraryStorageChoices } from "./page";

describe("library management provider selection", () => {
  it("exposes every registered drive with its brand root and keeps frozen history selectable", () => {
    const choices = libraryStorageChoices([
      { id: "drive-115", provider: "pan115", label: null, status: "active" },
      { id: "drive-quark", provider: "quark", label: "主盘", status: "frozen" },
      { id: "drive-uc", provider: "uc", label: null, status: "active" },
      { id: "drive-123", provider: "pan123", label: null, status: "active" },
      { id: "drive-tianyi", provider: "tianyi", label: null, status: "active" },
      { id: "drive-guangya", provider: "guangya", label: null, status: "active" },
      { id: "drive-unknown", provider: "unknown", label: null, status: "active" },
    ]);

    expect(choices).toEqual([
      { id: "drive-115", provider: "pan115", label: "115 网盘", status: "active", rootDirectoryId: "0" },
      { id: "drive-quark", provider: "quark", label: "夸克网盘（主盘）", status: "frozen", rootDirectoryId: "0" },
      { id: "drive-uc", provider: "uc", label: "UC网盘", status: "active", rootDirectoryId: "0" },
      { id: "drive-123", provider: "pan123", label: "123网盘", status: "active", rootDirectoryId: "0" },
      { id: "drive-tianyi", provider: "tianyi", label: "天翼云盘", status: "active", rootDirectoryId: "-11" },
      { id: "drive-guangya", provider: "guangya", label: "光鸭云盘", status: "active", rootDirectoryId: "" },
    ]);
  });
});
