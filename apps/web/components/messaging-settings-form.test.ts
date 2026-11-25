import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingConnectionView } from "../lib/messaging/config";

const actionMocks = vi.hoisted(() => ({
  saveMessagingConnectionAction: vi.fn(),
  unlinkMessagingConnectionAction: vi.fn(),
  beginWeixinLoginAction: vi.fn(),
  pollWeixinLoginAction: vi.fn(),
}));

vi.mock("../lib/messaging/actions", () => actionMocks);

import { MessagingSettingsForm } from "./messaging-settings-form";

const storages = [
  { id: "storage-a", label: "主光鸭云盘" },
  { id: "storage-b", label: "备用光鸭云盘" },
] as const;

const connection = (
  platform: MessagingConnectionView["platform"],
  overrides: Partial<MessagingConnectionView> = {},
): MessagingConnectionView => ({
  id: `connection-${platform}`,
  accountId: "account-1",
  platform,
  botId: platform === "telegram" ? "123456789" : platform === "feishu" ? "cli_feishu_app" : "weixin-bot",
  enabled: true,
  senderId: platform === "telegram" ? "987654321" : "sender-1",
  defaultStorageId: "storage-a",
  credentialSet: platform === "telegram"
    ? { token: true }
    : platform === "feishu"
      ? { appId: true, appSecret: true }
      : { token: true },
  ...overrides,
});

const render = (initial: MessagingConnectionView[] = []): string => renderToStaticMarkup(
  createElement(MessagingSettingsForm, { initial, storages }),
);

describe("MessagingSettingsForm", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders one native panel for each platform and defaults new connections to disabled", () => {
    const html = render();

    expect(html.match(/<section class="panel messaging-platform-panel"/g)).toHaveLength(3);
    expect(html.match(/class="push-form"/g)).toHaveLength(3);
    expect(html).toContain("微信机器人");
    expect(html).toContain("飞书机器人");
    expect(html).toContain("Telegram 机器人");
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(html).toContain("默认关闭");
    expect(html).toContain("Bot Token");
    expect(html).toContain("App ID");
    expect(html).toContain("App Secret");
    expect(html).toContain("PIN");
    expect(html).toContain("本人平台 ID");
    expect(html).toContain("主光鸭云盘");
    expect(html).toContain("备用光鸭云盘");
  });

  it("shows configured markers while keeping secret inputs empty", () => {
    const html = render([
      connection("telegram"),
      connection("feishu"),
      connection("weixin"),
    ]);

    expect(html).toContain("已配置 Bot Token");
    expect(html).toContain("已配置 App Secret");
    expect(html).toContain("已配置微信登录");
    expect(html).toContain('aria-label="Telegram Bot Token"');
    expect(html).toContain('aria-label="飞书 App Secret"');
    expect(html).toContain('type="password"');
    expect(html).toContain('value="cli_feishu_app"');
    expect(html).toContain('value="sender-1"');
    expect(html).not.toContain("telegram-secret-value");
    expect(html).not.toContain("feishu-secret-value");
  });
});
