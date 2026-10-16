import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { Amenity } from '../../../core/api/org-api.service';

const GROUP_LABELS: Record<string, string> = {
  general: 'General',
  wellness: 'Wellness',
  food: 'Food & drink',
  family: 'Family',
  business: 'Business',
  room: 'In the room',
  bathroom: 'Bathroom',
  outdoor: 'Outdoor',
  accessibility: 'Accessibility',
};

/** Checkbox grid of amenities, grouped. Two-way binds the selected codes. */
@Component({
  selector: 'ss-amenity-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (g of groups(); track g.key) {
      <fieldset>
        <legend>{{ g.label }}</legend>
        <div class="grid">
          @for (a of g.items; track a.code) {
            <label class="chk">
              <input type="checkbox" [checked]="selected().includes(a.code)" (change)="toggle(a.code)" [disabled]="disabled()" />
              {{ a.label }}
            </label>
          }
        </div>
      </fieldset>
    }
  `,
  styles: `
    fieldset { border: 0; padding: 0; margin: 0 0 12px; }
    legend { font-weight: 600; font-size: 13px; margin-bottom: 6px; color: var(--ss-text-muted); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px 12px; }
    .chk { display: flex; align-items: center; gap: 8px; font-size: 13.5px; }
  `,
})
export class AmenityPicker {
  readonly amenities = input.required<Amenity[]>();
  readonly scope = input<'property' | 'room'>('property');
  readonly disabled = input(false);
  readonly selected = model<string[]>([]);

  protected readonly groups = computed(() => {
    const items = this.amenities().filter((a) => a.scope === 'both' || a.scope === this.scope());
    const keys = [...new Set(items.map((a) => a.group))];
    return keys.map((key) => ({ key, label: GROUP_LABELS[key] ?? key, items: items.filter((a) => a.group === key) }));
  });

  protected toggle(code: string): void {
    const cur = this.selected();
    this.selected.set(cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code]);
  }
}
