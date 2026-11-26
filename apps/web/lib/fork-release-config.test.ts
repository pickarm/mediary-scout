import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const composeText = read("docker-compose.fork.yml");
const compose = obj(parse(composeText));
const ci = obj(parse(read(".github/workflows/ci.yml")));
const releaseText = read(".github/workflows/fork-image.yml");
const release = obj(parse(releaseText));
const autobuildText = read(".github/workflows/docker-autobuild.yml");
const autobuild = obj(parse(autobuildText));
const desktopRelease = obj(parse(read(".github/workflows/release-desktop.yml")));
const dockerfile = read("Dockerfile");
const dockerignore = read(".dockerignore");

describe("docker-compose.fork.yml", () => {
  const services = obj(compose.services);
  const web = obj(services.web);

  it("is a single prebuilt application service with no build, source mount or Docker socket", () => {
    expect(Object.keys(services)).toEqual(["web"]);
    expect(web.build).toBeUndefined();
    expect(web.volumes).toBeUndefined();
    expect(composeText).not.toContain("docker.sock");
    expect(composeText).not.toMatch(/^\s*build:/m);
    expect(composeText).not.toContain("qicket/mediary-scout");
    expect(text(web.image)).toBe(
      "${MEDIA_TRACK_IMAGE:-ghcr.io/pickarm/mediary-scout}:${MEDIA_TRACK_IMAGE_TAG:-latest}",
    );
    expect(text(web.image)).toContain("ghcr.io/pickarm/mediary-scout");
    expect(web.platform).toBe("linux/amd64");
  });

  it("uses external PostgreSQL, Redis and PanSou, and marks the image distribution", () => {
    const environment = obj(web.environment);
    expect(text(environment.MEDIA_TRACK_POSTGRES_URL)).toContain("MEDIA_TRACK_POSTGRES_URL");
    expect(text(environment.REDIS_URL)).toContain("REDIS_URL");
    expect(text(environment.PANSOU_BASE_URL)).toContain("PANSOU_BASE_URL");
    expect(environment.MEDIA_TRACK_DISTRIBUTION).toBe("fork-image");
    expect(web.env_file).toBeDefined();
  });
});

describe("CI workflow", () => {
  const job = obj(obj(ci.jobs)["build-and-test"]);
  const env = obj(job.env);
  const steps = arr(job.steps).map(obj);
  const pgStep = steps.find((step) => step.name === "PostgreSQL integration suites (all locations)");
  const smokeJob = obj(obj(ci.jobs)["image-smoke"]);
  const smokeSteps = arr(smokeJob.steps).map(obj);
  const smokeRun = text(smokeSteps.find((step) => step.name === "Start with fake adapters and workers disabled")?.run);

  it("runs a real Redis service and requires the Redis integration suite", () => {
    expect(obj(obj(obj(ci.jobs)["build-and-test"]).services).redis).toBeDefined();
    expect(env.MEDIA_TRACK_TEST_REDIS_URL).toBe("redis://localhost:6379");
    expect(env.MEDIA_TRACK_CI_REQUIRE_REDIS).toBe("1");
    expect(steps.map((step) => text(step.run))).toContain("npm run typecheck:migration");
  });

  it("finds every PostgreSQL suite in the repository, not just the old workflow test folder", () => {
    expect(pgStep).toBeDefined();
    const run = text(pgStep?.run);
    expect(run).toContain("git ls-files '*.pg.test.ts'");
    expect(run).toContain("'*.postgres.test.ts'");
    expect(run).toContain("'*-postgres.test.ts'");
    expect(run).toContain("library-import.test.ts");
    expect(run).toContain("fork-migration.test.ts");
    expect(run).toContain("--no-file-parallelism");
  });

  it("isolates Non-PostgreSQL unit suites from Postgres/Redis env and serializes contract/schema init", () => {
    const unitStep = steps.find((step) => step.name === "Non-PostgreSQL unit suites");
    expect(unitStep).toBeDefined();
    const unitEnv = obj(unitStep?.env);
    expect(unitEnv.MEDIA_TRACK_POSTGRES_URL).toBe("");
    expect(unitEnv.MEDIA_TRACK_CI_REQUIRE_POSTGRES).toBe("");
    expect(text(unitStep?.run)).toContain("'**/*-postgres.test.ts'");
    expect(text(unitStep?.run)).toContain("'packages/workflow/src/library/library-import.test.ts'");

    const contractStep = steps.find((step) => text(step.run).includes("repository-contract-postgres.test.ts"));
    expect(contractStep).toBeDefined();
    expect(text(contractStep?.run)).toContain("--no-file-parallelism");
  });

  it("boots the image against an isolated database with fake adapters and no worker", () => {
    expect(smokeJob).toBeDefined();
    expect(smokeRun).toContain("MEDIA_TRACK_REHEARSAL=1");
    expect(smokeRun).toContain("MEDIA_TRACK_INPROCESS_WORKER=0");
    expect(smokeRun).toContain("MEDIA_TRACK_STORAGE_ADAPTER=fake");
    expect(smokeRun).toContain("MEDIA_TRACK_WORKFLOW_ADAPTER=fake");
    expect(smokeRun).toContain("/api/health");
  });
});

