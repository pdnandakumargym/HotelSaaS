import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { HealthService, SystemStatus } from '../../../core/health/health.service';
import { Icon } from '../../../shared/ui/icon/icon';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

/** Live API + PostgreSQL status, read from /api/v1/health and /api/v1/health/ready. */
@Component({
  selector: 'ss-system-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusPill, Icon, DatePipe],
  template: `
    <section class="ss-card" aria-labelledby="sys-title">
      <h2 class="ss-card__title" id="sys-title">
        System status
        <button type="button" class="ss-btn ss-btn--ghost refresh" (click)="refresh()" [disabled]="loading()">
          <ss-icon name="refresh" [size]="15" /> {{ loading() ? 'Checking…' : 'Recheck' }}
        </button>
      </h2>

      @let s = status();
      @if (!s) {
        <p class="ss-muted" role="status">Checking services…</p>
      } @else {
        <ul class="rows" role="status">
          <li>
            <span class="name"><ss-icon name="server" [size]="16" /> API</span>
            @if (s.state === 'unreachable') {
              <ss-status-pill tone="danger">Unreachable</ss-status-pill>
            } @else {
              <ss-status-pill tone="success">Healthy</ss-status-pill>
            }
          </li>
          <li>
            <span class="name"><ss-icon name="database" [size]="16" /> PostgreSQL</span>
            @if (s.state === 'unreachable') {
              <ss-status-pill tone="neutral">Unknown</ss-status-pill>
            } @else if (s.readiness.checks.database.status === 'up') {
              <ss-status-pill tone="success">Healthy · {{ s.readiness.checks.database.latencyMs }} ms</ss-status-pill>
            } @else {
              <ss-status-pill tone="danger">Down</ss-status-pill>
            }
          </li>
          <li>
            <span class="name"><ss-icon name="plug" [size]="16" /> Zodomus channel manager</span>
            <ss-status-pill tone="neutral">Not configured · Milestone 4</ss-status-pill>
          </li>
        </ul>
        @if (s.state === 'unreachable') {
          <p class="error">{{ s.error.message }}</p>
        } @else {
          <p class="meta ss-muted">
            {{ s.liveness.service }} v{{ s.liveness.version }} · {{ s.liveness.environment }} · checked {{ s.checkedAt | date: 'mediumTime' }}
          </p>
        }
      }
    </section>
  `,
  styles: `
    .rows { list-style: none; margin: 0; padding: 0; }
    .rows li { display: flex; justify-content: space-between; align-items: center; gap: 12px;
      padding: 9px 0; border-bottom: 1px solid var(--ss-border); }
    .rows li:last-child { border-bottom: 0; }
    .name { display: inline-flex; align-items: center; gap: 8px; }
    .refresh { height: 30px; padding: 0 10px; font-size: 12.5px; }
    .meta { font-size: 12px; margin: 10px 0 0; }
    .error { color: var(--ss-red-600); font-size: 13px; margin: 10px 0 0; }
  `,
})
export class SystemStatusCard implements OnInit {
  private readonly health = inject(HealthService);
  protected readonly status = signal<SystemStatus | null>(null);
  protected readonly loading = signal(false);

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    this.health.getSystemStatus().subscribe((s) => {
      this.status.set(s);
      this.loading.set(false);
    });
  }
}
