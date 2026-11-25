import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SELECTION_PREFERENCE_1080P,
  SELECTION_PREFERENCE_4K,
} from "@media-track/workflow";

const state = vi.hoisted(() => ({
  ownSettings: new Map<string, string>(),
  globalSettings: new Map<string, string>(),
  writes: [] as Array<{ key: string; value: string }>,
}));

vi.mock("../workflow-runtime", () => ({
  LLM_BASE_URL_SETTING_KEY: "llm_base_url",
  LLM_API_KEY_SETTING_KEY: "llm_api_key",
  LLM_MODEL_ID_SETTING_KEY: "llm_model_id",
  QUALITY_PREFERENCE_SETTING_KEY: "quality_preference",
  SELECTION_PREFERENCE_SETTING_KEY: "selection_preference",
  PREFERRED_LANGUAGE_SETTING_KEY: "preferred_language",
  DAILY_SWEEP_TIME_SETTING_KEY: "daily_sweep_time",
  PANSOU_BASE_URL_SETTING_KEY: "pansou_base_url",
  PANSOU_HEALTH_SETTING_KEY: "pansou_health",
  PROWLARR_BASE_URL_SETTING_KEY: "prowlarr_base_url",
  PROWLARR_API_KEY_SETTING_KEY: "prowlarr_api_key",
  TMDB_API_KEY_SETTING_KEY: "tmdb_api_key",
  getWorkflowRepository: () => ({
    setAccountSetting: async (_accountId: string, key: string, value: string) => {
      state.writes.push({ key, value });
      state.ownSettings.set(key, value);
    },
    setSetting: async (key: string, value: string) => {
      state.writes.push({ key, value });
      state.globalSettings.set(key, value);
    },
    listConnectedStorages: async () => [],
  }),
  getAccountScopedSettings: () => ({
    getSetting: async (key: string) => state.globalSettings.get(key) ?? null,
    getOwnSetting: async (key: string) => state.ownSettings.get(key) ?? null,
  }),
  readRawSelectionPreference: async (repository: {
    getSetting(key: string): Promise<string | null>;
    getOwnSetting?: (key: string) => Promise<string | null>;
  }) => {
    const own = repository.getOwnSetting
      ? await repository.getOwnSetting("selection_preference")
      : null;
    return own !== null ? own : repository.getSetting("selection_preference");
  },
  getLlmConfig: async () => ({
    baseURL: undefined,
    apiKey: undefined,
    modelId: undefined,
  }),
  getQualityPreference: async (repository: { getSetting(key: string): Promise<string | null> }) => {
    const value = (await repository.getSetting("quality_preference"))?.trim();
    return value === "high" || value === "medium" ? value : undefined;
  },
  getSelectionPreference: async () => undefined,
  getPreferredLanguage: async () => "中文",
  getDailySweepTime: async () => "03:00",
  getProwlarrConfig: async () => ({ baseURL: "", apiKey: undefined }),
}));

import {
  isMaskedPlaceholder,
  maskSecret,
  readAgentConfig,
  writeAgentConfig,
} from "./config-io";

beforeEach(() => {
  state.ownSettings.clear();
  state.globalSettings.clear();
  state.writes.length = 0;
});

describe("maskSecret", () => {
  it("masks a long secret keeping the last 4 chars", () => {
    expect(maskSecret("sk-abcdefghijklmnop")).toBe("***mnop");
  });

  it("fully masks a short secret", () => {
    expect(maskSecret("abc123")).toBe("***");
  });

  it("returns null for empty / whitespace / nullish", () => {
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret(undefined)).toBeNull();
    expect(maskSecret("")).toBeNull();
    expect(maskSecret("   ")).toBeNull();
  });
});

describe("isMaskedPlaceholder", () => {
  it("detects a masked value being echoed back", () => {
    expect(isMaskedPlaceholder("***mnop")).toBe(true);
    expect(isMaskedPlaceholder("sk-***7f2a")).toBe(true);
    expect(isMaskedPlaceholder("***")).toBe(true);
  });

  it("passes a genuine new secret", () => {
    expect(isMaskedPlaceholder("sk-realkey123456")).toBe(false);
    expect(isMaskedPlaceholder("https://api.example.com")).toBe(false);
  });
});

