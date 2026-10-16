import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminApi, AdminOrganization, Page } from '../../../core/api/admin-api.service';
import { errorMessage } from '../../../core/api/error-message';
import { Pager } from '../../../shared/ui/pager';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

@Component({
  selector: 'ss-admin-customers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, StatusPill, FormsModule, ReactiveFormsModule, Pager, RouterLink],
  template: `
    <header class="ss-page-head">
      <div><h1>Customers</h1><p class="ss-muted">Organizations on the platform. Tenant records and guest data are not shown here.</p></div>
    </header>
    <section class="ss-card">
      <form class="search" (ngSubmit)="load(1)">
        <label class="ss-visually-hidden" for="q">Search organizations</label>
        <input id="q" class="ss-input" [formControl]="q" placeholder="Search by name or slug" />
        <button class="ss-btn ss-btn--ghost" type="submit">Search</button>
      </form>
      @if (error(); as e) { <p class="ss-alert ss-alert--error">{{ e }}</p> }
      <div class="ss-table-wrap">
        <table class="ss-table">
          <thead><tr><th>Organization</th><th>Status</th><th>Properties</th><th>Members</th><th>2FA policy</th><th>Joined</th></tr></thead>
          <tbody>
            @for (o of page()?.data ?? []; track o.id) {
              <tr>
                <td><a [routerLink]="['/admin/customers', o.id]"><strong>{{ o.name }}</strong></a><br /><small class="ss-muted">{{ o.slug }}</small></td>
                <td><ss-status-pill [tone]="o.status === 'ACTIVE' ? 'success' : 'danger'">{{ o.status }}</ss-status-pill></td>
                <td>{{ o.propertyCount }}</td>
                <td>{{ o.memberCount }}</td>
                <td>{{ o.twoFactorRequired ? 'Required' : 'Optional' }}</td>
                <td>{{ o.createdAt | date: 'mediumDate' }}</td>
              </tr>
            } @empty { <tr><td colspan="6" class="ss-muted">No organizations found.</td></tr> }
          </tbody>
        </table>
      </div>
      @if (page(); as p) { <ss-pager [page]="p.meta.page" [total]="p.meta.total" [pageSize]="p.meta.pageSize" (go)="load($event)" /> }
    </section>
  `,
  styles: `.search { display: flex; gap: 8px; margin-bottom: 12px; } .search input { max-width: 320px; }`,
})
export class AdminCustomers implements OnInit {
  private readonly api = inject(AdminApi);
  protected readonly page = signal<Page<AdminOrganization> | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly q = new FormControl('', { nonNullable: true });

  ngOnInit(): void {
    this.load(1);
  }

  protected load(n: number): void {
    this.api.organizations(n, this.q.value.trim() || undefined).subscribe({ next: (p) => this.page.set(p), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }
}
