export type GuardianMessage =
  | { type: 'hello'; pid: number }
  | {
      type: 'hello_reply';
      runnerPid: number;
      command: string;
      cwd: string;
      deadlineAtMs: number;
      psPath: string;
      shPath: string;
    }
  | { type: 'topology'; ok: boolean; reason?: string }
  | { type: 'grant' }
  | { type: 'protocol_violation'; state: string }
  | { type: 'shell_spawned'; pid: number }
  | { type: 'shell_error'; reason: 'spawn' | 'expired_before_spawn' }
  | { type: 'shell_exit'; code: number | null; signal: string | null }
  | { type: 'cleanup_term'; observation: 'returned' | 'error' }
  | { type: 'cleanup_kill_intent' }
  | { type: 'deadline' };

const TYPES = new Set([
  'hello',
  'hello_reply',
  'topology',
  'grant',
  'protocol_violation',
  'shell_spawned',
  'shell_error',
  'shell_exit',
  'cleanup_term',
  'cleanup_kill_intent',
  'deadline',
]);

export function isGuardianMessage(value: unknown): value is GuardianMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return typeof message.type === 'string' && TYPES.has(message.type);
}

export function sendGuardianMessage(message: GuardianMessage): boolean {
  if (typeof process.send !== 'function' || !process.connected) return false;
  try {
    process.send(message);
    return true;
  } catch {
    return false;
  }
}
