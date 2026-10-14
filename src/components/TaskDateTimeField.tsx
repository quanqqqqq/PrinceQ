/**
 * 任务截止时间选择器：Popover + Calendar + 一个原生 `<input type="time">`。
 *
 * 值契约与它替换掉的原生 `<input type="datetime-local">` **完全一致**：对外只认
 * `''` 或墙钟串 `'YYYY-MM-DDTHH:mm'`（浏览器本地日历上的年月日时分，不带时区）。
 * 所以存储语义一点没变——调用方照旧用 `new Date(墙钟串).toISOString()` 入库、
 * 用本地年月日时分回显，这个组件不碰那条路径，也不做任何 UTC 换算。
 *
 * 时区零偏移靠本地构造：内部一律 `new Date(y, m - 1, d, h, min)`，绝不
 * `new Date('YYYY-MM-DD')`——后者按 UTC 午夜解析，非 UTC 时区会整日偏一天。
 */
import { useState } from 'react';
import { CHINESE_CALENDAR_LABELS } from '@/lib/calendar-labels';
import { zhCN } from 'date-fns/locale';
import { Calendar as CalendarIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** 触发器上的展示文案，例如 2026年10月13日 09:00。 */
const DISPLAY_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** 严格的 `YYYY-MM-DDTHH:mm`，组件对外的唯一值格式。 */
const STRICT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** 没选过时分时的默认钟点：上午九点，比午夜更像一个真实的截止时刻。 */
const DEFAULT_TIME = '09:00';

const pad = (n: number) => String(n).padStart(2, '0');

/** 本地 Date → `YYYY-MM-DD`（取本地年月日，不经 UTC）。 */
const toWallDate = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * `YYYY-MM-DDTHH:mm` → 本地 Date；格式不符或日子/钟点不存在时返回 null。
 *
 * 本地构造是关键，见文件头注释。
 */
function parseWall(value: string): Date | null {
  const match = STRICT_RE.exec(value);
  if (!match) return null;
  const [y, m, d, h, min] = match.slice(1).map(Number);
  if (h > 23 || min > 59) return null;
  const date = new Date(y, m - 1, d, h, min);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

export function TaskDateTimeField({
  id,
  value,
  onChange,
  disabled,
  placeholder = '选择截止时间',
}: {
  id?: string;
  /** `''` 或 `'YYYY-MM-DDTHH:mm'` 墙钟串。 */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);

  const selected = parseWall(value) ?? undefined;
  /** 时分输入框的当前值；还没选过就显示默认钟点。 */
  const time = selected ? `${pad(selected.getHours())}:${pad(selected.getMinutes())}` : DEFAULT_TIME;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/*
          整行都是这个 button：点哪儿都开弹层，键盘 focus 后 Enter/Space 也开，
          全靠原生 button 行为，不需要自定义 keydown。
        */}
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className="h-9 w-full justify-start bg-card! font-normal"
        >
          <CalendarIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className={value ? undefined : 'text-muted-foreground'}>
            {selected ? DISPLAY_FORMAT.format(selected) : placeholder}
          </span>
          {/* 清除按钮落在触发器内部，必须吞掉点击，否则会顺带把弹层打开。 */}
          {value ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label="清除截止时间"
              className="ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChange('');
              }}
            >
              <X className="size-3.5" />
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          locale={zhCN}
          labels={CHINESE_CALENDAR_LABELS}
          selected={selected}
          defaultMonth={selected}
          onSelect={(date) => {
            // 换日期保留已选的时分（没选过就用默认钟点）。
            if (date) onChange(`${toWallDate(date)}T${time}`);
          }}
          autoFocus
        />
        {/* 时分单独一行：日期已选就改它的时分，没选过就落在今天。 */}
        <div className="flex items-center gap-2 border-t border-border p-2">
          <Input
            type="time"
            value={time}
            onChange={(event) => {
              const next = event.target.value;
              // 清空时分输入时不动值：日期还在，用户大概只是要重新敲。
              if (!next) return;
              onChange(`${toWallDate(selected ?? new Date())}T${next}`);
            }}
            aria-label="截止时间的时分"
            className="h-8 w-28 bg-card! text-xs disabled:bg-muted! read-only:bg-muted!"
          />
          <span className="text-xs text-muted-foreground">24 小时制</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