describe("Fork image release workflow", () => {
  const publish = obj(obj(release.jobs).publish);
  const steps = arr(publish.steps).map(obj);
  const stepNamed = (name: string) => steps.find((step) => step.name === name);
  const runOf = (name: string): string => text(stepNamed(name)?.run);
  const indexOf = (name: string): number => steps.findIndex((step) => step.name === name);
  const buildRun = runOf("Build the linux/amd64 candidate locally");
  const bootRun = runOf("Boot the local candidate with fake adapters and workers disabled");
  const pushRun = runOf("Tag and push the verified image (version + sha + latest)");
  const verifyRun = runOf("Verify the three remote tags point at the same digest");
  const ghcrLoginStep = stepNamed("Log in to GitHub Container Registry (GHCR)");

  it("requires CI before publishing to GHCR only on v* tags, without Docker Hub coupling", () => {
    expect(publish.needs).toBe("verify");
    expect(publish.if).toBe("github.repository != 'fancydirty/mediary-scout'");
    expect(obj(release.on).push).toBeDefined();
    expect(obj(obj(release.on).push).tags).toEqual(["v*"]);
    expect(obj(release.permissions).contents).toBe("write");
    expect(obj(release.permissions).packages).toBe("write");
    expect(releaseText).not.toContain("DOCKERHUB_");
    expect(releaseText).not.toContain("qicket/mediary-scout");
    expect(obj(ghcrLoginStep?.with).registry).toBe("ghcr.io");
    expect(obj(ghcrLoginStep?.with).password).toBe("${{ secrets.GITHUB_TOKEN }}");
    // One global release lane: simultaneous tags would race over latest/digest.
    expect(obj(release.concurrency).group).toBe("fork-image-release");
    expect(obj(release.concurrency)["cancel-in-progress"]).toBe(false);
  });

  it("runs the read-only app-parser preflight before the first build", () => {
    expect(indexOf("Read-only release preflight")).toBeGreaterThan(-1);
    expect(indexOf("Read-only release preflight")).toBeLessThan(indexOf("Build the linux/amd64 candidate locally"));
    const preflight = runOf("Read-only release preflight");
    expect(preflight).toContain("release-preflight-cli.js");
    expect(preflight).toContain('"$GITHUB_REF_NAME"');
    expect(preflight).toContain('"$GITHUB_SHA"');
  });

  it("builds and loads linux/amd64 exactly once, without pushing", () => {
    expect(buildRun).toContain("--platform linux/amd64");
    expect(buildRun).toContain("--load");
    expect(buildRun).not.toContain("--push");
    expect(buildRun).toContain('"${CANDIDATE}:${GITHUB_SHA}"');
    expect(buildRun).toContain("linux/amd64");
    expect(buildRun).toContain("VERSION=\"${TAG}\"");
    expect(buildRun).toContain("GIT_SHA=\"${GITHUB_SHA}\"");
    expect((releaseText.match(/docker buildx build/g) ?? [])).toHaveLength(1);
  });

  it("boots the local candidate and checks /api/health, /login and unauthenticated redirect before pushing", () => {
    const bootIndex = indexOf("Boot the local candidate with fake adapters and workers disabled");
    const loginIndex = indexOf("Log in to GitHub Container Registry (GHCR)");
    const pushIndex = indexOf("Tag and push the verified image (version + sha + latest)");
    expect(bootIndex).toBeGreaterThan(indexOf("Build the linux/amd64 candidate locally"));
    expect(bootIndex).toBeLessThan(loginIndex);
    expect(loginIndex).toBeLessThan(pushIndex);

    expect(bootRun).toContain("/api/health");
    expect(bootRun).toContain("/login");
    expect(bootRun).toContain("ROOT_CODE");

    expect(pushRun).toContain('docker tag "${CANDIDATE}:${GITHUB_SHA}" "${IMAGE}:${TAG}"');
    expect(pushRun).toContain('docker tag "${CANDIDATE}:${GITHUB_SHA}" "${IMAGE}:sha-${GITHUB_SHA}"');
    expect(pushRun).toContain('docker tag "${CANDIDATE}:${GITHUB_SHA}" "${IMAGE}:latest"');
    expect(pushRun).toContain('docker push "${IMAGE}:${TAG}"');
    expect(pushRun).toContain('docker push "${IMAGE}:sha-${GITHUB_SHA}"');
    expect(pushRun).toContain('docker push "${IMAGE}:latest"');
    expect(pushRun).toContain('test "$(docker image inspect "${IMAGE}:latest" --format \'{{.Id}}\')" = "$CANDIDATE_ID"');
  });

  it("verifies all three remote digests match before releasing", () => {
    expect(verifyRun).toContain('test "$VERSION_DIGEST" = "$SHA_DIGEST"');
    expect(verifyRun).toContain('test "$SHA_DIGEST" = "$LATEST_DIGEST"');
    expect(verifyRun).toContain('echo "digest=${VERSION_DIGEST}" >> "$GITHUB_OUTPUT"');
    expect(verifyRun).not.toContain('grep -q "linux/amd64"');
    expect(indexOf("Tag and push the verified image (version + sha + latest)")).toBeLessThan(
      indexOf("Verify the three remote tags point at the same digest"),
    );
    expect(indexOf("Verify the three remote tags point at the same digest")).toBeLessThan(
      indexOf("Publish the Fork release"),
    );
  });

  it("creates the release only after the image exists on GHCR, with pull + recreate instructions", () => {
    const releaseRun = runOf("Publish the Fork release");
    expect(releaseRun).toContain("gh release create");
    expect(releaseRun).toContain('${IMAGE}:sha-${SHA}');
    expect(releaseRun).toContain("DIGEST");
    expect(releaseRun).toContain("docker compose -f docker-compose.fork.yml pull web");
    expect(releaseRun).toContain("docker compose -f docker-compose.fork.yml up -d --force-recreate web");
    expect(releaseRun).not.toContain("./scripts/deploy.sh");
  });
});

