import { ChangeDetectionStrategy, Component, OnInit, inject, output, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { OrgApi, Property } from '../../../core/api/org-api.service';

/**
 * Property selector shared by the rates, calendar and mapping pages. The choice is kept in the
 * `?property=` query parameter so links and reloads keep it.
 */
@Component({
  selector: 'ss-property-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (loaded()) {
      @if (properties().length) {
        <label class="picker">
          <span>Property</span>
          <select class="ss-input" [value]="selected() ?? ''" (change)="pick($any($event.target).value)">
            @for (p of properties(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
          </select>
        </label>
      } @else {
        <p class="ss-alert ss-alert--info">Add a property first. <a routerLink="/app/properties/new">Create a property</a></p>
      }
    }
  `,
  styles: `
    .picker { display: inline-flex; align-items: center; gap: 8px; font-size: 13.5px; color: var(--ss-text-muted); }
    .picker select { min-width: 220px; height: 36px; }
  `,
})
export class PropertyPicker implements OnInit {
  private readonly api = inject(OrgApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly changed = output<Property>();
  protected readonly properties = signal<Property[]>([]);
  protected readonly selected = signal<string | null>(null);
  protected readonly loaded = signal(false);

  ngOnInit(): void {
    this.api.properties().subscribe((list) => {
      this.properties.set(list);
      this.loaded.set(true);
      const wanted = this.route.snapshot.queryParamMap.get('property');
      const p = list.find((x) => x.id === wanted) ?? list[0];
      if (p) this.select(p, false);
    });
  }

  protected pick(id: string): void {
    const p = this.properties().find((x) => x.id === id);
    if (p) this.select(p, true);
  }

  private select(p: Property, navigate: boolean): void {
    this.selected.set(p.id);
    if (navigate) void this.router.navigate([], { queryParams: { property: p.id }, queryParamsHandling: 'merge', replaceUrl: true });
    this.changed.emit(p);
  }
}
