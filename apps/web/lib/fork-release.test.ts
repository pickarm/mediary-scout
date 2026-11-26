import { describe, expect, it } from "vitest";
import {
  FORK_COMPOSE_FILE,
  FORK_DEFAULT_IMAGE_TAG,
  FORK_IMAGE,
  FORK_IMAGE_DISTRIBUTION,
  FORK_REPO,
  FORK_REPO_URL,
  LOCAL_SOURCE_DISTRIBUTION,
  imageUpdateCommand,
  isForkImageDistribution,
  parseImageReference,
  releaseImage,
  resolveTrackedImageRef,
  resolveUpdateDistribution,
} from "./fork-release";

describe("Fork release identity", () => {
  it("points at the Fork repository and the GHCR image", () => {
    expect(FORK_REPO).toBe("pickarm/mediary-scout");
    expect(FORK_REPO_URL).toBe("https://github.com/pickarm/mediary-scout");
    expect(FORK_IMAGE).toBe("ghcr.io/pickarm/mediary-scout");
    expect(FORK_DEFAULT_IMAGE_TAG).toBe("latest");
    expect(FORK_IMAGE_DISTRIBUTION).toBe("fork-image");
    expect(LOCAL_SOURCE_DISTRIBUTION).toBe("local-source");
    expect(releaseImage("v2026.11.16")).toBe("ghcr.io/pickarm/mediary-scout:v2026.11.16");
  });

  it("defaults to fork-image and falls back to local-source only when explicitly configured", () => {
    expect(resolveUpdateDistribution({})).toBe("fork-image");
    expect(resolveUpdateDistribution({ MEDIA_TRACK_DISTRIBUTION: "" })).toBe("fork-image");
    expect(resolveUpdateDistribution({ MEDIA_TRACK_DISTRIBUTION: "fork-image" })).toBe("fork-image");
    expect(resolveUpdateDistribution({ MEDIA_TRACK_DISTRIBUTION: " local-source " })).toBe("local-source");

    expect(isForkImageDistribution(undefined)).toBe(true);
    expect(isForkImageDistribution(" fork-image ")).toBe(true);
    expect(isForkImageDistribution("local-source")).toBe(false);
    expect(isForkImageDistribution(" local-source ")).toBe(false);
  });

  it("resolves tracked image references including defaults, embedded tags, host:port and GHCR mirrors", () => {
    expect(resolveTrackedImageRef({})).toEqual({
      ok: true,
      registry: "ghcr.io",
      repository: "pickarm/mediary-scout",
      tag: "latest",
      fullRef: "ghcr.io/pickarm/mediary-scout:latest",
    });

    expect(resolveTrackedImageRef({ MEDIA_TRACK_IMAGE_TAG: "edge" })).toEqual({
      ok: true,
      registry: "ghcr.io",
      repository: "pickarm/mediary-scout",
      tag: "edge",
      fullRef: "ghcr.io/pickarm/mediary-scout:edge",
    });

    expect(
      resolveTrackedImageRef({
        MEDIA_TRACK_IMAGE: "GHCR.IO/PickArm/Mediary-Scout:edge",
        MEDIA_TRACK_IMAGE_TAG: "latest",
      }),
    ).toEqual({
      ok: true,
      registry: "ghcr.io",
      repository: "pickarm/mediary-scout",
      tag: "edge",
      fullRef: "ghcr.io/pickarm/mediary-scout:edge",
    });

    expect(
      resolveTrackedImageRef({
        MEDIA_TRACK_IMAGE: "ghcr.nju.edu.cn/pickarm/mediary-scout",
      }),
    ).toEqual({
      ok: true,
      registry: "ghcr.nju.edu.cn",
      repository: "pickarm/mediary-scout",
      tag: "latest",
      fullRef: "ghcr.nju.edu.cn/pickarm/mediary-scout:latest",
    });

    expect(parseImageReference("localhost:5000/pickarm/mediary-scout:v1.0.0")).toEqual({
      ok: true,
      registry: "localhost:5000",
      repository: "pickarm/mediary-scout",
      tag: "v1.0.0",
      fullRef: "localhost:5000/pickarm/mediary-scout:v1.0.0",
    });

    expect(parseImageReference("192.168.1.20:5000/mediary-scout", "edge")).toEqual({
      ok: true,
      registry: "192.168.1.20:5000",
      repository: "mediary-scout",
      tag: "edge",
      fullRef: "192.168.1.20:5000/mediary-scout:edge",
    });
  });

  it("rejects malformed or unsafe image references without throwing", () => {
    for (const [image, tag] of [
      ["ghcr.io/../evil", "latest"],
      ["https://ghcr.io/pickarm/mediary-scout", "latest"],
      ["ghcr.io/pickarm/mediary-scout@sha256:abc", "latest"],
      ["ghcr.io/pickarm/mediary-scout:", "latest"],
      ["ghcr.io/pickarm/mediary-scout", "bad tag"],
      ["ghcr.io/pickarm/mediary\nscout", "latest"],
      ["no-slash", "latest"],
      ["ghcr.io:99999/pickarm/mediary-scout", "latest"],
    ] as const) {
      expect(parseImageReference(image, tag)).toMatchObject({ ok: false, reason: "invalid_ref" });
    }
  });

  it("gives NAS users pull + recreate commands, never a source build", () => {
    const command = imageUpdateCommand();
    expect(command).toBe(
      "docker compose -f docker-compose.fork.yml pull web && docker compose -f docker-compose.fork.yml up -d --force-recreate web",
    );
    expect(command).not.toContain("build");
    expect(command).not.toContain("git pull");
    expect(command).not.toContain("./scripts/deploy.sh");
    expect(imageUpdateCommand(FORK_COMPOSE_FILE)).toBe(command);
  });
});
