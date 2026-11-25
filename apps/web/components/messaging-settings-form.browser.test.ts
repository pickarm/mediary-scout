import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import type { MessagingConnectionInput, MessagingConnectionView } from "../lib/messaging/config";
import type { MessagingPlatform } from "../lib/messaging/types";

type ActionCall =
  | { type: "save"; input: MessagingConnectionInput }
  | { type: "unlink"; platform: MessagingPlatform }
  | { type: "begin" }
  | { type: "poll"; input: { qrcode: string; pin?: string }; finishedAt: number };

type ActionMockState = {
  saveResult?: { success: boolean; message?: string; connection?: MessagingConnectionView };
  unlinkResult?: { success: boolean; message?: string; connection?: MessagingConnectionView };
  pollStates: Array<"wait" | "scanned" | "confirmed" | "expired" | "verify_required" | "error">;
  pollDelayMs: number;
};

declare global {
  interface Window {
    __F25_INITIAL__: MessagingConnectionView[];
    __F25_CALLS__: ActionCall[];
    __F25_MOCK__: ActionMockState;
    __F25_POLL_ACTIVE__: number;
    __F25_POLL_MAX_ACTIVE__: number;
    __F25_READY__: boolean;
  }
}

const browserTestsEnabled = process.env.RUN_MESSAGING_BROWSER === "1";
const browserDescribe = browserTestsEnabled ? describe : describe.skip;
const componentPath = path.resolve(process.cwd(), "apps/web/components/messaging-settings-form.tsx").replaceAll("\\", "/");
const NAVIGATION_TIMEOUT_MS = 10_000;
const HARNESS_READY_TIMEOUT_MS = 10_000;

