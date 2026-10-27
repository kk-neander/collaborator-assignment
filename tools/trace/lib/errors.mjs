// Errors whose message is safe to show the user as-is (no stack trace).
export class UserError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'UserError';
    this.exitCode = exitCode;
  }
}

export class UsageError extends UserError {
  constructor(message) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

/** Describe an unexpected error without its message (which may quote file content). */
export function safeErrorLabel(e) {
  return [e?.name || 'Error', e?.code].filter(Boolean).join(' ');
}
