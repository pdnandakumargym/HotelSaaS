import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { AuthService } from '../../../core/auth/auth.service';
import { Icon } from '../../../shared/ui/icon/icon';

@Component({
  selector: 'ss-forgot-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ReactiveFormsModule, RouterLink, Icon],
  template: `
    <main class="ss-auth-page">
      <form class="ss-auth-card" (ngSubmit)="submit()" novalidate aria-labelledby="fp-title">
        <div class="ss-auth-brand"><ss-icon name="logo" [size]="20" /> StaySync</div>
        <h1 id="fp-title">Reset your password</h1>
        @if (sent()) {
          <p class="ss-alert ss-alert--success" role="status">If an account exists for that address, we sent a reset link. It expires in 30 minutes.</p>
        } @else {
          <p class="ss-muted">Enter your email and we will send you a link to choose a new password.</p>
          <label class="ss-field"><span>Email address</span>
            <input class="ss-input" type="email" [formControl]="email" autocomplete="email" />
          </label>
          @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
          <button class="ss-btn ss-btn--block" type="submit" [disabled]="busy()">Send reset link</button>
        }
        <p class="ss-auth-foot"><a routerLink="/login">Back to sign in</a></p>
      </form>
    </main>
  `,
})
export class ForgotPassword {
  private readonly auth = inject(AuthService);
  protected readonly email = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] });
  protected readonly sent = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected submit(): void {
    if (this.email.invalid) {
      this.error.set('Enter a valid email address.');
      return;
    }
    this.busy.set(true);
    this.auth.forgotPassword(this.email.value).subscribe({
      next: () => this.sent.set(true),
      error: (err: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }
}
