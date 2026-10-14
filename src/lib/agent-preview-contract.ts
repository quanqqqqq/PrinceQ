/** Token namespaces are disjoint; legacy goal previews keep their original API. */
export function previewActionPath(token: string, action: 'confirm' | 'cancel'): string {
  return token.startsWith('pa_') ? '/agent/preview/' + action : '/agent/' + action;
}
