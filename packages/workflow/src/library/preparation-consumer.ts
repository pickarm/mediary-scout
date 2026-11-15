import type { JevJudge, JevJudgeInput, JevJudgeResult } from "../jev-judge.js";
import type { ResourceSnapshot } from "../domain.js";
import type { ResourceProvider } from "../ports.js";
import type { PreparationDescriptor, PreparationResult } from "./preparation-store.js";

export interface PreparationResultReader {
  getReadyResult(descriptor: PreparationDescriptor): Promise<PreparationResult | null>;
}

/** One acquisition's shared bridge between its raw provider and original Jev filter.
 * The bridge only substitutes a raw title search and exact, complete advisory evidence;
 * the normal JevPrefilterProvider and RealResourceProviderV2 still do all enforcement. */
export function createPreparationConsumer(input: {
  descriptor?: PreparationDescriptor;
  loadDescriptor?: (workflowRunId: string) => Promise<PreparationDescriptor | null>;
  reader: PreparationResultReader;
  inner: ResourceProvider;
  judge?: JevJudge;
}): { resourceProvider: ResourceProvider; jevJudge?: JevJudge } {
  const preparedByRun = new Map<string, Promise<{ descriptor: PreparationDescriptor; result: PreparationResult | null } | null>>();
  const read = () => input.descriptor ? input.reader.getReadyResult(input.descriptor) : Promise.resolve(null);
  let matchedDescriptor: PreparationDescriptor | undefined;
  let matchedSnapshot: ResourceSnapshot | undefined;
  let matchedJev: PreparationResult["jev"] | undefined;

  const resourceProvider: ResourceProvider = {
    async search(search) {
      let descriptor: PreparationDescriptor | null = null;
      let ready: PreparationResult | null = null;
      if (search.workflowRunId && input.loadDescriptor) {
        let preparedRun = preparedByRun.get(search.workflowRunId);
        if (!preparedRun) {
          preparedRun = (async () => {
            const loadedDescriptor = await input.loadDescriptor!(search.workflowRunId!).catch(() => null);
            if (!loadedDescriptor) return null;
            const result = search.keyword === loadedDescriptor.title
              ? await input.reader.getReadyResult(loadedDescriptor).catch(() => null)
              : null;
            return { descriptor: loadedDescriptor, result };
          })();
          preparedByRun.set(search.workflowRunId, preparedRun);
        }
        try {
          const loaded = await preparedRun;
          if (loaded) { descriptor = loaded.descriptor; ready = loaded.result; }
        } finally {
          if (preparedByRun.get(search.workflowRunId) === preparedRun) preparedByRun.delete(search.workflowRunId);
        }
      } else if (input.descriptor && search.workflowRunId === input.descriptor.workflowRunId && search.keyword === input.descriptor.title) {
        descriptor = input.descriptor;
        ready = await read().catch(() => null);
      }
      if (descriptor && descriptor.workflowRunId === search.workflowRunId && search.keyword === descriptor.title) {
        const snapshot = ready?.snapshots.find((item) => item.keyword === descriptor.title);
        if (snapshot) {
          matchedDescriptor = descriptor;
          matchedSnapshot = snapshot;
          matchedJev = ready?.jev;
          return snapshot;
        }
      }
      matchedDescriptor = undefined;
      matchedSnapshot = undefined;
      matchedJev = undefined;
      return input.inner.search(search);
    },
  };

  if (!input.judge) return { resourceProvider };
  const jevJudge: JevJudge = {
    async judgeCandidates(judgeInput) {
      const prepared = matchedSnapshot && matchedJev;
      if (prepared && matchedDescriptor && prepared.target.tmdbId === matchedDescriptor.tmdbId
        && prepared.target.mediaType === matchedDescriptor.mediaType
        && sameTarget(judgeInput, prepared.target) && exactCandidateCoverage(judgeInput, matchedSnapshot!, prepared.result)) {
        return cloneJevResult(prepared.result);
      }
      return input.judge!.judgeCandidates(judgeInput);
    },
  };
  return { resourceProvider, jevJudge };
}

function sameTarget(input: JevJudgeInput, target: NonNullable<PreparationResult["jev"]>["target"]): boolean {
  const expectedKind = target.mediaType === "movie" ? "movie" : "tv";
  return input.target.kind === expectedKind
    && input.target.title === target.title
    && input.target.year === target.year
    && sameStrings(input.target.aliases, target.aliases);
}

function exactCandidateCoverage(input: JevJudgeInput, snapshot: ResourceSnapshot, result: JevJudgeResult): boolean {
  const candidates = snapshot.candidates.filter((candidate) => !isTitleless(candidate.title));
  const actual = new Map(candidates.map((candidate) => [candidate.id, candidate.title]));
  const scored = Object.keys(result.scores).filter((id) => actual.has(id));
  return actual.size === input.candidates.length
    && scored.length === input.candidates.length
    && input.candidates.every((candidate) => actual.get(candidate.id) === candidate.title && Object.hasOwn(result.scores, candidate.id))
    && scored.every((id) => actual.has(id));
}

function isTitleless(title: string): boolean {
  const value = title.trim();
  return value === "" || value.startsWith("📅") || /^https?:\/\//i.test(value);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function cloneJevResult(result: JevJudgeResult): JevJudgeResult {
  return {
    ...result,
    scores: { ...result.scores },
    ...(result.nsfw === undefined ? {} : { nsfw: { ...result.nsfw } }),
  };
}
