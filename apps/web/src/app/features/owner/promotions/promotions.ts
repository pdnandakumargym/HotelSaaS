import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ChannelApi, ChannelConnection } from '../../../core/api/channel-api.service';
import { errorMessage } from '../../../core/api/error-message';
import { ChannelPromotion, PromotionsApi } from '../../../core/api/ops-api.service';
import { Property } from '../../../core/api/org-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { PropertyPicker } from '../../../shared/ui/property-picker/property-picker';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

/** Booking.com promotions through Zodomus: view with results, switch on or off. */
@Component({
  selector: 'ss-promotions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PropertyPicker, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Discounts &amp; promotions</h1>
        <p class="ss-muted">Booking.com promotions of this property, with bookings and revenue they brought. Switch them on or off here.</p>
      </div>
      <ss-property-picker (changed)="onProperty($event)" />
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    @if (notice(); as n) { <p class="ss-alert ss-alert--success" role="status">{{ n }}</p> }

    @if (loadedConnection()) {
      @if (connection(); as c) {
        @if (c.status !== 'ACTIVE') {
          <p class="ss-alert ss-alert--info">Promotions are available once the {{ c.channelName }} connection is active. <a routerLink="/app/mapping" [queryParams]="{ property: c.propertyId }">Finish the connection</a></p>
        } @else {
          @if (c.environment === 'sandbox') { <p class="ss-alert ss-alert--info">Test mode (Zodomus sandbox): the promotions shown are Zodomus sample data.</p> }
          <section class="ss-card">
            <div class="tabs" role="tablist" aria-label="Promotion status">
              <button type="button" role="tab" [attr.aria-selected]="active()" [class.on]="active()" (click)="setTab(true)">Active</button>
              <button type="button" role="tab" [attr.aria-selected]="!active()" [class.on]="!active()" (click)="setTab(false)">Inactive</button>
            </div>
            @for (p of items(); track p.id) {
              <article class="promo">
                <div class="top">
                  <div>
                    <strong>{{ p.name ?? 'Promotion ' + p.id }}</strong>
                    @if (p.type) { <span class="ss-muted small"> · {{ p.type }}</span> }
                    @if (p.discount) { <ss-status-pill tone="info">{{ p.discount }}% off</ss-status-pill> }
                    @if (p.nonRefundable) { <ss-status-pill tone="neutral">Non-refundable</ss-status-pill> }
                  </div>
                  @if (canManage()) {
                    <button type="button" class="ss-btn ss-btn--ghost" (click)="toggle(c, p)" [disabled]="busy()">
                      {{ confirm() === p.id ? 'Click again to confirm' : active() ? 'Deactivate' : 'Activate' }}
                    </button>
                  }
                </div>
                <dl>
                  <dt>Stay dates</dt><dd>{{ range(p.stayFrom, p.stayTo) }}</dd>
                  <dt>Booking dates</dt><dd>{{ range(p.bookFrom, p.bookTo) }}</dd>
                  @if (p.minStayThrough) { <dt>Minimum stay</dt><dd>{{ p.minStayThrough }} nights</dd> }
                  <dt>Rooms</dt><dd>{{ p.roomIds.length ? p.roomIds.join(', ') : 'All / not specified' }}</dd>
                  <dt>Results</dt><dd>{{ p.stats.bookings ?? 0 }} bookings · {{ p.stats.roomNights ?? 0 }} room nights · {{ p.stats.cancellations ?? 0 }} cancellations@if (p.stats.revenue) { · {{ p.stats.currency }} {{ p.stats.revenue }} }</dd>
                </dl>
              </article>
            } @empty {
              @if (loaded()) { <p class="ss-muted empty">No {{ active() ? 'active' : 'inactive' }} promotions.</p> }
            }
            <p class="ss-muted small">New promotions are created in the Booking.com extranet. Zodomus does not document the values its "create promotion" call accepts, so StaySync does not create them.</p>
          </section>
        }
      } @else {
        <p class="ss-alert ss-alert--info">This property is not connected to Booking.com. <a routerLink="/app/mapping">Connect Booking.com</a></p>
      }
    }
  `,
  styles: `
    .tabs { display: inline-flex; border: 1px solid var(--ss-border); border-radius: var(--ss-radius-sm); overflow: hidden; margin-bottom: 12px; }
    .tabs button { border: 0; background: transparent; padding: 7px 14px; cursor: pointer; font: inherit; color: var(--ss-text-muted); }
    .tabs button.on { background: var(--ss-blue-50); color: var(--ss-blue-600); font-weight: 600; }
    .promo { border: 1px solid var(--ss-border); border-radius: var(--ss-radius-sm); padding: 12px; margin-bottom: 10px; }
    .top { display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap; }
    .top ss-status-pill { margin-left: 6px; }
    dl { display: grid; grid-template-columns: 130px 1fr; gap: 4px 12px; margin: 10px 0 0; font-size: 13.5px; }
    dt { color: var(--ss-text-muted); }
    dd { margin: 0; }
    .small { font-size: 12.5px; }
    .empty { padding: 12px 0; }
  `,
})
export class Promotions {
  private readonly api = inject(PromotionsApi);
  private readonly channels = inject(ChannelApi);
  private readonly auth = inject(AuthService);
  protected readonly connection = signal<ChannelConnection | null>(null);
  protected readonly loadedConnection = signal(false);
  protected readonly items = signal<ChannelPromotion[]>([]);
  protected readonly loaded = signal(false);
  protected readonly active = signal(true);
  protected readonly busy = signal(false);
  protected readonly confirm = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly canManage = computed(() => this.auth.hasOrgPermission('channel.manage'));

  onProperty(p: Property): void {
    this.loadedConnection.set(false);
    this.items.set([]);
    this.channels.connections(p.id).subscribe({
      next: (list) => {
        const c = list.find((x) => x.status !== 'DISCONNECTED') ?? null;
        this.connection.set(c);
        this.loadedConnection.set(true);
        if (c?.status === 'ACTIVE') this.load();
      },
      error: (e: unknown) => this.error.set(errorMessage(e)),
    });
  }

  protected setTab(active: boolean): void {
    this.active.set(active);
    this.load();
  }

  load(): void {
    const c = this.connection();
    if (!c) return;
    this.loaded.set(false);
    this.error.set(null);
    this.api.list(c.propertyId, c.id, this.active()).subscribe({
      next: (p) => {
        this.items.set(p);
        this.loaded.set(true);
      },
      error: (e: unknown) => {
        this.loaded.set(true);
        this.error.set(errorMessage(e));
      },
    });
  }

  protected toggle(c: ChannelConnection, p: ChannelPromotion): void {
    if (this.confirm() !== p.id) {
      this.confirm.set(p.id);
      return;
    }
    this.confirm.set(null);
    this.busy.set(true);
    this.notice.set(null);
    const activate = !this.active();
    this.api.setActive(c.propertyId, c.id, p.id, activate).subscribe({
      next: () => {
        this.busy.set(false);
        this.notice.set(`${p.name ?? 'Promotion'} ${activate ? 'activated' : 'deactivated'} on ${c.channelName}.`);
        this.load();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }

  protected range(from: string | null, to: string | null): string {
    return from || to ? `${from ?? '…'} – ${to ?? '…'}` : 'Not specified';
  }
}
