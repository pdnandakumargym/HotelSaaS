import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Metric tile. Shows an em dash and an explanation when there is no real data yet. */
@Component({
  selector: 'ss-kpi-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="label">{{ label() }}</p>
    <p class="value" [class.value--empty]="value() === null">{{ value() ?? '—' }}</p>
    <p class="hint">{{ hint() }}</p>
  `,
  styles: `
    :host { display: block; background: var(--ss-surface); border: 1px solid var(--ss-border);
      border-radius: var(--ss-radius-lg); padding: 14px 16px; box-shadow: var(--ss-shadow); min-width: 0; }
    p { margin: 0; }
    .label { color: var(--ss-text-muted); font-size: 12.5px; }
    .value { font-size: 26px; font-weight: 700; margin: 4px 0 2px; }
    .value--empty { color: var(--ss-text-subtle); }
    .hint { font-size: 12px; color: var(--ss-text-subtle); }
  `,
})
export class KpiTile {
  readonly label = input.required<string>();
  readonly value = input<string | null>(null);
  readonly hint = input('');
}
