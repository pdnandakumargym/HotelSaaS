import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CONNECTION_STATUS, ConnectionStatus } from '../../../core/api/channel-api.service';
import { errorMessage } from '../../../core/api/error-message';
import { IntegrationsApi, OwnerChannels, OwnerProviderState } from '../../../core/api/integrations-api.service';
import { extractRows } from '../../../shared/ui/json-table/json-table';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

const STATE: Record<OwnerProviderState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info'; text: string }> = {
  available: { label: 'Available', tone: 'success', text: 'StaySync can reach Zodomus. Connect a property to Booking.com on the mapping page.' },
  unavailable: { label: 'Temporarily unavailable', tone: 'warning', text: 'The latest platform call to Zodomus failed. The platform team sees this in the admin console; please try again later.' },
  not_verified: { label: 'Not verified yet', tone: 'info', text: 'The platform connection to Zodomus has not been tested yet.' },
  not_configured: { label: 'Not configured', tone: 'neutral', text: 'The channel manager is not set up on this platform yet.' },
};

/** Best-effort display name for one entry of the (undocumented) channel list. */
function channelName(row: Record<string, unknown>): string {
  for (const key of ['name', 'channelName', 'description', 'title', 'channel']) {
    const v = row[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  const id = row['id'] ?? row['channelId'] ?? row['value'];
  return id !== undefined ? `Channel ${String(id)}` : 'Unnamed channel';
}

@Component({
  selector: 'ss-channels',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Channel connections</h1>
        <p class="ss-muted">Connect your properties to booking channels through the Zodomus channel manager.</p>
      </div>
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    @if (data(); as d) {
      <div class="grid">
        <section class="ss-card">
          <h2 class="ss-card__title">Channel manager <ss-status-pill [tone]="state().tone">{{ state().label }}</ss-status-pill></h2>
          <p>{{ state().text }}</p>
          <p class="ss-muted small">Provider: {{ d.provider.displayName }} · {{ d.provider.environment === 'sandbox' ? 'Sandbox (test mode, no real bookings)' : 'Production' }}</p>
        </section>
        <section class="ss-card">
          <h2 class="ss-card__title">Plan</h2>
          <p class="big">{{ d.plan.channelsInUse }} / {{ d.plan.maxChannels }} <small>channels connected</small></p>
          <p class="ss-muted small">Your {{ d.plan.code }} plan includes up to {{ d.plan.maxChannels }} channels. <a routerLink="/app/billing">See plans</a></p>
        </section>
      </div>

      <section class="ss-card">
        <h2 class="ss-card__title">Your properties</h2>
        @if (d.properties.length) {
          <div class="ss-table-wrap">
            <table class="ss-table">
              <thead><tr><th scope="col">Property</th><th scope="col">Status</th><th scope="col">Channel connections</th></tr></thead>
              <tbody>
                @for (p of d.properties; track p.id) {
                  <tr>
                    <td><a [routerLink]="['/app/properties', p.id]">{{ p.name }}</a></td>
                    <td>{{ p.status }}</td>
                    <td>
                      @for (c of p.connections; track c.id) {
                        <a class="conn" [routerLink]="['/app/mapping']" [queryParams]="{ property: p.id }"><ss-status-pill [tone]="connTone(c.status)">{{ c.channelName }} · {{ connLabel(c.status) }}</ss-status-pill></a>
                      } @empty {
                        <a [routerLink]="['/app/mapping']" [queryParams]="{ property: p.id }"><ss-status-pill tone="neutral">Not connected</ss-status-pill></a>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="ss-muted">Add a property first. <a routerLink="/app/properties/new">Create a property</a></p>
        }
        <p class="ss-muted small">
          A property is "Connected" only after its Booking.com rooms and rates are mapped. Availability and rates are then sent automatically
          whenever you change them in the inventory calendar.
        </p>
      </section>

      <section class="ss-card">
        <h2 class="ss-card__title">Channels offered through Zodomus</h2>
        @if (channels(); as list) {
          @if (list.length) {
            <ul class="chips">@for (c of list; track $index) { <li>{{ c }}</li> }</ul>
          } @else {
            <p class="ss-muted">Zodomus returned an empty channel list.</p>
          }
          <p class="ss-muted small">
            List as reported by Zodomus{{ d.availableChannels?.fetchedAt ? ' on ' + (d.availableChannels!.fetchedAt | date: 'mediumDate') : '' }}.
            Availability of each channel depends on Zodomus certification and the channel's own approval of your property.
          </p>
        } @else {
          <p class="ss-muted">The channel list has not been loaded from Zodomus yet.</p>
        }
      </section>
    }
  `,
  styles: `
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
    section.ss-card { margin-bottom: 16px; }
    .big { font-size: 24px; font-weight: 700; margin: 0 0 6px; }
    .big small { font-size: 13px; font-weight: 500; color: var(--ss-text-muted); }
    .small { font-size: 12.5px; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 0; margin: 0 0 8px; }
    .chips li { border: 1px solid var(--ss-border); border-radius: 999px; padding: 4px 12px; font-size: 13px; background: var(--ss-surface); }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  `,
})
export class Channels implements OnInit {
  protected connLabel(s: ConnectionStatus): string {
    return CONNECTION_STATUS[s].label;
  }
  protected connTone(s: ConnectionStatus) {
    return CONNECTION_STATUS[s].tone;
  }
  private readonly api = inject(IntegrationsApi);
  protected readonly data = signal<OwnerChannels | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly state = computed(() => STATE[this.data()?.provider.state ?? 'not_configured']);
  protected readonly channels = computed(() => {
    const ac = this.data()?.availableChannels;
    if (!ac) return null;
    const rows = extractRows(ac.items);
    return rows ? rows.map(channelName) : null;
  });

  ngOnInit(): void {
    this.api.ownerChannels().subscribe({ next: (d) => this.data.set(d), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }
}
