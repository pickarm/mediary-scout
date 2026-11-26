import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("../lib/workflow-runtime", () => ({
  resolveIsDesktop: () => false,
}));
vi.mock("./account-identity-loader", () => ({
  AccountIdentityLoader: () => null,
}));
vi.mock("./activity-nav-badge", () => ({
  ActivityNavBadge: () => null,
}));
vi.mock("./notifications-nav-badge", () => ({
  NotificationsNavBadge: () => null,
}));
vi.mock("./settings-attention-badge", () => ({
  SettingsAttentionBadge: () => null,
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppSidebar } from "./app-sidebar";

describe("AppSidebar", () => {
  it("renders the quick search trigger button alongside navigation and preserves workspace context", () => {
    const html = renderToStaticMarkup(
      createElement(AppSidebar, {
        active: "library",
        basePath: "/w/drive-2",
        activeStorageId: "drive-2",
      }),
    );

    expect(html).toContain("快速搜索");
    expect(html).toContain("Ctrl+K");
    expect(html).toContain('aria-label="打开快速搜索"');
    expect(html).toContain('href="/w/drive-2?tab=library"');
    expect(html).toContain('href="/settings?w=drive-2"');
  });
});
