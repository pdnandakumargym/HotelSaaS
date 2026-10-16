import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon } from '../icon/icon';
import { IconName } from '../icon/icons';
import { StatusPill } from '../status-pill/status-pill';

/**
 * Honest placeholder for modules that are on the roadmap but not built yet.
 * Inputs are bound from route data (withComponentInputBinding).
 */
@Component({
  selector: 'ss-planned-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, StatusPill],
  template: `
    <header class="head">
      <h1>{{ title() }}</h1>
      <ss-status-pill tone="info">Planned · Milestone {{ milestone() }}</ss-status-pill>
    </header>
    <section class="ss-card empty" aria-live="polite">
      <span class="badge"><ss-icon [name]="icon()" [size]="28" /></span>
      <h2>Not available yet</h2>
      <p class="ss-muted">{{ description() }}</p>
      <p class="ss-muted small">
        This module is scheduled for Milestone {{ milestone() }}. No data is shown here until it is built and connected to real records.
      </p>
    </section>
  `,
  styles: `
    .head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
    h1 { font-size: 22px; }
    .empty { text-align: center; padding: 48px 24px; max-width: 640px; }
    .badge { display: inline-flex; padding: 14px; border-radius: 50%; background: var(--ss-blue-50); color: var(--ss-blue-600); margin-bottom: 12px; }
    h2 { font-size: 17px; margin-bottom: 6px; }
    p { margin: 6px auto; max-width: 460px; }
    .small { font-size: 12.5px; }
  `,
})
export class PlannedPage {
  readonly title = input('Coming soon');
  readonly description = input('');
  readonly milestone = input(0);
  readonly icon = input<IconName>('clock');
}
