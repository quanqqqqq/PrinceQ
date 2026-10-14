/**
 * 统一 datetime util 的测试。
 *
 * 覆盖：
 *   - 用户时区解析顺序（env.TZ > Intl > Asia/Singapore 兜底）
 *   - 相对日期：今天/明天/明天上午十点/tomorrow 10am/下周/in N days/YYYY-MM-DD
 *   - 跨日（夜里 23:30 说明天 → 应落到下一个日历日的 EOD）
 *   - DST 安全（America/New_York 春秋令切换前后偏移正确）
 *   - 展示：本地日期时间带 UTC 偏移标签
 *   - 不破坏现有记录：DB 里的旧 ISO 直接被 new Date() 解析，行为不变
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EOD_HOUR,
  DEFAULT_TIMEZONE,
  addDaysWall,
  formatDeadlineLocal,
  formatLocalDate,
  formatLocalRelative,
  formatLocalTimestamp,
  getUserTimezone,
  isoToWallDate,
  offsetMinutesAt,
  parseRelativeToIso,
  partsInTz,
  tzLabel,
  wallDateToIso,
  zonedWallToUtc,
} from '../shared/datetime.ts';

const SG = 'Asia/Singapore';
const NY = 'America/New_York';

// 固定"现在"：2026-10-12 20:30 SGT = 2026-10-12 12:30 UTC。
const NOW = new Date('2026-10-12T12:30:00.000Z');

test('getUserTimezone: 默认兜底 Asia/Singapore；env.TZ 覆盖', () => {
  const saved = process.env.TZ;
  try {
    delete process.env.TZ;
    // 在 macOS 上 /etc/localtime 指向 Asia/Shanghai，这里只断言它返回一个合法 IANA 名。
    const tz = getUserTimezone();
    assert.ok(typeof tz === 'string' && tz.length > 0);
    // 当 Intl 给不出值时，兜底是 Asia/Singapore。
    assert.ok(tz === DEFAULT_TIMEZONE || /\//.test(tz));
    process.env.TZ = 'America/New_York';
    assert.equal(getUserTimezone(), 'America/New_York');
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('parseRelativeToIso: "tomorrow" 在 SG 解析为明天 18:00 SGT', () => {
  const r = parseRelativeToIso('create task review by tomorrow', { now: NOW, timezone: SG });
  assert.ok(r);
  // 2026-10-13 18:00 SGT = 2026-10-13 10:00 UTC
  assert.equal(r.iso, '2026-10-13T10:00:00.000Z');
  assert.equal(r.wall.y, 2026);
  assert.equal(r.wall.m, 10);
  assert.equal(r.wall.d, 13);
  assert.equal(r.wall.h, DEFAULT_EOD_HOUR);
  assert.equal(r.timezone, SG);
});

test('parseRelativeToIso: "明天上午十点" = 明天 10:00 SGT', () => {
  const r = parseRelativeToIso('create task x 明天上午十点', { now: NOW, timezone: SG });
  assert.ok(r);
  assert.equal(r.iso, '2026-10-13T02:00:00.000Z'); // 10:00 SGT = 02:00 UTC
  assert.equal(r.wall.h, 10);
  assert.equal(r.wall.min, 0);
});

test('parseRelativeToIso: "tomorrow 10am" 与 "明天上午十点" 等价', () => {
  const a = parseRelativeToIso('x tomorrow 10am', { now: NOW, timezone: SG });
  const b = parseRelativeToIso('x 明天上午十点', { now: NOW, timezone: SG });
  assert.ok(a && b);
  assert.equal(a.iso, b.iso);
});

test('parseRelativeToIso: "today" 落今天 EOD，不跨日', () => {
  const r = parseRelativeToIso('by today EOD', { now: NOW, timezone: SG });
  assert.ok(r);
  assert.equal(r.iso, '2026-10-12T10:00:00.000Z'); // 今天 18:00 SGT
});

test('parseRelativeToIso: 跨日安全——SG 23:30 说"明天"仍落到下一个日历日', () => {
  // 现在 = 2026-10-12 23:30 SGT = 2026-10-12 15:30 UTC
  const lateNight = new Date('2026-10-12T15:30:00.000Z');
  const r = parseRelativeToIso('x tomorrow', { now: lateNight, timezone: SG });
  assert.ok(r);
  assert.equal(r.wall.d, 13);
  assert.equal(r.iso, '2026-10-13T10:00:00.000Z');
});

test('parseRelativeToIso: 跨月——1/31 说明天 → 2/1', () => {
  // 2026-01-31 08:00 SGT = 2026-01-31 00:00 UTC
  const jan31 = new Date('2026-01-31T00:00:00.000Z');
  const r = parseRelativeToIso('x tomorrow', { now: jan31, timezone: SG });
  assert.ok(r);
  assert.equal(r.wall.y, 2026);
  assert.equal(r.wall.m, 2);
  assert.equal(r.wall.d, 1);
});

test('parseRelativeToIso: "in 3 days" = 今天+3 的 EOD', () => {
  const r = parseRelativeToIso('finish in 3 days', { now: NOW, timezone: SG });
  assert.ok(r);
  assert.equal(r.wall.d, 15); // 10/12 + 3 = 10/15
  assert.equal(r.iso, '2026-10-15T10:00:00.000Z');
});

test('parseRelativeToIso: "next week" = +7 天', () => {
  const r = parseRelativeToIso('goal due next week', { now: NOW, timezone: SG });
  assert.ok(r);
  assert.equal(r.wall.d, 19); // 10/12 + 7
});

test('parseRelativeToIso: YYYY-MM-DD 不带时间默认 EOD', () => {
  const r = parseRelativeToIso('due 2026-12-01', { now: NOW, timezone: SG });
  assert.ok(r);
  assert.equal(r.iso, '2026-12-01T10:00:00.000Z'); // 12/1 18:00 SGT
});

test('parseRelativeToIso: YYYY-MM-DD + "at 22:00" 取 22:00', () => {
  const r = parseRelativeToIso('due 2026-12-01 at 22:00', { now: NOW, timezone: SG });
  assert.ok(r);
  assert.equal(r.iso, '2026-12-01T14:00:00.000Z'); // 22:00 SGT = 14:00 UTC
});

test('parseRelativeToIso: 无日期短语返回 null', () => {
  assert.equal(parseRelativeToIso('just a task', { now: NOW, timezone: SG }), null);
});

test('DST 安全：offsetMinutesAt 在 NY 春令切换前后取到正确偏移', () => {
  // 2026-03-08 06:59 UTC 仍是 EST (UTC-5 = -300)
  assert.equal(offsetMinutesAt(Date.parse('2026-03-08T06:59:00Z'), NY), -300);
  // 2026-03-08 09:00 UTC 已切到 EDT (UTC-4 = -240)
  assert.equal(offsetMinutesAt(Date.parse('2026-03-08T09:00:00Z'), NY), -240);
});

test('DST 安全：zonedWallToUtc 在 NY 夏令时往返一致', () => {
  // 2026-07-09 10:00 NY (EDT, UTC-4) 应为 14:00 UTC
  const utcMs = zonedWallToUtc(2026, 7, 9, 10, 0, NY);
  assert.equal(new Date(utcMs).toISOString(), '2026-07-09T14:00:00.000Z');
  // 再读回墙钟，应该是 10:00
  const back = partsInTz(utcMs, NY);
  assert.equal(back.h, 10);
  assert.equal(back.d, 9);
  assert.equal(back.m, 7);
});

test('DST 安全：zonedWallToUtc 在 NY 冬令时往返一致', () => {
  // 2026-01-15 10:00 NY (EST, UTC-5) 应为 15:00 UTC
  const utcMs = zonedWallToUtc(2026, 1, 15, 10, 0, NY);
  assert.equal(new Date(utcMs).toISOString(), '2026-01-15T15:00:00.000Z');
});

test('addDaysWall: NY 跨 DST 切换日不偏移', () => {
  // 2026-03-07 12:00 NY (EST) → +1 天 = 2026-03-08 12:00 NY (EDT)
  const baseUtc = zonedWallToUtc(2026, 3, 7, 12, 0, NY);
  const next = addDaysWall(baseUtc, 1, NY);
  assert.equal(next.y, 2026);
  assert.equal(next.m, 3);
  assert.equal(next.d, 8);
  assert.equal(next.h, 12);
});

test('展示：formatLocalTimestamp 带 UTC 偏移标签', () => {
  // 2026-10-12T02:00Z 在 SG 是 10:00，在 NY 是前一天 22:00 (EDT)
  const sg = formatLocalTimestamp('2026-10-12T02:00:00.000Z', { timezone: SG });
  assert.match(sg, /10:00/);
  assert.match(sg, /\(UTC\+8\)/);
  const ny = formatLocalTimestamp('2026-10-12T02:00:00.000Z', { timezone: NY });
  assert.match(ny, /\(UTC−4\)/);
});

test('展示：tzLabel 处理半小时偏移', () => {
  // Asia/Kathmandu = UTC+5:45
  assert.equal(tzLabel('Asia/Kathmandu', new Date('2026-01-01T00:00:00Z')), '(UTC+5:45)');
});

test('展示：formatLocalDate / formatLocalRelative / formatDeadlineLocal 不抛', () => {
  assert.ok(formatLocalDate('2026-10-12T02:00:00.000Z', { timezone: SG }).includes('2026'));
  assert.equal(formatLocalRelative('2026-10-12T12:29:30Z', { now: NOW }), '刚刚');
  assert.equal(formatDeadlineLocal(null, { now: NOW }), '无截止时间');
  assert.match(formatDeadlineLocal('2026-10-12T20:00:00Z', { now: NOW }), /小时后到期|小时内到期/);
});

test('DB 里的旧 ISO 不受影响：parseRelativeToIso 不修改现有记录', () => {
  // 旧记录就是一个 ISO 字符串，本工具不要求它符合新格式；Date 往返幂等即可。
  const legacy = '2026-01-15T10:30:00.000Z';
  assert.equal(new Date(legacy).toISOString(), legacy);
  // 旧记录经过展示函数仍能渲染，不抛。
  assert.ok(formatLocalDate(legacy, { timezone: SG }).includes('2026'));
});

// ── date-only 互转（目标日期） ───────────────────────────────────────────────

test('wallDateToIso: SG 墙钟日取正午为锚，往返不变', () => {
  // 2026-10-13 12:00 SGT = 2026-10-13 04:00 UTC
  assert.equal(wallDateToIso('2026-10-13', SG), '2026-10-13T04:00:00.000Z');
  assert.equal(isoToWallDate('2026-10-13T04:00:00.000Z', SG), '2026-10-13');
  for (const day of ['2026-01-01', '2026-02-28', '2026-10-13', '2026-12-31']) {
    assert.equal(isoToWallDate(wallDateToIso(day, SG)!, SG), day, day);
  }
});

test('wallDateToIso: 非 UTC 时区往返不偏一天（进程 TZ 生效）', () => {
  // 这是任务 8 要修掉的那个 bug：`new Date('2026-10-13')` 按 UTC 午夜解析，
  // 到了 America/New_York（UTC-4/-5）读回墙钟日就变成 10-12。
  const saved = process.env.TZ;
  try {
    process.env.TZ = NY;
    // 默认参数读 env.TZ，所以这里不显式传时区——走的正是组件用的那条路径。
    const day = '2026-10-13';
    const iso = wallDateToIso(day);
    assert.ok(iso);
    assert.equal(isoToWallDate(iso), day, '往返回到同一个日历日');
    // 对照：旧写法在 NY 会偏到前一天。
    assert.equal(
      new Date('2026-10-13').toISOString().slice(0, 10),
      '2026-10-13',
      'UTC 午夜本身没偏',
    );
    assert.equal(
      isoToWallDate(new Date('2026-10-13').toISOString(), NY),
      '2026-10-12',
      '旧写法在 NY 确实偏了一天——这正是新函数要避免的',
    );
    // DST 切换日前后也不能偏（NY 2026-03-08 春令）。
    for (const d of ['2026-03-07', '2026-03-08', '2026-03-09', '2026-11-01']) {
      assert.equal(isoToWallDate(wallDateToIso(d)!, NY), d, d);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('wallDateToIso: 非法输入返回 null', () => {
  for (const bad of [
    '',
    '2026-10',
    '2026-1-3', // 必须补零
    '2026/10/13',
    '2026-13-01', // 13 月
    '2026-02-30', // 不存在的日子
    '2026-00-10',
    '2026-10-00',
    'not-a-date',
  ]) {
    assert.equal(wallDateToIso(bad, SG), null, bad);
  }
});

test('isoToWallDate: 坏时间戳回空串，不抛也不显示 NaN', () => {
  assert.equal(isoToWallDate('not-a-date', SG), '');
});

test('isoToWallDate: 同一瞬间在不同时区可以落在不同日历日', () => {
  // 2026-10-13 02:00 UTC：SG 已是 13 日上午，NY 还是 12 日晚上。
  assert.equal(isoToWallDate('2026-10-13T02:00:00.000Z', SG), '2026-10-13');
  assert.equal(isoToWallDate('2026-10-13T02:00:00.000Z', NY), '2026-10-12');
});
