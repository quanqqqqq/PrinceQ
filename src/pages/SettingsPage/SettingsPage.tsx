import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AdvancedWeightsSection } from '@/components/settings/AdvancedWeightsSection';
import { AgentRuntimeSection } from '@/components/settings/AgentRuntimeSection';
import { ConstraintsSection } from '@/components/settings/ConstraintsSection';
import { ConversionSection } from '@/components/settings/ConversionSection';
import { ExplicitHabitsSection } from '@/components/settings/ExplicitHabitsSection';
import { InferredHabitsSection } from '@/components/settings/InferredHabitsSection';
import { WorkPreferencesSection } from '@/components/settings/WorkPreferencesSection';
import { AutosaveStatus } from './components/AutosaveStatus';
import { ErrorState, LoadingRows } from '@/components/states';
import { useResource, useWorkspace } from '@/hooks/use-resource';
import { useSettingsAutosave } from '@/hooks/use-settings-autosave';
import { getSnapshot, saveWeights, type SettingsSnapshot, type WeightsDraft } from '@/lib/settings-client';

function SettingsEditor({data, onDone}: {data: SettingsSnapshot; onDone: () => void}) {
  const location = useLocation();
  useEffect(() => {
    if (location.hash !== '#agent-assistant') return;
    const frame = requestAnimationFrame(() => {
      const section = document.getElementById('agent-assistant');
      section?.scrollIntoView({block: 'start', behavior: 'instant'});
      section?.focus({preventScroll: true});
    });
    return () => cancelAnimationFrame(frame);
  }, [location.hash, location.key]);
  const [draft, setDraft] = useState<WeightsDraft>(() => structuredClone(data.weights));
  // Freeze the editing baseline. The client advances only versions acknowledged by our own writes.
  const [version, setVersion] = useState(data.versions.weights);
  const { invalidate } = useWorkspace();
  const autosave = useSettingsAutosave(draft, true, async () => {
    await saveWeights(draft, version);
    invalidate(['habits']);
    onDone();
  });
  const completed = () => { invalidate(['habits']); onDone(); };
  const saveStatus = <AutosaveStatus state={autosave.state} message={autosave.message} retry={autosave.retry}
    onReload={async () => {
      const fresh = await getSnapshot();
      autosave.reset(fresh.weights); setDraft(structuredClone(fresh.weights)); setVersion(fresh.versions.weights);
      completed();
    }} />;
  return <div className="mx-auto max-w-2xl space-y-4">
    <p className="px-1 text-xs text-muted-foreground">个人设置只存在本机。点选自动保存；文字或数字填完后，离开输入框并静置 0.5 秒自动保存。</p>
    <div {...autosave.events} className="space-y-4">
      <WorkPreferencesSection draft={draft} onChange={setDraft} status={saveStatus} />
      <AdvancedWeightsSection draft={draft} onChange={setDraft} status={saveStatus} />
    </div>
    <ExplicitHabitsSection entries={data.explicit} versions={data.versions} onDone={completed} />
    <ConversionSection value={data.conversion} version={version} onDone={completed} />
    <ConstraintsSection entries={data.constraints} version={data.versions.constraints} onDone={completed} />
    <InferredHabitsSection entries={data.inferred} explicitEntries={data.explicit} versions={data.versions} onDone={completed} />
    <section id="agent-assistant" tabIndex={-1} aria-label="PrinceQ 助手配置" className={'scroll-mt-4 rounded-lg focus-visible:outline-2 focus-visible:outline-primary' + (location.hash === '#agent-assistant' ? ' min-h-[calc(100dvh-8rem)]' : '')}><AgentRuntimeSection /></section>
  </div>;
}
export default function SettingsPage() {
  const {data, loading, error, refetch} = useResource(['habits'], getSnapshot);
  if (loading) return <LoadingRows rows={5} />;
  if (!data) return error ? <ErrorState message={error} onRetry={refetch} /> : null;
  return <SettingsEditor data={data} onDone={refetch} />;
}
