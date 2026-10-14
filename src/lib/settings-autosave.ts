/** Single-flight autosave. Drafts stay local until a successful response acknowledges them. */
export type SaveState = 'saved' | 'editing' | 'waiting' | 'saving' | 'invalid' | 'error' | 'conflict';
export class SettingsAutosave {
  private key: string;
  private saved: string;
  private valid = true;
  private enabled = true;
  private focused = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<boolean> | null = null;
  private action: () => Promise<unknown> = async () => {};
  private failure: 'error' | 'conflict' | null = null;
  private listeners = new Set<() => void>();
  private state: SaveState = 'saved';
  message = '';
  constructor(key: string) { this.key = key; this.saved = key; }
  get dirty() { return this.key !== this.saved; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() {
    const next: SaveState = this.flight ? 'saving' : this.failure ??
      (!this.dirty || !this.enabled ? 'saved' : !this.valid ? 'invalid' : this.focused ? 'editing' : 'waiting');
    this.state = next;
    this.listeners.forEach(listener => listener());
  }
  private cancel() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  update(key: string, valid: boolean, action: () => Promise<unknown>, enabled = true) {
    const changed = key !== this.key;
    this.key = key; this.valid = valid; this.action = action; this.enabled = enabled;
    if (!enabled) { this.saved = key; this.failure = null; }
    // A conflict needs an explicit reload; further typing must never bypass it.
    if (changed && this.failure === 'error') this.failure = null;
    if (changed || !enabled || !valid) this.schedule();
    this.emit();
  }
  activity() { this.schedule(); }
  focus(editing: boolean) { this.focused = editing; this.schedule(); this.emit(); }
  private schedule() {
    this.cancel();
    if (!this.enabled || !this.dirty || !this.valid || this.focused || this.failure || this.flight) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 500);
  }
  async flush(): Promise<boolean> {
    this.cancel();
    if (this.flight) { const ok = await this.flight; return ok ? this.flush() : false; }
    if (!this.enabled || !this.dirty) return true;
    if (!this.valid || this.failure === 'conflict') return false;
    const key = this.key;
    const action = this.action;
    this.failure = null;
    this.flight = Promise.resolve().then(action).then(result => {
      if (result === false) throw new Error('保存失败，请重试。');
      this.saved = key;
      this.message = '';
      return true;
    }).catch((cause: unknown) => {
      this.failure = typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 409 ? 'conflict' : 'error';
      this.message = this.failure === 'conflict' ? '设置已在别处修改。当前输入已保留，请核对后重新读取设置。' : '保存失败，当前输入已保留。';
      return false;
    }).finally(() => { this.flight = null; this.schedule(); this.emit(); });
    this.emit();
    return this.flight;
  }
  reset(key: string) { this.cancel(); this.key = key; this.saved = key; this.failure = null; this.message = ''; this.emit(); }
  retry() { if (this.failure === 'conflict') return; this.failure = null; void this.flush(); }
  /** Navigation may unmount a form before its debounce expires. Complete the queued edit. */
  leave() { this.focused = false; this.schedule(); }
}
