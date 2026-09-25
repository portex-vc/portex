/** Structured logging: one line per event, human-readable by default, JSON lines with MOCK_LOG=json or --json. */

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let json = process.env.MOCK_LOG === 'json' || process.argv.includes('--json');
let minimum: Level =
  (process.env.MOCK_LOG_LEVEL as Level) in ORDER
    ? (process.env.MOCK_LOG_LEVEL as Level)
    : process.argv.includes('--verbose')
      ? 'debug'
      : 'info';
const context: Record<string, unknown> = {};

export function configureLog(opts: { json?: boolean; level?: Level; context?: Record<string, unknown> }) {
  if (opts.json !== undefined) json = opts.json;
  if (opts.level) minimum = opts.level;
  if (opts.context) Object.assign(context, opts.context);
}

function format(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
  if (value === undefined) return 'undefined';
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function emit(level: Level, event: string, raw: Record<string, unknown> = {}) {
  if (ORDER[level] < ORDER[minimum]) return;
  const fields = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const time = new Date().toISOString();
  const line = json
    ? JSON.stringify({ time, level, event, ...context, ...fields }, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      )
    : `${time.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${event}${Object.entries(fields)
        .map(([k, v]) => ` ${k}=${format(v)}`)
        .join('')}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
};

/** Short, secret-free description of an error for logs. */
export function errorText(error: unknown): string {
  if (!error) return 'unknown error';
  const e = error as { shortMessage?: string; message?: string; name?: string };
  const text = e.shortMessage || e.message || String(error);
  return text.split('\n')[0].slice(0, 300);
}
