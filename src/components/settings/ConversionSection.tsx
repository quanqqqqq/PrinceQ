import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/settings/SectionCard';
import { conversionRangeHint, isConversionValid } from '@/components/settings/settings-contract';
import { AutosaveStatus } from '@/pages/SettingsPage/components/AutosaveStatus';
import { useSettingsAutosave } from '@/hooks/use-settings-autosave';
import { useWorkspace } from '@/hooks/use-resource';
import { getSnapshot, saveConversion, type ConversionPayload } from '@/lib/settings-client';

export function ConversionSection({value, version, onDone}: {value: ConversionPayload; version: string; onDone: () => void}) {
  const [editVersion, setEditVersion] = useState(version);
  const [hours, setHours] = useState(String(value.hours_per_day));
  const [days, setDays] = useState(String(value.days_per_month));
  const { invalidate } = useWorkspace();
  const valid = hours.trim() !== '' && days.trim() !== '' && isConversionValid(Number(hours), Number(days));
  const autosave = useSettingsAutosave({hours, days}, valid, async () => {
    await saveConversion({hours_per_day: Number(hours), days_per_month: Number(days)}, editVersion);
    invalidate(['habits']); onDone();
  });
  return <SectionCard title="耗时换算" description="用每天、每月的工作量换算任务耗时。"
    actions={<AutosaveStatus state={autosave.state} message={autosave.message} retry={autosave.retry}
      onReload={async () => {
        const fresh = await getSnapshot();
        const next = {hours: String(fresh.conversion.hours_per_day), days: String(fresh.conversion.days_per_month)};
        autosave.reset(next); setHours(next.hours); setDays(next.days); setEditVersion(fresh.versions.weights);
        invalidate(['habits']); onDone();
      }} />}>
    <div {...autosave.events} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label htmlFor="conversion-hours">每天工作小时</Label>
          <Input id="conversion-hours" type="number" min="0.5" max="24" step="0.5" value={hours} onChange={event => setHours(event.target.value)} className="bg-card! disabled:bg-muted! read-only:bg-muted!" /></div>
        <div className="space-y-1.5"><Label htmlFor="conversion-days">每月工作天数</Label>
          <Input id="conversion-days" type="number" min="1" max="31" step="1" value={days} onChange={event => setDays(event.target.value)} className="bg-card! disabled:bg-muted! read-only:bg-muted!" /></div>
      </div>
      <p className="text-xs text-muted-foreground">{conversionRangeHint()}</p>
      <Button type="button" size="sm" variant="outline" onClick={() => {setHours('8'); setDays('20');}}>恢复默认</Button>
      <p className="text-xs text-muted-foreground">只影响之后新建或更新的任务，不会改动已有任务的耗时。</p>
    </div>
  </SectionCard>;
}
