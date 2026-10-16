import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { API_BASE } from '../../../core/api/api.config';
import { errorMessage } from '../../../core/api/error-message';
import { AuthService } from '../../../core/auth/auth.service';
import { Icon } from '../../../shared/ui/icon/icon';
import { takeFragmentToken } from '../fragment-token';

@Component({
  selector: 'ss-confirm-email',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon],
  template: `
    <main class="ss-auth-page">
      <section class="ss-auth-card" aria-live="polite">
        <div class="ss-auth-brand"><ss-icon name="logo" [size]="20" /> StaySync</div>
        @switch (status()) {
          @case ('working') { <h1>Confirming…</h1> }
          @case ('done') {
            <h1>Email address changed</h1>
            <p class="ss-muted">For your security you were signed out everywhere. Sign in with your new address.</p>
            <a class="ss-btn ss-btn--block" routerLink="/login">Sign in</a>
          }
          @default {
            <h1>Link not valid</h1>
            <p class="ss-alert ss-alert--error">{{ error() }}</p>
            <a class="ss-btn ss-btn--block" routerLink="/app/settings">Back to settings</a>
          }
        }
      </section>
    </main>
  `,
})
export class ConfirmEmail implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  protected readonly status = signal<'working' | 'done' | 'failed'>('working');
  protected readonly error = signal('This link is invalid or has expired.');

  ngOnInit(): void {
    const token = takeFragmentToken();
    if (!token) {
      this.status.set('failed');
      return;
    }
    this.http.post(`${API_BASE}/auth/email/confirm`, { token }).subscribe({
      next: () => {
        this.auth.markSignedOut();
        this.status.set('done');
      },
      error: (e: unknown) => {
        this.error.set(errorMessage(e));
        this.status.set('failed');
      },
    });
  }
}
