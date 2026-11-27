import { describe, expect, it } from "vitest";
import { libraryStorageChoices } from "./page";

describe("library management provider selection", () => {
  it("exposes every registered drive with its brand root, default movie/tv directories and keeps frozen history selectable", () => {
    const choices = libraryStorageChoices([
      { id: "drive-115", provider: "pan115", label: null, status: "active", moviesCid: "m-115", tvCid: "t-115" },
      { id: "drive-quark", provider: "quark", label: "主盘", status: "frozen", moviesCid: "m-qk", tvCid: "t-qk" },
      { id: "drive-uc", provider: "uc", label: null, status: "active" },
      { id: "drive-123", provider: "pan123", label: null, status: "active", moviesCid: "m-123", tvCid: "t-123" },
      { id: "drive-tianyi", provider: "tianyi", label: null, status: "active" },
      { id: "drive-guangya", provider: "guangya", label: null, status: "active", moviesCid: "m-gy", tvCid: "t-gy" },
      { id: "drive-unknown", provider: "unknown", label: null, status: "active" },
    ]);

    expect(choices).toEqual([
      {
        id: "drive-115",
        provider: "pan115",
        label: "115 网盘",
        status: "active",
        rootDirectoryId: "0",
        defaultMovieDirectory: { directoryId: "m-115", name: "Mediary Scout/Movies" },
        defaultTvDirectory: { directoryId: "t-115", name: "Mediary Scout/TV" },
      },
      {
        id: "drive-quark",
        provider: "quark",
        label: "夸克网盘（主盘）",
        status: "frozen",
        rootDirectoryId: "0",
        defaultMovieDirectory: { directoryId: "m-qk", name: "Mediary Scout/Movies" },
        defaultTvDirectory: { directoryId: "t-qk", name: "Mediary Scout/TV" },
      },
      {
        id: "drive-uc",
        provider: "uc",
        label: "UC网盘",
        status: "active",
        rootDirectoryId: "0",
        defaultMovieDirectory: null,
        defaultTvDirectory: null,
      },
      {
        id: "drive-123",
        provider: "pan123",
        label: "123网盘",
        status: "active",
        rootDirectoryId: "0",
        defaultMovieDirectory: { directoryId: "m-123", name: "Mediary Scout/Movies" },
        defaultTvDirectory: { directoryId: "t-123", name: "Mediary Scout/TV" },
      },
      {
        id: "drive-tianyi",
        provider: "tianyi",
        label: "天翼云盘",
        status: "active",
        rootDirectoryId: "-11",
        defaultMovieDirectory: null,
        defaultTvDirectory: null,
      },
      {
        id: "drive-guangya",
        provider: "guangya",
        label: "光鸭云盘",
        status: "active",
        rootDirectoryId: "",
        defaultMovieDirectory: { directoryId: "m-gy", name: "Mediary Scout/Movies" },
        defaultTvDirectory: { directoryId: "t-gy", name: "Mediary Scout/TV" },
      },
    ]);
  });
});
