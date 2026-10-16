import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { OrgApi, Property } from '../../../core/api/org-api.service';
import { RoomsManager } from './rooms-manager';

@Component({
  selector: 'ss-rooms-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, RoomsManager],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Rooms &amp; units</h1>
        <p class="ss-muted">Room types (what you sell) and the physical rooms or units behind them.</p>
      </div>
      @if (properties().length > 1) {
        <label class="pick"><span class="ss-visually-hidden">Property</span>
          <select class="ss-input" [ngModel]="selected()" (ngModelChange)="selected.set($event)">
            @for (p of properties(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
          </select>
        </label>
      }
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error">{{ e }}</p> }
    @if (selected(); as id) {
      <ss-rooms-manager [propertyId]="id" />
    } @else if (loaded()) {
      <section class="ss-card"><p class="ss-muted">Add a property first. <a routerLink="/app/properties/new">Add property</a></p></section>
    }
  `,
  styles: `.pick select { min-width: 240px; }`,
})
export class RoomsPage implements OnInit {
  private readonly api = inject(OrgApi);
  protected readonly properties = signal<Property[]>([]);
  protected readonly selected = signal<string | null>(null);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.api.properties().subscribe({
      next: (p) => {
        this.properties.set(p);
        this.selected.set(p[0]?.id ?? null);
        this.loaded.set(true);
      },
      error: (e: unknown) => this.error.set(errorMessage(e)),
    });
  }
}