describe("Auto build Docker image workflow", () => {
  const on = obj(autobuild.on);
  const push = obj(on.push);
  const dispatch = obj(on.workflow_dispatch);
  const inputs = obj(dispatch.inputs);
  const buildJob = obj(obj(autobuild.jobs)["build-and-push"]);
  const steps = arr(buildJob.steps).map(obj);
  const stepNamed = (name: string) => steps.find((step) => step.name === name);
  const runOf = (name: string): string => text(stepNamed(name)?.run);
  const indexOf = (name: string): number => steps.findIndex((step) => step.name === name);
  const metaRun = runOf("Resolve image metadata and tags");
  const buildRun = runOf("Build the linux/amd64 image once locally");
  const smokeRun = runOf("Boot the local image with fake adapters and workers disabled");
  const ghcrPushRun = runOf("Push verified image to GHCR");
  const ghcrLoginStep = stepNamed("Log in to GitHub Container Registry (GHCR)");

  it("uses GHCR exclusively without Docker Hub or qicket references", () => {
    expect(autobuildText).not.toContain("DOCKERHUB_");
    expect(autobuildText).not.toContain("qicket/mediary-scout");
    expect(obj(autobuild.permissions).packages).toBe("write");
    expect(buildJob.if).toBe("github.repository != 'fancydirty/mediary-scout'");
    expect(obj(ghcrLoginStep?.with).registry).toBe("ghcr.io");
    expect(obj(ghcrLoginStep?.with).password).toBe("${{ secrets.GITHUB_TOKEN }}");
  });

  it("triggers on main/feature pushes and workflow_dispatch, syncing latest on main pushes", () => {
    expect(arr(push.branches)).toEqual(expect.arrayContaining(["main", "feature/pickarm-v1"]));
    expect(dispatch).toBeDefined();
    expect(obj(inputs.image_tag)).toBeDefined();
    expect(obj(inputs.push_latest).default).toBe(false);
    expect(metaRun).toContain('elif [ "$REF_NAME" = "main" ]; then');
    expect(metaRun).toContain('PRIMARY_TAG="edge"');
    expect(metaRun).toContain('if [ "$EVENT" = "push" ] || [ "$INPUT_PUSH_LATEST" = "true" ]; then');
    expect(metaRun).toContain('PUSH_LATEST="true"');
  });

  it("builds linux/amd64 once, smoke-tests /api/health, /login and / gate, then pushes same image ID to GHCR", () => {
    const buildIdx = indexOf("Build the linux/amd64 image once locally");
    const smokeIdx = indexOf("Boot the local image with fake adapters and workers disabled");
    const ghcrLoginIdx = indexOf("Log in to GitHub Container Registry (GHCR)");
    const ghcrPushIdx = indexOf("Push verified image to GHCR");

    expect(buildIdx).toBeGreaterThan(-1);
    expect(smokeIdx).toBeGreaterThan(buildIdx);
    expect(ghcrLoginIdx).toBeGreaterThan(smokeIdx);
    expect(ghcrPushIdx).toBeGreaterThan(ghcrLoginIdx);

    expect(buildRun).toContain("--platform linux/amd64");
    expect(buildRun).toContain("--load");
    expect(buildRun).not.toContain("--push");
    expect((autobuildText.match(/docker buildx build/g) ?? [])).toHaveLength(1);

    expect(smokeRun).toContain("MEDIA_TRACK_REHEARSAL=1");
    expect(smokeRun).toContain("MEDIA_TRACK_INPROCESS_WORKER=0");
    expect(smokeRun).toContain("/api/health");
    expect(smokeRun).toContain("/login");
    expect(smokeRun).toContain("ROOT_CODE");

    expect(ghcrPushRun).toContain('docker push "${GHCR_IMAGE}:${PRIMARY_TAG}"');
    expect(ghcrPushRun).toContain('docker push "${GHCR_IMAGE}:${SHA_TAG}"');
    expect(ghcrPushRun).toContain('docker push "${GHCR_IMAGE}:latest"');
    expect(ghcrPushRun).toContain('test "$(docker image inspect "${GHCR_IMAGE}:latest" --format \'{{.Id}}\')" = "$CANDIDATE_ID"');
  });
});

describe("upstream desktop release isolation", () => {
  it("keeps desktop preflight and release publishing on the upstream repository", () => {
    const jobs = obj(desktopRelease.jobs);
    expect(obj(jobs.preflight).if).toBe("github.repository == 'fancydirty/mediary-scout'");
    expect(obj(jobs.release).if).toBe("github.repository == 'fancydirty/mediary-scout'");
  });
});

describe("image build context", () => {
  it("keeps local worktrees, tools and env dumps out of Docker builds", () => {
    expect(dockerignore).toMatch(/^\.worktrees$/m);
    expect(dockerignore).toMatch(/^\.env\.\*$/m);
    expect(dockerignore).toMatch(/^references$/m);
    expect(dockerignore).toMatch(/^\.claude$/m);
  });

  it("stamps version and commit without forcing the release mode on source builds", () => {
    expect(dockerfile).toContain("BUILD_COMMIT");
    expect(dockerfile).toContain("BUILD_VERSION");
    // The default Fork compose selects the image mode; the original source-build
    // compose keeps its legacy local-source updater unless it opts in.
    expect(dockerfile).not.toContain("ENV MEDIA_TRACK_DISTRIBUTION=fork-image");
    expect(dockerfile).toContain("org.opencontainers.image.revision");
  });
});
