import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { AuthService } from '../../../core/auth/auth.service';
import { Icon } from '../../../shared/ui/icon/icon';
import { takeFragmentToken } from '../fragment-token';

@Component({
  selector: 'ss-verify-email',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FormsModule, ReactiveFormsModule, Icon],
  template: `
    <main class="ss-auth-page">
      <section class="ss-auth-card" aria-live="polite">
        <div class="ss-auth-brand"><ss-icon name="logo" [size]="20" /> StaySync</div>
        @switch (status()) {
          @case ('verifying') { <h1>Verifying…</h1> }
          @case ('verified') {
            <h1>Email verified</h1>
            <p class="ss-muted">Your account is active. You can sign in now.</p>
            <a class="ss-btn ss-btn--block" routerLink="/login">Sign in</a>
          }
          @default {
            <h1>Link not valid</h1>
            <p class="ss-alert ss-alert--error">{{ error() }}</p>
            <form (ngSubmit)="resend()">
              <label class="ss-field"><span>Send a new link to</span>
                <input class="ss-input" type="email" [formControl]="email" autocomplete="email" />
              </label>
              <button class="ss-btn ss-btn--block" type="submit" [disabled]="email.invalid">Send new link</button>
            </form>
            @if (sent()) { <p class="ss-alert ss-alert--info">If that address needs verifying, a new link is on its way.</p> }
          }
        }
      </section>
    </main>
  `,
})
export class VerifyEmail implements OnInit {
  private readonly auth = inject(AuthService);
  protected readonly status = signal<'verifying' | 'verified' | 'failed'>('verifying');
  protected readonly error = signal('This link is invalid or has expired.');
  protected readonly sent = signal(false);
  protected readonly email = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] });

  ngOnInit(): void {
    const token = takeFragmentToken();
    if (!token) {
      this.status.set('failed');
      return;
    }
    this.auth.verifyEmail(token).subscribe({
      next: () => this.status.set('verified'),
      error: (err: unknown) => {
        this.error.set(errorMessage(err));
        this.status.set('failed');
      },
    });
  }

  protected resend(): void {
    this.auth.resendVerification(this.email.value).subscribe({ next: () => this.sent.set(true), error: () => this.sent.set(true) });
  }
}
