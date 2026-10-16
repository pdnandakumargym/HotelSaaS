import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { AdminApi, AdminUser, Page } from '../../../core/api/admin-api.service';
import { errorMessage } from '../../../core/api/error-message';
import { AuthService } from '../../../core/auth/auth.service';
import { StepUpService } from '../../../core/auth/step-up.service';
import { Pager } from '../../../shared/ui/pager';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

@Component({
  selector: 'ss-admin-users',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, StatusPill, FormsModule, ReactiveFormsModule, Pager],
  template: `
    <header class="ss-page-head">
      <div><h1>Users &amp; roles</h1><p class="ss-muted">Accounts across the platform with their security status.</p></div>
    </header>
    @if (message(); as m) { <p class="ss-alert ss-alert--success" role="status">{{ m }}</p> }
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    <section class="ss-card">
      <form class="search" (ngSubmit)="load(1)">
        <label class="ss-visually-hidden" for="uq">Search users</label>
        <input id="uq" class="ss-input" [formControl]="q" placeholder="Search by email or name" />
        <button class="ss-btn ss-btn--ghost" type="submit">Search</button>
      </form>
      <div class="ss-table-wrap">
        <table class="ss-table">
          <thead><tr><th>User</th><th>Platform role</th><th>Email</th><th>2FA</th><th>Status</th><th>Last sign-in</th><th><span class="ss-visually-hidden">Actions</span></th></tr></thead>
          <tbody>
            @for (u of page()?.data ?? []; track u.id) {
              <tr>
                <td><strong>{{ u.displayName }}</strong><br /><small class="ss-muted">{{ u.email }}</small></td>
                <td>{{ u.platformRole ?? '—' }}</td>
                <td><ss-status-pill [tone]="u.emailVerifiedAt ? 'success' : 'warning'">{{ u.emailVerifiedAt ? 'Verified' : 'Unverified' }}</ss-status-pill></td>
                <td><ss-status-pill [tone]="u.twoFactorEnabled ? 'success' : 'neutral'">{{ u.twoFactorEnabled ? 'On' : 'Off' }}</ss-status-pill></td>
                <td>
                  @if (u.locked) { <ss-status-pill tone="danger">Locked</ss-status-pill> }
                  @else { <ss-status-pill [tone]="u.status === 'ACTIVE' ? 'success' : 'neutral'">{{ u.status }}</ss-status-pill> }
                </td>
                <td>{{ u.lastLoginAt ? (u.lastLoginAt | date: 'medium') : 'Never' }}</td>
                <td>
                  @if (u.locked && canManage) {
                    <button type="button" class="ss-link-btn" (click)="unlock(u)">Unlock</button>
                  }
                </td>
              </tr>
            } @empty { <tr><td colspan="7" class="ss-muted">No users found.</td></tr> }
          </tbody>
        </table>
      </div>
      @if (page(); as p) { <ss-pager [page]="p.meta.page" [total]="p.meta.total" [pageSize]="p.meta.pageSize" (go)="load($event)" /> }
    </section>
  `,
  styles: `.search { display: flex; gap: 8px; margin-bottom: 12px; } .search input { max-width: 320px; }`,
})
export class AdminUsers implements OnInit {
  private readonly api = inject(AdminApi);
  private readonly stepUp = inject(StepUpService);
  protected readonly canManage = inject(AuthService).hasPlatformPermission('admin.user.manage');
  protected readonly page = signal<Page<AdminUser> | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly message = signal<string | null>(null);
  protected readonly q = new FormControl('', { nonNullable: true });

  ngOnInit(): void {
    this.load(1);
  }

  protected load(n: number): void {
    this.api.users(n, this.q.value.trim() || undefined).subscribe({ next: (p) => this.page.set(p), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }

  protected unlock(u: AdminUser): void {
    this.stepUp.run(() => this.api.unlockUser(u.id)).subscribe({
      next: () => {
        this.message.set(`${u.email} can sign in again.`);
        this.load(this.page()?.meta.page ?? 1);
      },
      error: (e: unknown) => this.error.set(errorMessage(e)),
    });
  }
}
