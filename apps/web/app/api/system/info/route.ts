import { connection, NextResponse } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import { resolveCurrentIsOwner } from "../../../../lib/settings-attention-server";
import { collectSystemInfo } from "../../../../lib/system-info-server";
import {
  hasLoginPassword,
  isMultiUserEnabled,
  requireAuthenticatedAccountId,
  UnauthenticatedAccountError,
} from "../../../../lib/workflow-runtime";

/** 返回系统运行信息、数据库/Redis 连通状态、版本及当前账号已入库影片统计。 */
export async function GET() {
  await connection();
  if (!isDemoMode() && !isMultiUserEnabled() && process.env.MEDIA_TRACK_DESKTOP !== "1") {
    if ((await hasLoginPassword()) !== true) {
      return NextResponse.json({ error: "未设置访问密码，请先完成初始化。" }, { status: 401 });
    }
  }

  let accountId: string;
  try {
    accountId = await requireAuthenticatedAccountId();
  } catch (error) {
    if (error instanceof UnauthenticatedAccountError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    throw error;
  }

  const canViewInfraDetails = isDemoMode() ? false : await resolveCurrentIsOwner();
  const snapshot = await collectSystemInfo({ accountId, canViewInfraDetails });
  return NextResponse.json(snapshot, {
    headers: { "Cache-Control": "no-store" },
  });
}
