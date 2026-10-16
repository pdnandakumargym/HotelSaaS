import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { errorMessage } from '../../../core/api/error-message';
import { homeFor } from '../../../core/auth/auth.guards';
import { TotpSetup } from '../../../core/auth/auth.models';
import { AuthService } from '../../../core/auth/auth.service';
import { StepUpService } from '../../../core/auth/step-up.service';
import { Icon } from '../../../shared/ui/icon/icon';

/** TOTP enrollment: scan QR -> confirm code -> save recovery codes. */
@Component({
  selector: 'ss-two-factor-setup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ReactiveFormsModule, Icon],
  template: `
    <main class="ss-auth-page">
      <section class="ss-auth-card wide" aria-live="polite">
        <div class="ss-auth-brand"><ss-icon name="shield" [size]="20" /> Two-factor authentication</div>

        @if (codes(); as list) {
          <h1>Save your recovery codes</h1>
          <p class="ss-muted">If you lose your phone, each code lets you sign in once. Store them somewhere safe, like a password manager. They will not be shown again.</p>
          <ul class="ss-codes">
            @for (c of list; track c) { <li>{{ c }}</li> }
          </ul>
          <div class="row">
            <button type="button" class="ss-btn ss-btn--ghost" (click)="copy(list)">{{ copied() ? 'Copied' : 'Copy' }}</button>
            <button type="button" class="ss-btn ss-btn--ghost" (click)="download(list)">Download .txt</button>
          </div>
          <label class="confirm"><input type="checkbox" (change)="saved.set($any($event.target).checked)" /> I have saved my recovery codes</label>
          <button type="button" class="ss-btn ss-btn--block" [disabled]="!saved()" (click)="finish()">Continue</button>
        } @else {
          <h1>{{ required() ? 'Set up two-factor authentication' : 'Turn on two-factor authentication' }}</h1>
          @if (required()) {
            <p class="ss-alert ss-alert--warning">Your account requires two-factor authentication before you can continue.</p>
          }
          <ol class="steps">
            <li>Install an authenticator app (for example Microsoft Authenticator, Google Authenticator or 1Password).</li>
            <li>Scan this QR code, or enter the key manually.</li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>

          @if (setup(); as s) {
            <div class="qr">
              <img [src]="s.qrDataUrl" width="200" height="200" alt="QR code for your authenticator app" />
              <details>
                <summary>Can't scan? Enter this key</summary>
                <code class="secret">{{ grouped() }}</code>
              </details>
            </div>
            <form (ngSubmit)="enable()" novalidate>
              <label class="ss-field"><span>Code from the app</span>
                <input class="ss-input ss-input--code" [formControl]="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" />
              </label>
              @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
              <button class="ss-btn ss-btn--block" type="submit" [disabled]="busy()">{{ busy() ? 'Checking…' : 'Verify and turn on' }}</button>
            </form>
          } @else {
            @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
            <button type="button" class="ss-btn ss-btn--block" (click)="start()" [disabled]="busy()">{{ busy() ? 'Preparing…' : 'Show QR code' }}</button>
          }
          <p class="ss-auth-foot">
            @if (required()) {
              <button type="button" class="ss-link-btn" (click)="signOut()">Sign out</button>
            } @else {
              <button type="button" class="ss-link-btn" (click)="back()">Cancel</button>
            }
          </p>
        }
      </section>
    </main>
  `,
  styles: `
    .wide { max-width: 480px; }
    .steps { padding-left: 18px; color: var(--ss-text-muted); font-size: 13.5px; }
    .steps li { margin: 4px 0; }
    .qr { display: flex; flex-direction: column; align-items: center; gap: 8px; margin: 12px 0 16px; }
    .qr img { border: 1px solid var(--ss-border); border-radius: 8px; image-rendering: pixelated; }
    .secret { display: block; margin-top: 6px; font-size: 14px; word-break: break-all; background: var(--ss-gray-50); padding: 8px; border-radius: 6px; }
    summary { cursor: pointer; font-size: 13px; color: var(--ss-blue-600); }
    .row { display: flex; gap: 8px; margin-bottom: 12px; }
    .confirm { display: flex; gap: 8px; align-items: center; margin: 8px 0 14px; font-size: 13.5px; }
  `,
})
export class TwoFactorSetup implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly stepUp = inject(StepUpService);
  private readonly router = inject(Router);
  protected readonly setup = signal<TotpSetup | null>(null);
  protected readonly codes = signal<string[] | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal(false);
  protected readonly copied = signal(false);
  protected readonly code = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\d{6}$/)] });
  protected readonly required = computed(() => this.auth.state() === 'mfa_enrollment_required');
  protected readonly grouped = computed(() => this.setup()?.secret.replace(/(.{4})/g, '$1 ').trim() ?? '');

  ngOnInit(): void {
    if (this.required()) this.start();
  }

  protected start(): void {
    this.busy.set(true);
    this.error.set(null);
    this.stepUp.run(() => this.auth.setupTotp()).subscribe({
      next: (s) => {
        this.busy.set(false);
        this.setup.set(s);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(err));
      },
    });
  }

  protected enable(): void {
    if (this.code.invalid) {
      this.error.set('Enter the 6-digit code.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.auth.enableTotp(this.code.value).subscribe({
      next: (codes) => {
        this.busy.set(false);
        this.setup.set(null); // drop the secret from memory
        this.codes.set(codes);
        void this.auth.refresh();
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.code.reset();
        this.error.set(errorMessage(err));
      },
    });
  }

  protected copy(list: string[]): void {
    void navigator.clipboard?.writeText(list.join('\n')).then(() => this.copied.set(true));
  }

  protected download(list: string[]): void {
    const blob = new Blob([`StaySync recovery codes\nEach code works once.\n\n${list.join('\n')}\n`], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'staysync-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  protected finish(): void {
    this.codes.set(null);
    void this.auth.refresh().then(() => this.router.navigateByUrl(homeFor(this.auth) === '/app' ? '/app/settings' : homeFor(this.auth)));
  }

  protected back(): void {
    void this.router.navigate(['/app/settings']);
  }

  protected signOut(): void {
    this.auth.logout().subscribe(() => void this.router.navigate(['/login']));
  }
}
