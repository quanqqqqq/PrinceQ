import type { Labels } from 'react-day-picker';
const dayFormat = new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'});
const monthFormat = new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long'});
export function calendarDayLabel(date: Date, modifiers: {today?:boolean;selected?:boolean} = {}): string {
  return (modifiers.today ? '今天，' : '') + (modifiers.selected ? '已选择，' : '') + dayFormat.format(date);
}
export const CHINESE_CALENDAR_LABELS: Partial<Labels> = {
  labelNav: () => '日历导航',
  labelPrevious: () => '上个月',
  labelNext: () => '下个月',
  labelDayButton: calendarDayLabel,
  labelGrid: date => monthFormat.format(date),
  labelWeekday: date => new Intl.DateTimeFormat('zh-CN',{weekday:'long'}).format(date),
  labelMonthDropdown: () => '选择月份',
  labelYearDropdown: () => '选择年份',
  labelWeekNumber: week => '第' + week + '周',
  labelWeekNumberHeader: () => '周',
};
