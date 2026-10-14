/** Typed API errors mapped to HTTP status codes by the router. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /**
   * Extra top-level keys merged into the error response body, alongside `error`.
   *
   * Used by the settings version conflict, which ships the current snapshot so
   * the client can replace its stale state without a second round trip. It sits
   * outside `error.details` because it is a normal payload, not diagnostics.
   */
  readonly extra?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.extra = extra;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'bad_request', message, details);

export const notFound = (message: string, details?: unknown) =>
  new ApiError(404, 'not_found', message, details);

/** Invalid lifecycle transition or a claim that is already held. */
export const conflict = (message: string, details?: unknown) =>
  new ApiError(409, 'conflict', message, details);

export const unprocessable = (message: string, details?: unknown) =>
  new ApiError(422, 'unprocessable', message, details);

/**
 * 设置文件的乐观并发冲突：客户端带来的 `expected_version` 已经过期。
 *
 * `extra` 里挂上当前完整快照，客户端据此直接替换本地状态（界面只需提示「已在别处
 * 被修改」并刷新，不必再发一次 GET）。
 */
export const versionConflict = (snapshot: unknown) =>
  new ApiError(409, 'version_conflict', '设置已在别处被修改', {}, { snapshot });
