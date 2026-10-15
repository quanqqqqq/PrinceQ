/**
 * Local API server. Loopback-only by default (see `API_HOST`).
 *
 * Run with `npm run dev:api`, or alongside Vite with `npm run dev`.
 */
import http from 'node:http';
import { API_HOST, API_PORT } from './config.ts';
import {stopRuntimeProcesses} from './lib/process-launch.ts';
import { closeDb, getDb } from './db/connection.ts';
import {startHabitInferenceWorker} from './agent/habit-inference.ts';
import {stopQwenWorker} from './voice/qwen-runtime.ts';
import { buildRouter, STREAMING_PATHS } from './http/routes.ts';
import {
  applyCors,
  MAX_VOICE_BODY_BYTES,
  readJsonBody,
  sendError,
  sendJson,
  type RequestContext,
} from './http/router.ts';

export function createServer(): http.Server {
  const router = buildRouter();

  const server = http.createServer(async (req, res) => {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const matched = router.match(req.method ?? 'GET', url.pathname);

    if (!matched) {
      const code = router.hasPath(url.pathname) ? 405 : 404;
      sendJson(res, code, {
        error: {
          code: code === 405 ? 'method_not_allowed' : 'not_found',
          message:
            code === 405
              ? `${req.method} is not allowed on ${url.pathname}.`
              : `No route for ${req.method} ${url.pathname}. See docs/local-api.md.`,
        },
      });
      return;
    }

    try {
      const ctx: RequestContext = {
        req,
        res,
        url,
        params: matched.params,
        body: await readJsonBody(req, url.pathname.startsWith('/api/agent/voice/') ? MAX_VOICE_BODY_BYTES : undefined),
        idempotencyKey: (req.headers['idempotency-key'] as string | undefined)?.trim() || null,
      };
      const payload = await matched.handler(ctx);
      // SSE and file-download handlers write their own response.
      if (res.writableEnded || STREAMING_PATHS.has(url.pathname)) return;
      if(!res.destroyed)sendJson(res, 200, payload ?? null);
    } catch (error) {
      if(!res.destroyed)sendError(res, error);
    }
  });
  let stopObservation: (() => void) | null = null;
  server.once('listening', () => { stopObservation = startHabitInferenceWorker(getDb()); });
  server.once('close', () => { stopObservation?.(); stopQwenWorker(); });
  return server;
}

/** Direct execution guard — importing this module for tests must not bind a port. */
const isMain = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('server/index.ts');

if (isMain) {
  getDb();
  const server = createServer();
  server.listen(API_PORT, API_HOST, () => {
    console.log(`[pwq] local API listening on http://${API_HOST}:${API_PORT} (loopback only)`);
    console.log('[princeq] hourly habit observation: verified enabled Agent and sufficient new evidence required');
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopQwenWorker();
      stopRuntimeProcesses();
      const forceClose = setTimeout(() => server.closeAllConnections(), 5000);
      forceClose.unref();
      server.close(() => {clearTimeout(forceClose);closeDb();process.exit(0);});
    });
  }
}
