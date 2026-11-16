import { describe, expect, it } from "vitest";
import {
  FORK_COMPOSE_FILE,
  FORK_IMAGE,
  FORK_IMAGE_DISTRIBUTION,
  FORK_REPO,
  FORK_REPO_URL,
  imageUpdateCommand,
  isForkImageDistribution,
  releaseImage,
} from "./fork-release";

describe("Fork release identity", () => {
  it("points at the Fork repository and the qicket image", () => {
    expect(FORK_REPO).toBe("pickarm/mediary-scout");
    expect(FORK_REPO_URL).toBe("https://github.com/pickarm/mediary-scout");
    expect(FORK_IMAGE).toBe("qicket/mediary-scout");
    expect(FORK_IMAGE_DISTRIBUTION).toBe("fork-image");
    expect(releaseImage("v2026.11.16")).toBe("qicket/mediary-scout:v2026.11.16");
  });

  it("is the image path only when the deployment explicitly says so", () => {
    expect(isForkImageDistribution(undefined)).toBe(false);
    expect(isForkImageDistribution("local-source")).toBe(false);
    expect(isForkImageDistribution(" fork-image ")).toBe(true);
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
