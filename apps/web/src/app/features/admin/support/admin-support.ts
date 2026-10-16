import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AdminApi, AdminSupportRequest } from '../../../core/api/admin-api.service';
import { errorMessage } from '../../../core/api/error-message';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

type SupportProperties = { id: string; name: string; propertyType: string; city: string | null; roomTypes: { id: string; name: string; code: string; maxOccupancy: number; _count: { rooms: number } }[] }[];

@Component({
  selector: 'ss-admin-support',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Support tools</h1>
        <p class="ss-muted">Request access from a customer's page. Access needs the owner's approval, is read-only, expires automatically and every view is audited.</p>
      </div>
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    <section class="ss-card">
      <h2 class="ss-card__title">My access requests</h2>
      <div class="ss-table-wrap">
        <table class="ss-table">
          <thead><tr><th>Customer</th><th>Reason</th><th>Requested</th><th>Status</th><th><span class="ss-visually-hidden">Actions</span></th></tr></thead>
          <tbody>
            @for (r of requests(); track r.id) {
              <tr>
                <td><a [routerLink]="['/admin/customers', r.organizationId]">{{ r.organizationName }}</a></td>
                <td>{{ r.reason }}</td>
                <td>{{ r.createdAt | date: 'medium' }}</td>
                <td>
                  @if (r.active) { <ss-status-pill tone="success">Active until {{ r.expiresAt | date: 'shortTime' }}</ss-status-pill> }
                  @else { <ss-status-pill [tone]="r.status === 'PENDING' ? 'info' : 'neutral'">{{ r.status === 'APPROVED' ? 'Expired' : r.status }}</ss-status-pill> }
                </td>
                <td>@if (r.active) { <button type="button" class="ss-link-btn" (click)="view(r)">View data</button> }</td>
              </tr>
            } @empty { <tr><td colspan="5" class="ss-muted">No requests yet.</td></tr> }
          </tbody>
        </table>
      </div>
    </section>

    @if (viewing(); as v) {
      <section class="ss-card view">
        <h2 class="ss-card__title">{{ v.org }} · read-only <ss-status-pill tone="warning">Access ends {{ v.expiresAt | date: 'shortTime' }}</ss-status-pill></h2>
        @for (p of v.properties; track p.id) {
          <h3>{{ p.name }} <small class="ss-muted">{{ p.propertyType }} · {{ p.city }}</small></h3>
          <ul>@for (t of p.roomTypes; track t.id) { <li>{{ t.name }} ({{ t.code }}), max {{ t.maxOccupancy }}, {{ t._count.rooms }} rooms</li> }</ul>
        } @empty { <p class="ss-muted">No properties.</p> }
      </section>
    }
  `,
  styles: `.view { margin-top: 16px; } h3 { font-size: 14px; margin: 12px 0 4px; } ul { margin: 0; padding-left: 18px; font-size: 13.5px; }`,
})
export class AdminSupport implements OnInit {
  private readonly api = inject(AdminApi);
  protected readonly requests = signal<AdminSupportRequest[]>([]);
  protected readonly viewing = signal<{ org: string; expiresAt: string; properties: SupportProperties } | null>(null);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.api.supportRequests().subscribe({ next: (r) => this.requests.set(r.data), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }

  protected view(r: AdminSupportRequest): void {
    this.api.supportProperties(r.id).subscribe({
      next: (res) => this.viewing.set({ org: r.organizationName, expiresAt: res.meta.accessExpiresAt, properties: res.data }),
      error: (e: unknown) => this.error.set(errorMessage(e)),
    });
  }
}
