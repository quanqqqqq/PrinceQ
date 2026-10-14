/** Optional sorting controls share the work preference autosave. */
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { SectionCard } from '@/components/settings/SectionCard';
import {
  DEFAULT_BALANCED_WEIGHTS,
  WEIGHT_KEY_LABELS,
  WEIGHT_LEVEL_LABELS,
  clampWeight,
  summarizeWeights,
} from '@/components/settings/settings-contract';
import {
  previewWeights,
  type SettingsWeights,
  type WeightsDraft,
} from '@/lib/settings-client';

const WEIGHT_KEYS = Object.keys(WEIGHT_KEY_LABELS) as (keyof SettingsWeights)[];
const LEVELS: (0 | 1 | 2)[] = [0, 1, 2];

const LEVEL_BASE = 'h-9 min-w-14 rounded-md px-2 text-xs transition-colors';
const LEVEL_OFF = 'border border-input bg-background hover:bg-muted';
const LEVEL_ON = 'bg-primary text-primary-foreground';

export function AdvancedWeightsSection({ draft, onChange, status }: {
  draft: WeightsDraft;
  onChange: (next: WeightsDraft) => void;
  status: ReactNode;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const atDefaults = WEIGHT_KEYS.every(
    (key) => clampWeight(draft.weights[key]) === DEFAULT_BALANCED_WEIGHTS[key],
  );

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const result = await previewWeights(draft);
      const message = result.message ? ` · ${result.message}` : '';
      setPreview(`${summarizeWeights(result.weights)}${message}`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : '试算没有成功。');
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <SectionCard
      title="排序权重"
      actions={status}
    >
      <Collapsible>
        <CollapsibleTrigger className="flex h-9 w-full items-center justify-between gap-2 rounded-md px-1 text-sm hover:bg-muted">
          <span>高级：排序权重</span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 pt-3">
          {WEIGHT_KEYS.map((key) => (
            <div key={key} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs">{WEIGHT_KEY_LABELS[key]}</span>
              <div className="flex gap-1.5">
                {LEVELS.map((level) => {
                  const on = clampWeight(draft.weights[key]) === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={on}
                      className={`${LEVEL_BASE} ${on ? LEVEL_ON : LEVEL_OFF}`}
                      onClick={() =>
                        onChange({
                          ...draft,
                          weights: { ...draft.weights, [key]: clampWeight(level) },
                        })
                      }
                    >
                      {WEIGHT_LEVEL_LABELS[level]}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="min-h-9"
              disabled={previewing}
              onClick={() => void runPreview()}
            >
              {previewing ? '试算中…' : '预览'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="min-h-9"
              disabled={atDefaults}
              onClick={() => onChange({ ...draft, weights: { ...DEFAULT_BALANCED_WEIGHTS } })}
            >
              恢复默认权重
            </Button>

          </div>

          <p className="text-xs text-muted-foreground">
            调整后自动保存。恢复默认只影响排序权重。
          </p>

          {preview ? (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">{preview}</p>
            </div>
          ) : null}
        </CollapsibleContent>
      </Collapsible>

    </SectionCard>
  );
}
