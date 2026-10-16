export type PermissionReply = "once" | "always" | "reject";

export async function answerPermission(ui: any, request: any, signal: AbortSignal): Promise<PermissionReply> {
  const action = request.permission ?? request.action ?? "permission";
  const patterns: string[] = request.patterns ?? request.resources ?? [];
  const always: string[] = request.always ?? request.save ?? [];
  const once = "✓ 允许一次";
  const alwaysLabel = "✓ 始终允许";
  const rejectLabel = "✗ 拒绝";
  const choices = [once, ...(always.length ? [alwaysLabel] : []), rejectLabel];
  const detail = patterns.filter(Boolean).join(", ");
  const title = detail ? `${action}: ${detail}` : String(action);
  const choice = await ui.select(title, choices, { signal });
  if (choice === once) return "once";
  if (choice === alwaysLabel) return "always";
  return "reject";
}
