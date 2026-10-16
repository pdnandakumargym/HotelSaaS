import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type PillTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

@Component({
  selector: 'ss-status-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': '"pill pill--" + tone()' },
  template: `<span class="dot" aria-hidden="true"></span><ng-content />`,
  styles: `
    :host {
      display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px;
      font-size: 12px; font-weight: 600; white-space: nowrap;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    :host(.pill--success) { color: var(--ss-green-600); background: var(--ss-green-50); }
    :host(.pill--warning) { color: var(--ss-amber-600); background: var(--ss-amber-50); }
    :host(.pill--danger)  { color: var(--ss-red-600);   background: var(--ss-red-50); }
    :host(.pill--neutral) { color: var(--ss-gray-600);  background: var(--ss-gray-50); }
    :host(.pill--info)    { color: var(--ss-blue-600);  background: var(--ss-blue-50); }
  `,
})
export class StatusPill {
  readonly tone = input<PillTone>('neutral');
}
