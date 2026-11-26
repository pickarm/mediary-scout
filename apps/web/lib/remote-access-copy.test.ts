import { describe, expect, it } from "vitest";
import { remoteFirstSetupNotice } from "./remote-access-copy";

describe("remoteFirstSetupNotice（外网来的访客不能做第一次设置）", () => {
  it("单用户、还没设密码、经隧道访问 → 提示回局域网设置，不给表单", () => {
    const notice = remoteFirstSetupNotice({ remote: true, singleUser: true, passwordSet: false, needsClaim: false });
    expect(notice?.title).toContain("访问密码");
    expect(notice?.note).toContain("局域网");
  });

  it("多用户、还没认领、经隧道访问 → 提示回局域网认领", () => {
    const notice = remoteFirstSetupNotice({ remote: true, singleUser: false, needsClaim: true });
    expect(notice?.note).toContain("局域网");
  });

  it("局域网访问、已设密码、已认领、或状态没读到时都不拦", () => {
    expect(remoteFirstSetupNotice({ remote: false, singleUser: true, passwordSet: false, needsClaim: false })).toBeNull();
    expect(remoteFirstSetupNotice({ remote: true, singleUser: true, passwordSet: true, needsClaim: false })).toBeNull();
    expect(remoteFirstSetupNotice({ remote: true, singleUser: false, needsClaim: false })).toBeNull();
    expect(remoteFirstSetupNotice(null)).toBeNull();
  });
});
