/**
 * 任务轻重缓急分布图的手势 / 缩放说明弹窗。
 *
 * 顶部那一行手势说明在窄屏上又长又挤，放进帮助弹窗后，图头部只留一个「?」
 * 入口；桌面端同样从这里看完整操作说明。说明文案同时是触屏/移动端的兜底：
 * 手机没有 Command 键也没有滚轮，缩放只能靠头部的放大 / 缩小按钮、两条滑块与
 * 重置，所以这些必须在文案里明确写出来。
 *
 * 文案必须跟 MatrixScatter 的实际分工一致：滚轮缩放**必须**按住 Command / Alt
 * 并且指针在绘图区内，不按修饰键时永远是翻页。tests/matrix-help-copy.test.ts
 * 静态守住这一点。
 */
import { useState } from 'react';
import {
  HelpCircle,
  MousePointer2,
  Move,
  SlidersHorizontal,
  Smartphone,
  ZoomIn,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

const rows = [
  {
    icon: ZoomIn,
    title: '放大 / 缩小',
    body: '点图表头部的「放大」「缩小」按钮，以视窗中心按比例缩放；分值不会因此改变。',
  },
  {
    icon: MousePointer2,
    title: '滚轮缩放（桌面）',
    body: '按住 Command（Mac）/ Alt（Windows）再在绘图区内滚动滚轮，即按指针位置缩放双轴；不按修饰键时（包括在图上）就是正常翻页，落在图外同样翻页。Mac 也兼容原来的 Option 键。',
  },
  {
    icon: Move,
    title: '平移',
    body: '在图上按住拖动即可平移视图；触屏设备用手指拖动。',
  },
  {
    icon: SlidersHorizontal,
    title: '滑块与重置',
    body: '下方横向、右侧纵向两条滑块可单独缩放某一轴；「重置」回到完整的 0..100 视图。',
  },
  {
    icon: Smartphone,
    title: '手机 / 触屏',
    body: '触屏设备没有键盘修饰键，缩放请用头部的「放大」「缩小」按钮、两条滑块与「重置」—— 它们在窄屏同样可见可点。',
  },
];

/** 图表头部的帮助按钮 + 说明弹窗。 */
export function MatrixHelpDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1 text-muted-foreground"
          aria-label="查看图表操作说明"
        >
          <HelpCircle className="size-4" />
          <span className="hidden sm:inline">操作说明</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">任务分布视图怎么操作</DialogTitle>
          <DialogDescription className="text-xs">
            横轴紧急、纵轴重要，均为 0..100，50 为中线。缩放只改变看图的视窗，不改变任务数与占比。
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-3 text-xs">
          {rows.map((row) => (
            <li key={row.title} className="flex gap-2.5">
              <row.icon className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="font-medium">{row.title}</p>
                <p className="mt-0.5 leading-relaxed text-muted-foreground">{row.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="rounded-md bg-muted/50 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
          桌面端小结：必须按住 Command / Alt 再滚动滚轮才会缩放；不按修饰键的普通滚轮永远是翻页，无论指针在图内还是图外。
        </p>
      </DialogContent>
    </Dialog>
  );
}