describe("writeAgentConfig selection preference compatibility", () => {
  it("normalizes selectionPreference and writes only the canonical setting", async () => {
    const result = await writeAgentConfig("acct_alice", {
      selectionPreference: "  优先 HDR10\r\n避开杜比视界  ",
    });

    expect(result).toEqual({ ok: true, updated: ["selectionPreference"] });
    expect(state.writes).toEqual([
      { key: "selection_preference", value: "优先 HDR10\n避开杜比视界" },
    ]);
  });

  it("maps legacy high and medium values onto the canonical presets", async () => {
    const high = await writeAgentConfig("acct_alice", { qualityPreference: "high" });
    expect(high).toEqual({ ok: true, updated: ["qualityPreference"] });
    expect(state.writes).toEqual([
      { key: "selection_preference", value: SELECTION_PREFERENCE_4K },
    ]);

    state.writes.length = 0;
    const medium = await writeAgentConfig("acct_alice", { qualityPreference: "medium" });
    expect(medium).toEqual({ ok: true, updated: ["qualityPreference"] });
    expect(state.writes).toEqual([
      { key: "selection_preference", value: SELECTION_PREFERENCE_1080P },
    ]);
  });

  it("clears the canonical setting for legacy any and empty values", async () => {
    expect(await writeAgentConfig("acct_alice", { qualityPreference: "any" })).toEqual({
      ok: true,
      updated: ["qualityPreference"],
    });
    expect(state.writes).toEqual([{ key: "selection_preference", value: "" }]);

    state.writes.length = 0;
    expect(await writeAgentConfig("acct_alice", { qualityPreference: "" })).toEqual({
      ok: true,
      updated: ["qualityPreference"],
    });
    expect(state.writes).toEqual([{ key: "selection_preference", value: "" }]);
  });

  it("lets a valid new value win over a valid legacy value", async () => {
    const result = await writeAgentConfig("acct_alice", {
      selectionPreference: "优先 HDR10",
      qualityPreference: "medium",
    });

    expect(result).toEqual({ ok: true, updated: ["selectionPreference"] });
    expect(state.writes).toEqual([
      { key: "selection_preference", value: "优先 HDR10" },
    ]);
  });

  it.each([
    ["selectionPreference", null],
    ["selectionPreference", "优".repeat(501)],
    ["qualityPreference", null],
    ["qualityPreference", "4K"],
    ["qualityPreference", "ultra"],
  ] as const)("rejects invalid %s value %j before writing", async (field, value) => {
    const input =
      field === "selectionPreference"
        ? { selectionPreference: value, qualityPreference: "high" }
        : { selectionPreference: "优先 HDR10", qualityPreference: value };

    const result = await writeAgentConfig("acct_alice", input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe(field);
    }
    expect(state.writes).toEqual([]);
  });

  it("leaves the preference unchanged when neither field is supplied", async () => {
    expect(await writeAgentConfig("acct_alice", {})).toEqual({
      ok: true,
      updated: [],
    });
    expect(state.writes).toEqual([]);
  });
});

describe("readAgentConfig selection preference compatibility", () => {
  it("exposes the legacy tier only while no new value has been saved", async () => {
    state.globalSettings.set("quality_preference", "high");

    const config = await readAgentConfig("acct_alice");

    expect(config.qualityPreference).toBe("high");
    expect(config.selectionPreference).toBeUndefined();
  });

  it("keeps an account-owned empty value from falling back to global", async () => {
    state.ownSettings.set("selection_preference", "");
    state.globalSettings.set("selection_preference", "优先 HDR10");
    state.globalSettings.set("quality_preference", "medium");

    const config = await readAgentConfig("acct_alice");

    expect(config.selectionPreference).toBeUndefined();
    expect(config.qualityPreference).toBeUndefined();
  });

  it("uses the global new value when the account owns no value", async () => {
    state.globalSettings.set("selection_preference", "优先 HDR10");
    state.globalSettings.set("quality_preference", "medium");

    const config = await readAgentConfig("acct_alice");

    expect(config.selectionPreference).toBe("优先 HDR10");
    expect(config.qualityPreference).toBeUndefined();
  });

  it("reports the legacy tier only when the effective canonical preset matches it", async () => {
    state.ownSettings.set("selection_preference", SELECTION_PREFERENCE_4K);
    state.globalSettings.set("quality_preference", "medium");

    const config = await readAgentConfig("acct_alice");

    expect(config.selectionPreference).toBe(SELECTION_PREFERENCE_4K);
    expect(config.qualityPreference).toBe("high");
  });
});
