import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { Invitation, Member, OrgApi } from '../../../core/api/org-api.service';
import { OrgRole, ROLE_LABELS } from '../../../core/auth/auth.models';
import { AuthService } from '../../../core/auth/auth.service';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

@Component({
  selector: 'ss-team',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, StatusPill, FormsModule, ReactiveFormsModule],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Team members &amp; roles</h1>
        <p class="ss-muted">People with access to {{ auth.currentOrg()?.organizationName ?? 'your organization' }}.</p>
      </div>
    </header>

    @if (message(); as m) {
      <p class="ss-alert" [class.ss-alert--success]="m.tone === 'success'" [class.ss-alert--error]="m.tone === 'error'" role="status">{{ m.text }}</p>
    }

    @if (canManage()) {
      <section class="ss-card">
        <h2 class="ss-card__title">Invite someone</h2>
        <form class="invite" [formGroup]="inviteForm" (ngSubmit)="invite()" novalidate>
          <label class="ss-field grow"><span>Email address</span><input class="ss-input" type="email" formControlName="email" autocomplete="off" /></label>
          <label class="ss-field"><span>Role</span>
            <select class="ss-input" formControlName="role">
              @for (r of roles; track r) { <option [value]="r">{{ labels[r] }}</option> }
            </select>
          </label>
          <button class="ss-btn" type="submit" [disabled]="busy()">Send invitation</button>
        </form>
        <details class="roles-help">
          <summary>What can each role do?</summary>
          <ul>
            <li><strong>Owner</strong>: everything, including team, billing and security settings.</li>
            <li><strong>Property manager</strong>: properties, rooms, rates, inventory, bookings and channels.</li>
            <li><strong>Property staff</strong>: view properties and bookings, update inventory and room status.</li>
            <li><strong>Read-only viewer</strong>: view properties and bookings.</li>
          </ul>
        </details>
      </section>

      @if (invitations().length) {
        <section class="ss-card">
          <h2 class="ss-card__title">Pending invitations</h2>
          <div class="ss-table-wrap">
            <table class="ss-table">
              <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th><span class="ss-visually-hidden">Actions</span></th></tr></thead>
              <tbody>
                @for (i of invitations(); track i.id) {
                  <tr>
                    <td>{{ i.email }}</td>
                    <td>{{ labels[i.role] }}</td>
                    <td>@if (i.expired) { <ss-status-pill tone="warning">Expired</ss-status-pill> } @else { {{ i.expiresAt | date: 'mediumDate' }} }</td>
                    <td class="right">
                      <button type="button" class="ss-link-btn" (click)="resend(i)">Resend</button> ·
                      <button type="button" class="ss-link-btn danger" (click)="revoke(i)">Revoke</button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    }

    <section class="ss-card">
      <h2 class="ss-card__title">Members</h2>
      @if (!canRead()) {
        <p class="ss-muted">Your role cannot view the member list.</p>
      } @else {
        <div class="ss-table-wrap">
          <table class="ss-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>2FA</th><th>Last sign-in</th><th><span class="ss-visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              @for (m of members(); track m.membershipId) {
                <tr>
                  <td>{{ m.displayName }} @if (m.isMe) { <ss-status-pill tone="info">You</ss-status-pill> }</td>
                  <td>{{ m.email }}</td>
                  <td>
                    @if (canManage()) {
                      <select class="ss-input role-select" [ngModel]="m.role" (ngModelChange)="changeRole(m, $event)" [attr.aria-label]="'Role for ' + m.displayName">
                        @for (r of roles; track r) { <option [value]="r">{{ labels[r] }}</option> }
                      </select>
                    } @else { {{ labels[m.role] }} }
                  </td>
                  <td><ss-status-pill [tone]="m.twoFactorEnabled ? 'success' : 'neutral'">{{ m.twoFactorEnabled ? 'On' : 'Off' }}</ss-status-pill></td>
                  <td>{{ m.lastLoginAt ? (m.lastLoginAt | date: 'medium') : 'Never' }}</td>
                  <td class="right">
                    @if (m.isMe) {
                      <button type="button" class="ss-link-btn danger" (click)="remove(m)">Leave</button>
                    } @else if (canManage()) {
                      <button type="button" class="ss-link-btn danger" (click)="remove(m)">Remove</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
  styles: `
    section.ss-card { margin-bottom: 16px; }
    .invite { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
    .invite .grow { flex: 1; min-width: 220px; }
    .invite .ss-field { margin-bottom: 0; }
    .roles-help { margin-top: 12px; font-size: 13px; }
    .roles-help summary { cursor: pointer; color: var(--ss-blue-600); }
    .role-select { height: 34px; min-width: 170px; }
    .right { text-align: right; white-space: nowrap; }
    .danger { color: var(--ss-red-600); }
  `,
})
export class Team implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(OrgApi);
  private readonly router = inject(Router);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly labels = ROLE_LABELS;
  protected readonly roles: OrgRole[] = ['ORG_OWNER', 'PROPERTY_MANAGER', 'PROPERTY_STAFF', 'READ_ONLY'];
  protected readonly members = signal<Member[]>([]);
  protected readonly invitations = signal<Invitation[]>([]);
  protected readonly message = signal<{ tone: 'success' | 'error'; text: string } | null>(null);
  protected readonly busy = signal(false);
  protected readonly canManage = computed(() => this.auth.hasOrgPermission('member.manage'));
  protected readonly canRead = computed(() => this.auth.hasOrgPermission('member.read'));
  protected readonly inviteForm = this.fb.group({ email: ['', [Validators.required, Validators.email]], role: ['PROPERTY_STAFF' as OrgRole] });

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    if (this.canRead()) this.api.members().subscribe({ next: (m) => this.members.set(m), error: (e: unknown) => this.fail(e) });
    if (this.canManage()) this.api.invitations().subscribe({ next: (i) => this.invitations.set(i), error: (e: unknown) => this.fail(e) });
  }

  private ok(text: string): void {
    this.busy.set(false);
    this.message.set({ tone: 'success', text });
    this.load();
  }
  private fail(e: unknown): void {
    this.busy.set(false);
    this.message.set({ tone: 'error', text: errorMessage(e) });
  }

  protected invite(): void {
    if (this.inviteForm.invalid) {
      this.message.set({ tone: 'error', text: 'Enter a valid email address.' });
      return;
    }
    const { email, role } = this.inviteForm.getRawValue();
    this.busy.set(true);
    this.api.invite(email, role).subscribe({
      next: () => {
        this.inviteForm.controls.email.reset('');
        this.ok(`Invitation sent to ${email}.`);
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected resend(i: Invitation): void {
    this.api.resendInvitation(i.id).subscribe({ next: () => this.ok(`New link sent to ${i.email}.`), error: (e: unknown) => this.fail(e) });
  }
  protected revoke(i: Invitation): void {
    this.api.revokeInvitation(i.id).subscribe({ next: () => this.ok('Invitation revoked.'), error: (e: unknown) => this.fail(e) });
  }
  protected changeRole(m: Member, role: OrgRole): void {
    this.api.changeRole(m.membershipId, role).subscribe({
      next: () => {
        this.ok(`${m.displayName} is now ${this.labels[role]}.`);
        if (m.isMe) void this.auth.refresh();
      },
      error: (e: unknown) => {
        this.fail(e);
        this.load();
      },
    });
  }
  protected remove(m: Member): void {
    if (!confirm(m.isMe ? 'Leave this organization?' : `Remove ${m.displayName} from the organization?`)) return;
    this.api.removeMember(m.membershipId).subscribe({
      next: () => {
        if (m.isMe) void this.auth.refresh().then(() => this.router.navigate(['/app']));
        else this.ok(`${m.displayName} was removed.`);
      },
      error: (e: unknown) => this.fail(e),
    });
  }
}
