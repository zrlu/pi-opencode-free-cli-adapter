import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type PermissionReply = "once" | "always" | "reject";
export type PermissionMode = "allow" | "ask" | "reject";

const CONFIG_FILE = "opencode-free-permissions.json";

export function permissionConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE);
}

// Global, persistent across restarts: files are read on every request so old
// and new sessions all follow the current setting.
export function loadPermissionMode(): PermissionMode {
  try {
    const path = permissionConfigPath();
    if (!existsSync(path)) return "ask";
    const mode = JSON.parse(readFileSync(path, "utf-8"))?.mode;
    return mode === "allow" || mode === "reject" ? mode : "ask";
  } catch {
    return "ask";
  }
}

export function savePermissionMode(mode: PermissionMode): void {
  const path = permissionConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ mode }, null, 2)}\n`, "utf-8");
}

export async function answerPermission(ui: any, request: any, signal: AbortSignal): Promise<PermissionReply> {
  const mode = loadPermissionMode();
  if (mode === "allow") return "always";
  if (mode === "reject") return "reject";
  if (!ui) return "reject";
  const action = request.permission ?? request.action ?? "permission";
  const patterns: string[] = request.patterns ?? request.resources ?? [];
  const always: string[] = request.always ?? request.save ?? [];
  const once = "✓ Allow once";
  const alwaysLabel = "✓ Always allow";
  const rejectLabel = "✗ Reject";
  const choices = [once, ...(always.length ? [alwaysLabel] : []), rejectLabel];
  const detail = patterns.filter(Boolean).join(", ");
  const title = detail ? `${action}: ${detail}` : String(action);
  const choice = await ui.select(title, choices, { signal });
  if (choice === once) return "once";
  if (choice === alwaysLabel) return "always";
  return "reject";
}
