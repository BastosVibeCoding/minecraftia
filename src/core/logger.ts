import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

const SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|password|authorization)/i;
const SECRET_VALUE_PATTERNS = [/sk-or-[A-Za-z0-9_-]{10,}/g, /sk-[A-Za-z0-9_-]{20,}/g, /Bearer\s+[A-Za-z0-9._-]+/g];
const MASK = '***';

/** Masque récursivement les secrets connus et les motifs de clés dans une valeur à journaliser. */
export function scrub(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const s of secrets) if (s.length >= 6) out = out.split(s).join(MASK);
    for (const p of SECRET_VALUE_PATTERNS) out = out.replace(p, MASK);
    return out;
  }
  if (value instanceof Error) {
    const copy = new Error(scrub(value.message, secrets, depth + 1) as string);
    copy.name = value.name;
    copy.stack = value.stack ? (scrub(value.stack, secrets, depth + 1) as string) : undefined;
    return copy;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) && v !== undefined && v !== null ? MASK : scrub(v, secrets, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  secrets?: readonly string[];
  destination?: DestinationStream;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const secrets = (opts.secrets ?? []).filter((s) => s && s.length >= 6);
  const options: pino.LoggerOptions = {
    level: opts.level ?? 'info',
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    hooks: {
      logMethod(args, method) {
        const cleaned = args.map((a) => scrub(a, secrets)) as Parameters<typeof method>;
        method.apply(this, cleaned);
      },
    },
  };
  if (opts.destination) return pino(options, opts.destination);
  if (opts.pretty) {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } });
  }
  return pino(options);
}