function f25Plugin(): Plugin {
  const actionsId = "\0f25-actions";
  const harnessId = "\0f25-harness";
  const imageId = "\0f25-next-image";
  return {
    name: "f25-browser-harness",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "../lib/messaging/actions" && importer?.replaceAll("\\", "/").endsWith("/messaging-settings-form.tsx")) {
        return actionsId;
      }
      if (source === "next/image" && importer?.replaceAll("\\", "/").endsWith("/messaging-settings-form.tsx")) {
        return imageId;
      }
      if (source === "/__f25__/app.tsx") return harnessId;
      return null;
    },
    load(id) {
      if (id === imageId) {
        return `
          import React from "react";
          export default function MockImage(props) {
            const { unoptimized: _unoptimized, ...rest } = props;
            return React.createElement("img", rest);
          }
        `;
      }
      if (id === actionsId) {
        return `
          function connectionFrom(input) {
            const botId = input.platform === "telegram"
              ? (input.credentials.token || "").split(":")[0]
              : input.platform === "feishu"
                ? (input.credentials.appId || "")
                : "weixin-bot";
            return {
              id: "connection-" + input.platform,
              accountId: "account-1",
              platform: input.platform,
              botId,
              enabled: input.enabled,
              senderId: input.senderId,
              defaultStorageId: input.defaultStorageId,
              credentialSet: Object.fromEntries(Object.entries(input.credentials).map(([key, value]) => [key, Boolean(value)])),
            };
          }
          export async function saveMessagingConnectionAction(input) {
            window.__F25_CALLS__.push({ type: "save", input });
            if (window.__F25_MOCK__.saveResult === "throw") throw new Error("database detail");
            return window.__F25_MOCK__.saveResult ?? { success: true, connection: connectionFrom(input) };
          }
          export async function unlinkMessagingConnectionAction(platform) {
            window.__F25_CALLS__.push({ type: "unlink", platform });
            if (window.__F25_MOCK__.unlinkResult === "throw") throw new Error("database detail");
            return window.__F25_MOCK__.unlinkResult ?? { success: true };
          }
          export async function beginWeixinLoginAction() {
            window.__F25_CALLS__.push({ type: "begin" });
            return { success: true, qrcode: "f25-qrcode", qrcodeUrl: "data:image/png;base64,AAAA" };
          }
          export async function pollWeixinLoginAction(input) {
            window.__F25_POLL_ACTIVE__ += 1;
            window.__F25_POLL_MAX_ACTIVE__ = Math.max(window.__F25_POLL_MAX_ACTIVE__, window.__F25_POLL_ACTIVE__);
            await new Promise((resolve) => setTimeout(resolve, window.__F25_MOCK__.pollDelayMs));
            const state = window.__F25_MOCK__.pollStates.shift() || "wait";
            window.__F25_POLL_ACTIVE__ -= 1;
            window.__F25_CALLS__.push({ type: "poll", input, finishedAt: Date.now() });
            return {
              success: state !== "error",
              state,
              ...(state === "confirmed" ? { connection: {
                id: "connection-weixin",
                accountId: "account-1",
                platform: "weixin",
                botId: "weixin-bot",
                enabled: false,
                senderId: "owner-1",
                defaultStorageId: null,
                credentialSet: { token: true },
              } } : {}),
            };
          }
        `;
      }
      if (id === harnessId) {
        return `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { MessagingSettingsForm } from ${JSON.stringify(componentPath)};
          const root = createRoot(document.getElementById("root"));
          root.render(React.createElement(MessagingSettingsForm, {
            initial: window.__F25_INITIAL__,
            storages: [
              { id: "storage-a", label: "主光鸭云盘" },
              { id: "storage-b", label: "备用光鸭云盘" },
            ],
          }));
          requestAnimationFrame(() => { window.__F25_READY__ = true; });
        `;
      }
      return null;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/__f25__/") {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(`<!doctype html>
          <html lang="zh-CN">
            <body>
              <div id="root"></div>
              <script>
                window.__F25_INITIAL__ ||= [];
                window.__F25_CALLS__ ||= [];
                window.__F25_POLL_ACTIVE__ ||= 0;
                window.__F25_POLL_MAX_ACTIVE__ ||= 0;
                window.__F25_READY__ = false;
                window.__F25_MOCK__ ||= { pollStates: [], pollDelayMs: 20 };
              </script>
              <script type="module" src="/__f25__/app.tsx"></script>
            </body>
          </html>`);
      });
    },
  };
}

browserDescribe("MessagingSettingsForm browser behavior", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let context: BrowserContext;
  let baseUrl = "";
  let cacheDir = "";

  beforeAll(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "xunying-f25-vite-cold-"));
    server = await createServer({
      root: process.cwd(),
      configFile: false,
      appType: "custom",
      cacheDir,
      oxc: { jsx: { runtime: "automatic", importSource: "react" } },
      optimizeDeps: {
        include: [
          "lucide-react",
          "react",
          "react-dom",
          "react-dom/client",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
        ],
      },
      plugins: [f25Plugin()],
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite test server did not expose a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    await server.warmupRequest("/__f25__/app.tsx");
    browser = await chromium.launch({
      executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
    });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await server?.close();
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  });

  async function openHarness(
    initial: MessagingConnectionView[],
    mock: Partial<ActionMockState> = {},
  ): Promise<Page> {
    const page = await context.newPage();
    await page.addInitScript(({ connections, state }) => {
      window.__F25_INITIAL__ = connections;
      window.__F25_MOCK__ = { pollStates: [], pollDelayMs: 20, ...state };
    }, { connections: initial, state: mock });
    await page.goto(`${baseUrl}/__f25__/`, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => window.__F25_READY__ === true,
      undefined,
      { timeout: HARNESS_READY_TIMEOUT_MS },
    );
    await page.locator("section.panel").nth(2).waitFor({
      state: "visible",
      timeout: HARNESS_READY_TIMEOUT_MS,
    });
    return page;
  }

  it("submits edited values, preserves a blank secret, and shows server errors", async () => {
    const initial: MessagingConnectionView[] = [{
      id: "connection-feishu",
      accountId: "account-1",
      platform: "feishu",
      botId: "cli_feishu_app",
      enabled: false,
      senderId: "",
      defaultStorageId: null,
      credentialSet: { appId: true, appSecret: true },
    }];
    const page = await openHarness(initial);

    const panel = page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "飞书机器人" }) });
    const appSecret = panel.getByLabel("飞书 App Secret");
    expect(await appSecret.inputValue()).toBe("");
    expect(await panel.getByText("已配置 App Secret").isVisible()).toBe(true);
    await panel.getByLabel("启用此机器人").check();
    await panel.getByLabel("本人平台 ID").fill("ou_owner");
    await panel.getByLabel("默认网盘").selectOption("storage-b");
    await panel.getByRole("button", { name: "保存设置" }).click();
    await panel.getByText("飞书机器人设置已保存").waitFor();

    const calls = await page.evaluate(() => window.__F25_CALLS__);
    const saveCall = calls.find((call): call is Extract<ActionCall, { type: "save" }> => call.type === "save");
    expect(saveCall?.input).toEqual({
      platform: "feishu",
      enabled: true,
      senderId: "ou_owner",
      defaultStorageId: "storage-b",
      credentials: { appId: "cli_feishu_app" },
    });

    await page.evaluate(() => {
      window.__F25_MOCK__.saveResult = { success: false, message: "该机器人已配置到其他账号" };
    });
    await panel.getByRole("button", { name: "保存设置" }).click();
    await panel.getByRole("alert").filter({ hasText: "该机器人已配置到其他账号" }).waitFor();

    await page.evaluate(() => {
      window.__F25_MOCK__.unlinkResult = { success: false, message: "解绑失败，请稍后重试" };
    });
    await panel.getByRole("button", { name: "解绑机器人" }).click();
    await panel.getByRole("alert").filter({ hasText: "解绑失败，请稍后重试" }).waitFor();
  }, 20_000);

  it("polls Weixin one request at a time and stops after disable", async () => {
    const page = await openHarness([], {
      pollStates: ["wait", "scanned", "confirmed"],
      pollDelayMs: 20,
    });

    const panel = page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "微信机器人" }) });
    await panel.getByRole("button", { name: "扫码登录" }).click();
    await panel.getByText("微信机器人已扫码登录").waitFor({ timeout: 12_000 });
    expect(await panel.locator('img[alt="微信机器人登录二维码"]').count()).toBe(0);
    const enabled = panel.getByLabel("启用此机器人");
    expect(await enabled.isChecked()).toBe(false);
    expect(await page.evaluate(() => window.__F25_POLL_MAX_ACTIVE__)).toBe(1);
    const confirmedCalls = await page.evaluate(() => window.__F25_CALLS__);
    expect(confirmedCalls.filter((call) => call.type === "poll")).toHaveLength(3);

    await enabled.check();
    await panel.getByRole("button", { name: "保存设置" }).click();
    await panel.getByText("微信机器人设置已保存").waitFor();
    const savedCalls = await page.evaluate(() => window.__F25_CALLS__);
    const saveCall = savedCalls.find((call): call is Extract<ActionCall, { type: "save" }> => call.type === "save");
    expect(saveCall?.input.enabled).toBe(true);
    expect(await enabled.isChecked()).toBe(true);

    await page.evaluate(() => {
      window.__F25_CALLS__ = [];
      window.__F25_MOCK__.pollStates = ["wait", "wait", "wait", "wait"];
    });
    await panel.getByRole("button", { name: "扫码登录" }).click();
    await page.waitForFunction(() => window.__F25_CALLS__.some((call) => call.type === "poll"));
    await enabled.uncheck();
    const before = await page.evaluate(() => window.__F25_CALLS__.filter((call) => call.type === "poll").length);
    await page.waitForTimeout(2_500);
    const after = await page.evaluate(() => window.__F25_CALLS__.filter((call) => call.type === "poll").length);
    expect(after).toBe(before);
  }, 30_000);
});
