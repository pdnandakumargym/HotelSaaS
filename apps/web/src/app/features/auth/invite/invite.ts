import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { API_BASE } from '../../../core/api/api.config';
import { errorMessage } from '../../../core/api/error-message';
import { ROLE_LABELS, OrgRole } from '../../../core/auth/auth.models';
import { AuthService } from '../../../core/auth/auth.service';
import { Icon } from '../../../shared/ui/icon/icon';
import { takeFragmentToken } from '../fragment-token';

interface Preview {
  organizationName: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
  accountExists: boolean;
}

const STORAGE_KEY = 'ss_pending_invite';

/** Accept an invitation: sign in as the invited address, or create an account. */
@Component({
  selector: 'ss-invite',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ReactiveFormsModule, RouterLink, Icon],
  template: `
    <main class="ss-auth-page">
      <section class="ss-auth-card">
        <div class="ss-auth-brand"><ss-icon name="users" [size]="20" /> Team invitation</div>
        @if (error(); as e) {
          <h1>Invitation not valid</h1>
          <p class="ss-alert ss-alert--error">{{ e }}</p>
          <a class="ss-btn ss-btn--block" routerLink="/login">Go to sign in</a>
        } @else if (preview(); as p) {
          <h1>Join {{ p.organizationName }}</h1>
          <p class="ss-muted">You were invited as <strong>{{ labels[p.role] }}</strong> using <strong>{{ p.email }}</strong>.</p>
          @if (auth.state() === 'authenticated' || auth.state() === 'mfa_enrollment_required') {
            @if (auth.user()?.email === p.email) {
              <button class="ss-btn ss-btn--block" type="button" (click)="accept()" [disabled]="busy()">Accept invitation</button>
            } @else {
              <p class="ss-alert ss-alert--warning">You are signed in as {{ auth.user()?.email }}. Sign out and sign in as {{ p.email }} to accept.</p>
              <button class="ss-btn ss-btn--ghost ss-btn--block" type="button" (click)="signOut()">Sign out</button>
            }
          } @else if (p.accountExists) {
            <p>You already have an account. Sign in, and we will bring you back here to accept.</p>
            <a class="ss-btn ss-btn--block" routerLink="/login" [queryParams]="{ returnUrl: '/invite' }">Sign in to accept</a>
          } @else {
            <form [formGroup]="form" (ngSubmit)="register()" novalidate>
              <label class="ss-field"><span>Your name</span><input class="ss-input" formControlName="displayName" autocomplete="name" /></label>
              <label class="ss-field"><span>Choose a password</span><input class="ss-input" type="password" formControlName="password" autocomplete="new-password" /><small class="ss-muted">At least 12 characters.</small></label>
              <button class="ss-btn ss-btn--block" type="submit" [disabled]="busy()">Create account and join</button>
            </form>
          }
          @if (actionError(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
        } @else {
          <h1>Checking invitation…</h1>
        }
      </section>
    </main>
  `,
})
export class Invite implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly labels = ROLE_LABELS;
  protected readonly preview = signal<Preview | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly form = this.fb.group({ displayName: ['', Validators.required], password: ['', [Validators.required, Validators.minLength(12)]] });
  private token: string | null = null;

  ngOnInit(): void {
    // The token survives a sign-in round trip in sessionStorage (this tab only), never in the URL.
    this.token = takeFragmentToken() ?? this.readStored();
    if (!this.token) {
      this.error.set('This invitation link is missing or malformed.');
      return;
    }
    this.store(this.token);
    this.http.post<{ data: Preview }>(`${API_BASE}/invitations/preview`, { token: this.token }).subscribe({
      next: (r) => this.preview.set(r.data),
      error: (e: unknown) => {
        this.clearStored();
        this.error.set(errorMessage(e));
      },
    });
  }

  protected accept(): void {
    this.busy.set(true);
    this.http.post(`${API_BASE}/invitations/accept`, { token: this.token }).subscribe({
      next: () => this.done(),
      error: (e: unknown) => {
        this.busy.set(false);
        this.actionError.set(errorMessage(e));
      },
    });
  }

  protected register(): void {
    if (this.form.invalid) {
      this.actionError.set('Enter your name and a password of at least 12 characters.');
      return;
    }
    this.busy.set(true);
    this.http.post(`${API_BASE}/invitations/register`, { token: this.token, ...this.form.getRawValue() }).subscribe({
      next: () => this.done(),
      error: (e: unknown) => {
        this.busy.set(false);
        this.form.controls.password.reset();
        this.actionError.set(errorMessage(e));
      },
    });
  }

  protected signOut(): void {
    this.auth.logout().subscribe(() => void this.router.navigate(['/login'], { queryParams: { returnUrl: '/invite' } }));
  }

  private done(): void {
    this.clearStored();
    void this.auth.refresh().then(() => this.router.navigate([this.auth.state() === 'mfa_enrollment_required' ? '/security/two-factor-setup' : '/app']));
  }

  private readStored(): string | null {
    try {
      return sessionStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }
  private store(t: string): void {
    try {
      sessionStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* storage unavailable */
    }
  }
  private clearStored(): void {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
  }
}
