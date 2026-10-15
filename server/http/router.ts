/**
 * Minimal router over `node:http` — no framework dependency, matching the
 * brief's "local dependencies only" constraint.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ALLOWED_ORIGINS } from '../config.ts';
import { ApiError, badRequest } from '../lib/errors.ts';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  /** From the Idempotency-Key header, or generated for non-idempotent-safe calls. */
  idempotencyKey: string | null;
}

export type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  /** Path split into literal segments and `:name` captures. */
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    this.routes.push({
      method,
      segments: path.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get = (path: string, handler: Handler) => this.add('GET', path, handler);
  post = (path: string, handler: Handler) => this.add('POST', path, handler);
  patch = (path: string, handler: Handler) => this.add('PATCH', path, handler);
  put = (path: string, handler: Handler) => this.add('PUT', path, handler);
  delete = (path: string, handler: Handler) => this.add('DELETE', path, handler);

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(parts[i]);
        } else if (segment !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }

  /** True when the path exists under another method — distinguishes 405 from 404. */
  hasPath(pathname: string): boolean {
    const parts = pathname.split('/').filter(Boolean);
    return this.routes.some(
      (route) =>
        route.segments.length === parts.length &&
        route.segments.every((segment, i) => segment.startsWith(':') || segment === parts[i]),
    );
  }
}

const MAX_BODY_BYTES = 256 * 1024;
export const MAX_VOICE_BODY_BYTES = 12 * 1024 * 1024;

export async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      throw badRequest('Request body is too large.');
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw badRequest(`Request body is not valid JSON: ${(error as Error).message}`);
  }
}

export function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  // Loopback dev origins only — the service is not meant to be reachable
  // from anywhere else.
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, X-PrinceQ-Agent, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(res, error.status, {
      // `extra` 先铺底：`error` 是这个信封的固定键，任何路由都不该把它顶掉。
      ...(error.extra ?? {}),
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  if (error instanceof z.ZodError) {
    sendJson(res, 400, {
      error: { code: 'validation_failed', message: 'Request validation failed', details: error.issues },
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  // SQLite surfaces the "one active claim per task" index as a constraint error.
  if (/UNIQUE constraint failed/i.test(message)) {
    sendJson(res, 409, {
      error: { code: 'conflict', message: `Conflicting write rejected: ${message}` },
    });
    return;
  }
  console.error('[pwq] unhandled error:', error);
  sendJson(res, 500, { error: { code: 'internal_error', message } });
}

/** Parses with zod, converting failures into a 400 with issue details. */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ApiError(400, 'validation_failed', 'Request validation failed', result.error.issues);
  }
  return result.data;
}
