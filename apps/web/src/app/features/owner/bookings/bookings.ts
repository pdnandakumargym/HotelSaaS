import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ChannelApi, ChannelConnection } from '../../../core/api/channel-api.service';
import { errorMessage } from '../../../core/api/error-message';
import { OpsApi, ReservationDetail, ReservationStatus, ReservationSummary } from '../../../core/api/ops-api.service';
import { Property } from '../../../core/api/org-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { Pager } from '../../../shared/ui/pager';
import { PropertyPicker } from '../../../shared/ui/property-picker/property-picker';
import { PillTone, StatusPill } from '../../../shared/ui/status-pill/status-pill';

const PAGE = 25;
export const RESERVATION_STATUS: Record<ReservationStatus, { label: string; tone: PillTone }> = {
  CONFIRMED: { label: 'Confirmed', tone: 'success' },
  MODIFIED: { label: 'Modified', tone: 'info' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

/** Unified bookings received from connected channels. Nothing is shown that the channel did not send. */
@Component({
  selector: 'ss-bookings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, RouterLink, Pager, PropertyPicker, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Bookings</h1>
        <p class="ss-muted">Reservations received from your connected channels. New, changed and cancelled bookings are fetched automatically every minute.</p>
      </div>
      <ss-property-picker (changed)="onProperty($event)" />
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    @if (notice(); as n) { <p class="ss-alert ss-alert--success" role="status">{{ n }}</p> }

    @if (property()) {
      @if (connection(); as c) {
        @if (c.environment === 'sandbox') {
          <p class="ss-alert ss-alert--info">Test mode (Zodomus sandbox): bookings here are test bookings created by Zodomus, not real guests.</p>
        }
        @if (canManage() && c.status === 'ACTIVE') {
          <section class="ss-card actions">
            <div class="row">
              <button type="button" class="ss-btn" (click)="poll(c)" [disabled]="busy()">{{ busy() ? 'Working…' : 'Fetch new bookings now' }}</button>
              <button type="button" class="ss-btn ss-btn--ghost" (click)="importSummary(c)" [disabled]="busy()">Import bookings made before connecting</button>
            </div>
            @if (c.environment === 'sandbox') {
              <form class="row test" (ngSubmit)="createTest(c)">
                <strong>Create a test booking</strong>
                <label class="ss-field inline"><span>Type</span>
                  <select class="ss-input" name="testStatus" [(ngModel)]="testStatus">
                    <option value="new">New booking</option>
                    <option value="modified">Modification</option>
                    <option value="cancelled">Cancellation</option>
                  </select>
                </label>
                <label class="ss-field inline"><span>Booking number (optional)</span>
                  <input class="ss-input" name="testId" [(ngModel)]="testId" inputmode="numeric" pattern="[0-9]*" maxlength="20" placeholder="Zodomus picks one" />
                </label>
                <button type="submit" class="ss-btn ss-btn--ghost" [disabled]="busy()">Create test booking</button>
              </form>
            }
          </section>
        } @else if (c.status !== 'ACTIVE') {
          <p class="ss-alert ss-alert--info">{{ c.channelName }} is not fully connected yet, so no bookings can arrive. Finish the connection on <a routerLink="/app/mapping" [queryParams]="{ property: c.propertyId }">Room &amp; Rate Mapping</a>.</p>
        }
      } @else if (loadedConnections()) {
        <p class="ss-alert ss-alert--info">This property is not connected to a channel, so there are no channel bookings. <a routerLink="/app/mapping">Connect Booking.com</a></p>
      }

      <section class="ss-card">
        <div class="filters">
          <div class="tabs" role="tablist" aria-label="Which bookings">
            @for (v of views; track v.value) {
              <button type="button" role="tab" [attr.aria-selected]="view() === v.value" [class.on]="view() === v.value" (click)="setView(v.value)">{{ v.label }}</button>
            }
          </div>
          <label class="ss-field inline"><span>Status</span>
            <select class="ss-input" [ngModel]="status()" (ngModelChange)="status.set($event); reload()" name="status">
              <option value="">All</option>
              <option value="CONFIRMED">Confirmed</option>
              <option value="MODIFIED">Modified</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </label>
          <label class="check"><input type="checkbox" [checked]="needsReview()" (change)="needsReview.set(!needsReview()); reload()" /> Needs review only</label>
          <form class="search" (ngSubmit)="reload()">
            <label class="ss-visually-hidden" for="bk-q">Booking number</label>
            <input id="bk-q" class="ss-input" name="q" [(ngModel)]="q" placeholder="Booking number" maxlength="64" />
            <button type="submit" class="ss-btn ss-btn--ghost">Search</button>
          </form>
        </div>
        @if (!guestsVisible()) { <p class="ss-muted small">Guest names are hidden for your role.</p> }

        @if (items().length) {
          <div class="ss-table-wrap">
            <table class="ss-table">
              <thead>
                <tr><th scope="col">Booking</th><th scope="col">Guest</th><th scope="col">Room</th><th scope="col">Check-in</th><th scope="col">Check-out</th><th scope="col">Nights</th><th scope="col">Guests</th><th scope="col" class="num">Total</th><th scope="col">Status</th></tr>
              </thead>
              <tbody>
                @for (r of items(); track r.id) {
                  <tr [class.sel]="selected()?.id === r.id" [class.cancelled]="r.status === 'CANCELLED'">
                    <td>
                      <button type="button" class="ss-link-btn" (click)="open(r)">{{ r.channelReservationId }}</button>
                      <div class="ss-muted small">{{ r.channelName }}@if (r.isTest) { · test }@if (r.source === 'SUMMARY') { · booked before connecting }</div>
                    </td>
                    <td>{{ guestsVisible() ? (r.guestName ?? '—') : 'Hidden' }}</td>
                    <td>{{ r.roomTypes.join(', ') || '—' }}@if (r.roomCount > 1) { <span class="ss-muted"> ×{{ r.roomCount }}</span> }</td>
                    <td>{{ r.checkIn ? (r.checkIn | date: 'EEE d MMM y') : '—' }}</td>
                    <td>{{ r.checkOut ? (r.checkOut | date: 'EEE d MMM y') : '—' }}</td>
                    <td>{{ r.nights ?? '—' }}</td>
                    <td>{{ r.guestCount ?? '—' }}</td>
                    <td class="num">{{ money(r.total, r.currency) }}</td>
                    <td>
                      <ss-status-pill [tone]="statusOf(r).tone">{{ statusOf(r).label }}</ss-status-pill>
                      @if (r.needsReview) { <ss-status-pill tone="danger" [attr.title]="r.reviewReason">Needs review</ss-status-pill> }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <ss-pager [page]="page()" [pageSize]="pageSize" [total]="total()" (go)="goTo($event)" />
        } @else if (loaded()) {
          <p class="ss-muted empty">No bookings match. Bookings appear here as soon as a connected channel sends them.</p>
        }
      </section>

      @if (selected(); as d) {
        <section class="ss-card detail" aria-labelledby="bk-detail">
          <div class="head">
            <h2 class="ss-card__title" id="bk-detail">{{ d.channelName }} booking {{ d.channelReservationId }}</h2>
            <button type="button" class="ss-btn ss-btn--ghost" (click)="selected.set(null)">Close</button>
          </div>
          <p>
            <ss-status-pill [tone]="statusOf(d).tone">{{ statusOf(d).label }}</ss-status-pill>
            @if (d.isTest) { <ss-status-pill tone="info">Test booking</ss-status-pill> }
            <span class="ss-muted small"> Received {{ d.receivedAt | date: 'medium' }}@if (d.version > 1) { · updated {{ d.updatedAt | date: 'medium' }} (version {{ d.version }}) }</span>
          </p>
          @if (d.needsReview) { <p class="ss-alert ss-alert--error">Needs review: {{ d.reviewReason }}</p> }
          @for (x of d.openDiscrepancies; track x.id) { <p class="ss-alert ss-alert--info">{{ x.message }} <a routerLink="/app/discrepancies">Open the Discrepancy Center</a></p> }

          <div class="grid">
            <div>
              <h3>Stay</h3>
              <dl>
                <dt>Check-in</dt><dd>{{ d.checkIn ? (d.checkIn | date: 'fullDate') : '—' }}</dd>
                <dt>Check-out</dt><dd>{{ d.checkOut ? (d.checkOut | date: 'fullDate') : '—' }}</dd>
                <dt>Nights</dt><dd>{{ d.nights ?? '—' }}</dd>
                <dt>Guests</dt><dd>{{ d.guestCount ?? '—' }}</dd>
                <dt>Total</dt><dd>{{ money(d.total, d.currency) }}</dd>
              </dl>
            </div>
            <div>
              <h3>Guest</h3>
              @if (d.guest; as g) {
                <dl>
                  <dt>Name</dt><dd>{{ fullName(g) || '—' }}</dd>
                  <dt>Email</dt><dd>{{ g.email ?? '—' }}</dd>
                  <dt>Phone</dt><dd>{{ g.phone ?? '—' }}</dd>
                  <dt>Address</dt><dd>{{ address(g) || '—' }}</dd>
                  @if (g.reservationRemarks) { <dt>Booking remarks</dt><dd>{{ g.reservationRemarks }}</dd> }
                  @if (g.customerRemarks) { <dt>Guest remarks</dt><dd>{{ g.customerRemarks }}</dd> }
                </dl>
                <p class="ss-muted small">Guest details are personal data. Viewing them is recorded in the audit log.</p>
              } @else if (!d.guestDetailsVisible) {
                <p class="ss-muted">Your role does not include guest details.</p>
              } @else {
                <p class="ss-muted">The channel sent no guest details.</p>
              }
            </div>
          </div>

          <h3>Rooms</h3>
          <div class="ss-table-wrap">
            <table class="ss-table">
              <thead><tr><th scope="col">Channel room</th><th scope="col">Your room type</th><th scope="col">Rate plan</th><th scope="col">Dates</th><th scope="col">Guests</th><th scope="col">Meal plan</th><th scope="col" class="num">Total</th><th scope="col">Inventory</th></tr></thead>
              <tbody>
                @for (rm of d.rooms; track rm.id) {
                  <tr>
                    <td>{{ rm.channelRoomName ?? 'Room' }} <span class="ss-muted small">{{ rm.channelRoomId }}</span></td>
                    <td>{{ rm.roomTypeName ?? 'Not mapped' }}</td>
                    <td>{{ rm.ratePlanName ?? (rm.channelRateId ? 'Rate ' + rm.channelRateId : '—') }}</td>
                    <td>{{ rm.checkIn ?? '?' }} → {{ rm.checkOut ?? '?' }}</td>
                    <td>{{ rm.guestCount ?? '—' }}</td>
                    <td>{{ rm.mealPlan ?? '—' }}</td>
                    <td class="num">{{ money(rm.total, d.currency) }}</td>
                    <td>{{ rm.occupiesInventory ? 'Deducted' : 'Not deducted' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="ss-muted small">Card details are never requested or stored by StaySync. Use the channel extranet for payments.</p>
        </section>
      }
    }
  `,
  styles: `
    .actions .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; }
    .actions .test { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--ss-border); }
    .filters { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 12px; }
    .tabs { display: inline-flex; border: 1px solid var(--ss-border); border-radius: var(--ss-radius-sm); overflow: hidden; }
    .tabs button { border: 0; background: transparent; padding: 7px 14px; cursor: pointer; font: inherit; color: var(--ss-text-muted); }
    .tabs button.on { background: var(--ss-blue-50); color: var(--ss-blue-600); font-weight: 600; }
    .inline { margin: 0; min-width: 160px; }
    .check { display: inline-flex; gap: 6px; align-items: center; font-size: 13.5px; height: 36px; }
    .search { display: flex; gap: 6px; margin-left: auto; }
    .search input { width: 180px; }
    .num { text-align: right; white-space: nowrap; }
    .small { font-size: 12.5px; }
    tr.sel td { background: var(--ss-blue-50); }
    tr.cancelled td { color: var(--ss-text-muted); }
    .empty { padding: 16px 0; }
    .detail .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    h3 { font-size: 14px; margin: 16px 0 8px; }
    dl { display: grid; grid-template-columns: 130px 1fr; gap: 4px 12px; margin: 0; font-size: 13.5px; }
    dt { color: var(--ss-text-muted); }
    dd { margin: 0; overflow-wrap: anywhere; }
  `,
})
export class Bookings {
  private readonly api = inject(OpsApi);
  private readonly channels = inject(ChannelApi);
  private readonly auth = inject(AuthService);
  protected readonly views = [
    { value: 'upcoming' as const, label: 'Upcoming & in-house' },
    { value: 'past' as const, label: 'Past' },
    { value: 'all' as const, label: 'All' },
  ];
  protected readonly pageSize = PAGE;
  protected readonly property = signal<Property | null>(null);
  protected readonly connection = signal<ChannelConnection | null>(null);
  protected readonly loadedConnections = signal(false);
  protected readonly items = signal<ReservationSummary[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly guestsVisible = signal(false);
  protected readonly loaded = signal(false);
  protected readonly selected = signal<ReservationDetail | null>(null);
  protected readonly view = signal<'upcoming' | 'past' | 'all'>('upcoming');
  protected readonly status = signal<ReservationStatus | ''>('');
  protected readonly needsReview = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly canManage = computed(() => this.auth.hasOrgPermission('channel.manage'));
  protected q = '';
  protected testStatus: 'new' | 'modified' | 'cancelled' = 'new';
  protected testId = '';

  onProperty(p: Property): void {
    this.property.set(p);
    this.selected.set(null);
    this.connection.set(null);
    this.loadedConnections.set(false);
    this.channels.connections(p.id).subscribe({
      next: (list) => {
        this.connection.set(list.find((c) => c.status !== 'DISCONNECTED') ?? null);
        this.loadedConnections.set(true);
      },
      error: () => this.loadedConnections.set(true),
    });
    this.reload();
  }

  protected setView(v: 'upcoming' | 'past' | 'all'): void {
    this.view.set(v);
    this.reload();
  }
  protected goTo(page: number): void {
    this.page.set(page);
    this.load();
  }
  reload(): void {
    this.page.set(1);
    this.load();
  }

  private load(): void {
    const p = this.property();
    if (!p) return;
    const q = this.q.trim();
    if (q && !/^[A-Za-z0-9_-]{1,64}$/.test(q)) {
      this.error.set('Search by booking number (letters, digits, - or _).');
      return;
    }
    this.error.set(null);
    this.api.reservations({ propertyId: p.id, view: this.view(), status: this.status(), needsReview: this.needsReview(), q: q || undefined, limit: PAGE, offset: (this.page() - 1) * PAGE }).subscribe({
      next: (r) => {
        this.items.set(r.items);
        this.total.set(r.total);
        this.guestsVisible.set(r.guestDetailsVisible);
        this.loaded.set(true);
      },
      error: (e: unknown) => {
        this.loaded.set(true);
        this.error.set(errorMessage(e));
      },
    });
  }

  protected open(r: ReservationSummary): void {
    this.api.reservation(r.id).subscribe({ next: (d) => this.selected.set(d), error: (e: unknown) => this.error.set(errorMessage(e)) });
  }

  protected poll(c: ChannelConnection): void {
    this.run(this.api.poll(c.propertyId, c.id), (r) => {
      if (!r.ok) this.error.set(r.error ?? 'Could not fetch bookings.');
      else this.notice.set(r.queued === 0 ? 'No new booking changes from the channel.' : `${r.stored} booking change(s) received${r.failed ? `, ${r.failed} could not be retrieved (see Discrepancy Center)` : ''}.`);
    });
  }
  protected importSummary(c: ChannelConnection): void {
    this.run(this.api.importSummary(c.propertyId, c.id), (r) => {
      if (!r.ok) this.error.set(r.error ?? 'Could not import earlier bookings.');
      else this.notice.set(r.stored ? `${r.stored} earlier booking(s) imported.` : 'No earlier bookings to import.');
    });
  }
  protected createTest(c: ChannelConnection): void {
    const id = this.testId.trim();
    if (id && !/^\d{1,20}$/.test(id)) {
      this.error.set('The test booking number must contain digits only.');
      return;
    }
    this.run(this.api.createTest(c.propertyId, c.id, { status: this.testStatus, ...(id ? { channelReservationId: id } : {}) }), (r) => {
      if (!r.result.ok) this.error.set(`Zodomus did not create the test booking${r.result.providerMessage ? `: ${r.result.providerMessage}` : r.result.error ? `: ${r.result.error}` : '.'}`);
      else this.notice.set(`Test booking requested. ${r.poll ? `${r.poll.stored} booking change(s) received.` : ''}`);
    });
  }

  protected statusOf(r: { status: ReservationStatus }) {
    return RESERVATION_STATUS[r.status];
  }
  protected money(v: number | null, currency: string | null): string {
    if (v === null || !currency) return '—';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(v);
    } catch {
      return `${currency} ${v}`;
    }
  }
  protected fullName(g: { firstName: string | null; middleName: string | null; lastName: string | null }): string {
    return [g.firstName, g.middleName, g.lastName].filter(Boolean).join(' ');
  }
  protected address(g: { address: string | null; city: string | null; zipCode: string | null; countryCode: string | null }): string {
    return [g.address, [g.zipCode, g.city].filter(Boolean).join(' '), g.countryCode].filter(Boolean).join(', ');
  }

  private run<T>(obs: import('rxjs').Observable<T>, ok: (r: T) => void): void {
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    obs.subscribe({
      next: (r) => {
        this.busy.set(false);
        ok(r);
        this.reload();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }
}
