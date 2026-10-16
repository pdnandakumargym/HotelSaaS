import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminApi, AdminProperty, Page } from '../../../core/api/admin-api.service';
import { errorMessage } from '../../../core/api/error-message';
import { JoinPresentPipe } from '../../../shared/ui/join-present.pipe';
import { Pager } from '../../../shared/ui/pager';

@Component({
  selector: 'ss-admin-properties',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [JoinPresentPipe, DatePipe, FormsModule, ReactiveFormsModule, RouterLink, Pager],
  template: `
    <header class="ss-page-head"><div><h1>Properties</h1><p class="ss-muted">All properties across the platform (business data only).</p></div></header>
    <section class="ss-card">
      <form class="search" (ngSubmit)="load(1)">
        <label class="ss-visually-hidden" for="pq">Search properties</label>
        <input id="pq" class="ss-input" [formControl]="q" placeholder="Search by name or city" />
        <button class="ss-btn ss-btn--ghost" type="submit">Search</button>
      </form>
      @if (error(); as e) { <p class="ss-alert ss-alert--error">{{ e }}</p> }
      <div class="ss-table-wrap">
        <table class="ss-table">
          <thead><tr><th>Property</th><th>Customer</th><th>Type</th><th>Location</th><th>Room types</th><th>Rooms</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            @for (p of page()?.data ?? []; track p.id) {
              <tr>
                <td><strong>{{ p.name }}</strong></td>
                <td><a [routerLink]="['/admin/customers', p.organization.id]">{{ p.organization.name }}</a></td>
                <td>{{ p.propertyType }}</td>
                <td>{{ ([p.city, p.countryCode] | joinPresent: ', ') }}</td>
                <td>{{ p.roomTypeCount }}</td><td>{{ p.roomCount }}</td><td>{{ p.status }}</td>
                <td>{{ p.createdAt | date: 'mediumDate' }}</td>
              </tr>
            } @empty { <tr><td colspan="8" class="ss-muted">No properties found.</td></tr> }
          </tbody>
        </table>
      </div>
      @if (page(); as p) { <ss-pager [page]="p.meta.page" [total]="p.meta.total" [pageSize]="p.meta.pageSize" (go)="load($event)" /> }
    </section>
  `,
  styles: `.search { display: flex; gap: 8px; margin-bottom: 12px; } .search input { max-width: 320px; }`,
})
export class AdminProperties implements OnInit {
  private readonly api = inject(AdminApi);
  protected readonly page = signal<Page<AdminProperty> | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly q = new FormControl('', { nonNullable: true });
  ngOnInit(): void {
    this.load(1);
  }
  protected load(n: number): void {
    this.api.properties(n, this.q.value.trim() || undefined).subscribe({ next: (p) => this.page.set(p), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }
}
