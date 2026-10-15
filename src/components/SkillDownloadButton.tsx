import {useState} from 'react';
import {Download, Loader2} from 'lucide-react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip';

export function SkillDownloadButton({compact = false}: {compact?: boolean}) {
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      const response = await fetch('/api/skills/princeq/download');
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error?.message || 'Skill 下载失败，请稍后重试。');
      }
      if (!response.headers.get('Content-Type')?.startsWith('application/zip')) {
        throw new Error('下载服务未返回 ZIP 包，请检查 PrinceQ 是否正在运行。');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'PrinceQ-Agent-Skill.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Skill 下载失败，请稍后重试。');
    } finally {
      setDownloading(false);
    }
  };

  const button = <Button type="button" variant="ghost" size={compact ? 'icon' : 'sm'}
    className={compact ? 'size-7 text-muted-foreground hover:text-primary [&_svg]:size-3.5' : 'w-full text-muted-foreground hover:text-primary'}
    onClick={() => void download()} disabled={downloading}
    aria-label={downloading ? '正在下载 PrinceQ Skill' : '下载 PrinceQ Skill'}>
    {downloading ? <Loader2 className="animate-spin" /> : <Download />}
    {compact ? <span className="sr-only">下载 PrinceQ Skill</span> : downloading ? '正在下载…' : '下载 PrinceQ Skill'}
  </Button>;

  return compact ? <Tooltip>
    <TooltipTrigger asChild>{button}</TooltipTrigger>
    <TooltipContent side="left">下载 PrinceQ Skill，在其他 Agent 中安装</TooltipContent>
  </Tooltip> : button;
}
