import { DatePipe, JsonPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { AdminApi, AuditEvent, Page } from '../../../core/api/admin-api.service';
import { errorMessage } from '../../../core/api/error-message';
import { Pager } from '../../../shared/ui/pager';

@Component({
  selector: 'ss-admin-audit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, JsonPipe, FormsModule, ReactiveFormsModule, Pager],
  template: `
    <header class="ss-page-head">
      <div><h1>Security &amp; audit</h1><p class="ss-muted">Append-only log of authentication and administrative events.</p></div>
    </header>
    <section class="ss-card">
      <form class="search" (ngSubmit)="load(1)">
        <label class="ss-visually-hidden" for="aq">Filter by action prefix</label>
        <input id="aq" class="ss-input" [formControl]="q" placeholder="Filter by action, e.g. auth.login" />
        <button class="ss-btn ss-btn--ghost" type="submit">Filter</button>
      </form>
      @if (error(); as e) { <p class="ss-alert ss-alert--error">{{ e }}</p> }
      <div class="ss-table-wrap">
        <table class="ss-table">
          <thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Entity</th><th>IP</th><th>Details</th></tr></thead>
          <tbody>
            @for (e of page()?.data ?? []; track e.id) {
              <tr>
                <td class="nowrap">{{ e.createdAt | date: 'medium' }}</td>
                <td><code>{{ e.action }}</code></td>
                <td>{{ e.actorType }}@if (e.actorUserId) { <br /><small class="ss-muted">{{ e.actorUserId.slice(0, 8) }}…</small> }</td>
                <td>{{ e.entityType ?? '—' }}</td>
                <td>{{ e.ipAddress ?? '—' }}</td>
                <td><small class="ss-muted">{{ e.metadata | json }}</small></td>
              </tr>
            } @empty { <tr><td colspan="6" class="ss-muted">No events.</td></tr> }
          </tbody>
        </table>
      </div>
      @if (page(); as p) { <ss-pager [page]="p.meta.page" [total]="p.meta.total" [pageSize]="p.meta.pageSize" (go)="load($event)" /> }
    </section>
  `,
  styles: `.search { display: flex; gap: 8px; margin-bottom: 12px; } .search input { max-width: 320px; } .nowrap { white-space: nowrap; }`,
})
export class AdminAudit implements OnInit {
  private readonly api = inject(AdminApi);
  protected readonly page = signal<Page<AuditEvent> | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly q = new FormControl('', { nonNullable: true });

  ngOnInit(): void {
    this.load(1);
  }

  protected load(n: number): void {
    this.api.auditEvents(n, this.q.value.trim() || undefined).subscribe({ next: (p) => this.page.set(p), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }
}
