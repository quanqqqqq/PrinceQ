/** Build a portable ZIP from the repository's current Skill files on each download. */
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {crc32} from 'node:zlib';
import {PRINCEQ_SKILL_DIRECTORY} from './injection.ts';

export const PRINCEQ_SKILL_ARCHIVE_NAME = 'PrinceQ-Agent-Skill.zip';
const SKILL_NAME = 'personal-work-queue';

export async function buildPrinceQSkillArchive(directory = PRINCEQ_SKILL_DIRECTORY): Promise<Buffer> {
  // Fail before sending headers when the checkout has no complete Skill bundle.
  await readFile(path.join(directory, 'SKILL.md'));
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;
  let count = 0;

  const walk = async (relative: string) => {
    const entries = await readdir(path.join(directory, relative), {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__' ||
          /^test_.*\.py$/.test(entry.name) || /\.py[co]$/.test(entry.name)) continue;
      const filePath = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill bundle contains a symbolic link: ${filePath}`);
      if (entry.isDirectory()) { await walk(filePath); continue; }
      if (!entry.isFile()) continue;
      const data = await readFile(path.join(directory, filePath));
      const name = Buffer.from(`${SKILL_NAME}/${filePath.split(path.sep).join('/')}`, 'utf8');
      const checksum = crc32(data);

      // ZIP method 0 (stored) needs no external archiver. Fixed DOS date makes
      // identical source files yield identical archives; UTF-8 names are explicit.
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(33, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(33, 14);
      central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      localRecords.push(local, name, data);
      centralRecords.push(central, name);
      offset += local.length + name.length + data.length;
      count += 1;
    }
  };
  await walk('');
  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}
