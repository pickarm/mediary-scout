import { NextResponse, type NextRequest } from "next/server";
import { isAccountAuthEnabled } from "./auth-mode";
import { isDemoMode } from "./demo-mode";

export function workerApiGuard(request: NextRequest): NextResponse | null {
  if (isDemoMode()) {
    return NextResponse.json({ error: "demo mode is read-only" }, { status: 403 });
  }

  const secret = process.env.MEDIA_TRACK_WORKER_SECRET;
  if ((!secret && isAccountAuthEnabled()) ||
      (secret && request.headers.get("x-media-track-worker-secret") !== secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return null;
}
