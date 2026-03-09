export type ControlCommand = "cancel" | "new_session";

const CANCEL_COMMANDS = new Set(["stop", "/stop", "/cancel"]);
const NEW_SESSION_COMMANDS = new Set(["/new", "/reset"]);

export function parseControlCommand(text: string): ControlCommand | null {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (CANCEL_COMMANDS.has(normalized)) return "cancel";
  if (NEW_SESSION_COMMANDS.has(normalized)) return "new_session";
  return null;
}
