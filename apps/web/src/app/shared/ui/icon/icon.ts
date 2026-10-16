import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ICONS, IconName } from './icons';

@Component({
  selector: 'ss-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', class: 'ss-icon' },
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">
      <path [attr.d]="path()" />
    </svg>
  `,
  styles: `:host { display: inline-flex; flex-shrink: 0; line-height: 0; }`,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(18);
  protected readonly path = computed(() => ICONS[this.name()]);
}
