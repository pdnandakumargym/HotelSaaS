import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'ss-not-found',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <main class="wrap">
      <h1>Page not found</h1>
      <p class="ss-muted">The page you are looking for does not exist.</p>
      <a class="ss-btn" routerLink="/app">Go to dashboard</a>
    </main>
  `,
  styles: `.wrap { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 24px; }`,
})
export class NotFound {}
