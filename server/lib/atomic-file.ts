import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

/** A failed rename must preserve the previous file, including on a Windows sharing violation. */
export function writeFileAtomically(target: string, body: string, platform: NodeJS.Platform = process.platform): void {
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const temporary = `${target}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);fd = undefined;
    for (let attempt = 0; ; attempt++) {
      try {fs.renameSync(temporary, target);break;}
      catch(error) {
        if (platform !== 'win32' || attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        // Bounded retry for a transient scanner/indexer handle; never delete the destination.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
      }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {fs.rmSync(temporary, {force: true});} catch { /* Preserve the original error on persistent locks. */ }
  }
}
