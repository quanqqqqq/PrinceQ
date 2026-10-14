/**
 * Local service configuration. Everything is loopback-only and file-based so the
 * app works offline on macOS with no external services.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(serverDir, '..');

/** Randomly selected stable dev ports (see spark.json / vite.config.ts proxy). */
export const WEB_PORT = 28641;
export const API_PORT = Number(process.env.PWQ_API_PORT ?? 28642);

/** Loopback only by default — never bind 0.0.0.0 without an explicit opt-in. */
export const API_HOST = process.env.PWQ_API_HOST ?? '127.0.0.1';

export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const DB_PATH = process.env.PWQ_DB_PATH ?? path.join(DATA_DIR, 'work-queue.db');
export const SCHEMA_PATH = path.join(serverDir, 'db', 'schema.sql');

/** Habit files live in the repository so the Skill/Agent can read them directly. */
export const HABITS_DIR = process.env.PWQ_HABITS_DIR ?? path.join(ROOT_DIR, 'habits');

/**
 * Local CLI agent runtime settings. Only *names* of environment variables are
 * ever stored here — never their values, so the file carries no secret.
 *
 * Resolved lazily on every read rather than frozen at module load: tests point
 * `PWQ_AGENT_RUNTIME_CONFIG` at a temp file, and a module-level constant would
 * already have captured the real path before they get the chance.
 */
export const agentRuntimeConfigPath = (): string =>
  process.env.PWQ_AGENT_RUNTIME_CONFIG ?? path.join(ROOT_DIR, 'config', 'agent-runtime.json');

export const QUEUE_ALGORITHM_VERSION = 'pwq-queue-1.0.0';

/** The default human actor; demo-friendly single-user setup. */
export const DEFAULT_ACTOR_ID = 'actor-human-me';
export const AGENT_ACTOR_ID = 'actor-agent-local';
export const AUTOMATION_ACTOR_ID = 'actor-automation-cron';

export const ALLOWED_ORIGINS = [
  `http://localhost:${WEB_PORT}`,
  `http://127.0.0.1:${WEB_PORT}`,
];
