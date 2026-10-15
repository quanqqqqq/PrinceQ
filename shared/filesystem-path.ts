/** Lexical form validation only; the server enforces the project directory boundary. */
export function absoluteFilesystemPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

export function hasParentPathSegment(value: string): boolean {
  return value.split(/[\\/]/).includes('..');
}
