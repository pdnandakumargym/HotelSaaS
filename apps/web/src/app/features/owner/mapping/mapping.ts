import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { CONNECTION_STATUS, CallSummary, ChannelApi, ChannelConnection, ChannelOption, RatePlan, SyncJob } from '../../../core/api/channel-api.service';
import { errorMessage } from '../../../core/api/error-message';
import { OrgApi, Property, RoomType } from '../../../core/api/org-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { PropertyPicker } from '../../../shared/ui/property-picker/property-picker';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

/** Draft mapping: channel room id → { roomTypeId, rates: channel rate id → rate plan id }. */
type Draft = Record<string, { roomTypeId: string; rates: Record<string, string> }>;

@Component({
  selector: 'ss-mapping',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, RouterLink, PropertyPicker, StatusPill],
  template: `
    <header class="ss-page-head">
      <div>
        <h1>Booking.com connection &amp; mapping</h1>
        <p class="ss-muted">Connect a property to Booking.com through Zodomus, then link each Booking.com room and rate to yours.</p>
      </div>
      <ss-property-picker (changed)="onProperty($event)" />
    </header>
    @if (error(); as e) { <p class="ss-alert ss-alert--error" role="alert">{{ e }}</p> }
    @if (notice(); as n) { <p class="ss-alert ss-alert--success" role="status">{{ n }}</p> }

    @if (options(); as o) {
      @if (!o.ready) {
        <p class="ss-alert ss-alert--info">The channel manager is not enabled on this platform yet. Please contact support.</p>
      } @else if (property()) {
        @if (!connection()) {
          <section class="ss-card">
            <h2 class="ss-card__title">Connect to Booking.com</h2>
            @if (o.environment === 'sandbox') {
              <p class="ss-alert ss-alert--info">Test mode (Zodomus sandbox): use any number as the Booking.com property ID. No real Booking.com property is changed.</p>
            }
            @if (canManage()) {
              <form (ngSubmit)="connect(o.channels[0]!)" class="form">
                <label class="ss-field"><span>Booking.com property ID</span>
                  <input class="ss-input" name="pid" required maxlength="40" pattern="[A-Za-z0-9_-]+" inputmode="numeric" [(ngModel)]="channelPropertyId" placeholder="e.g. 1234567" />
                  <small class="ss-muted">The hotel ID shown in your Booking.com Extranet.</small>
                </label>
                <fieldset>
                  <legend>Pricing model used by your Booking.com property</legend>
                  @for (m of o.channels[0]?.priceModels ?? []; track m.id) {
                    <label class="radio"><input type="radio" name="pm" [value]="m.id" [(ngModel)]="priceModelId" /> {{ m.name }} @if (m.recommended) { <ss-status-pill tone="info">Booking.com's recommendation</ss-status-pill> }</label>
                  }
                  <small class="ss-muted">It must match the pricing model set in the Booking.com Extranet, otherwise prices are rejected.</small>
                </fieldset>
                <button type="submit" class="ss-btn" [disabled]="busy()">{{ busy() ? 'Connecting…' : 'Connect' }}</button>
              </form>
            } @else {
              <p class="ss-muted">Ask an owner or manager to connect this property.</p>
            }
          </section>
        } @else {
          @let c = connection()!;
          <section class="ss-card">
            <h2 class="ss-card__title">{{ c.channelName }} <ss-status-pill [tone]="status(c).tone">{{ status(c).label }}</ss-status-pill></h2>
            <dl class="kv">
              <dt>Booking.com property ID</dt><dd><code>{{ c.channelPropertyId }}</code></dd>
              <dt>Pricing model</dt><dd>{{ modelName(o.channels[0], c.priceModelId) }}</dd>
              <dt>Currency</dt><dd>{{ c.currency }}</dd>
              <dt>Environment</dt><dd>{{ c.environment === 'sandbox' ? 'Sandbox (test mode)' : 'Production' }}</dd>
              @if (c.lastCheckAt) { <dt>Last status check</dt><dd>{{ c.lastCheckAt | date: 'medium' }}{{ c.lastCheckMessage ? ' · ' + c.lastCheckMessage : '' }}</dd> }
            </dl>
            @if (c.lastError) { <p class="ss-alert" [class.ss-alert--error]="!c.roomsActivatedAt || c.status === 'ERROR'" [class.ss-alert--info]="c.roomsActivatedAt && c.status === 'ACTIVATED'">{{ c.lastError }}</p> }
            @if (canManage()) {
              <div class="actions">
                @if (c.status === 'DRAFT') { <button type="button" class="ss-btn" (click)="retryActivate(c)" [disabled]="busy()">Retry activation</button> }
                @if (c.status !== 'DRAFT') { <button type="button" class="ss-btn ss-btn--ghost" (click)="check(c)" [disabled]="busy()">Check status</button> }
                @if (c.status === 'ACTIVE') { <button type="button" class="ss-btn ss-btn--ghost" (click)="resync(c)" [disabled]="busy()">Send all availability &amp; rates again</button> }
                <button type="button" class="ss-btn ss-btn--ghost danger" (click)="disconnect(c)" [disabled]="busy()">{{ confirmDisconnect() ? 'Click again to disconnect' : 'Disconnect' }}</button>
              </div>
            }
          </section>

          @if (c.status !== 'DRAFT') {
            <section class="ss-card">
              <h2 class="ss-card__title">Rooms &amp; rates mapping</h2>
              <div class="refhead">
                <span class="ss-muted small">{{ c.channelRoomsFetchedAt ? 'Booking.com rooms loaded ' + (c.channelRoomsFetchedAt | date: 'medium') : 'Booking.com rooms not loaded yet' }}</span>
                @if (canManage()) { <button type="button" class="ss-btn ss-btn--ghost" (click)="loadRooms(c)" [disabled]="busy()">Reload Booking.com rooms</button> }
              </div>
              @if (!roomTypes().length) {
                <p class="ss-alert ss-alert--info">Add room types with rooms first. <a routerLink="/app/rooms">Rooms &amp; units</a></p>
              } @else if (!plans().length) {
                <p class="ss-alert ss-alert--info">Create at least one rate plan first. <a routerLink="/app/rates" [queryParams]="{ property: property()?.id }">Rates &amp; rate plans</a></p>
              } @else if (c.channelRooms?.length) {
                <form (ngSubmit)="saveMapping(c)">
                  @for (cr of c.channelRooms; track cr.id) {
                    <div class="room">
                      <div class="roomhead">
                        <div class="roomname"><strong>{{ cr.name }}</strong><span class="ss-muted small">Booking.com room {{ cr.id }}</span></div>
                        <label class="ss-field inline"><span>Your room type</span>
                          <select class="ss-input" [name]="'rt-' + cr.id" [attr.data-room]="cr.id" [ngModel]="draft()[cr.id]?.roomTypeId ?? ''" (ngModelChange)="setRoom(cr.id, $event)" [disabled]="!canManage()">
                            <option value="">Not connected</option>
                            @for (rt of roomTypes(); track rt.id) { <option [value]="rt.id">{{ rt.name }} ({{ rt.roomCount ?? 0 }} rooms)</option> }
                          </select>
                        </label>
                      </div>
                      @if (draft()[cr.id]?.roomTypeId) {
                        <table class="ss-table rates">
                          <thead><tr><th scope="col">Booking.com rate</th><th scope="col">Max. guests</th><th scope="col">Your rate plan</th></tr></thead>
                          <tbody>
                            @for (rate of cr.rates; track rate.id) {
                              <tr>
                                <td>{{ rate.name }} <span class="ss-muted small">· {{ rate.id }}</span> @if (rate.active === false) { <ss-status-pill tone="neutral">inactive</ss-status-pill> }</td>
                                <td>{{ rate.maxPersons ?? '—' }}</td>
                                <td>
                                  <select class="ss-input" [name]="'rp-' + cr.id + '-' + rate.id" [attr.data-rate]="cr.id + '-' + rate.id" [ngModel]="draft()[cr.id]?.rates?.[rate.id] ?? ''" (ngModelChange)="setRate(cr.id, rate.id, $event)" [disabled]="!canManage()">
                                    <option value="">Don't send</option>
                                    @for (rp of plans(); track rp.id) { <option [value]="rp.id">{{ rp.name }}</option> }
                                  </select>
                                </td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      }
                    </div>
                  }
                  @let cov = coverage(c);
                  @if (cov.rooms < cov.totalRooms || cov.rates < cov.totalRates) {
                    <p class="ss-alert ss-alert--info coverage">
                      Zodomus confirms the property only when <strong>every</strong> Booking.com room and rate is mapped.
                      Mapped so far: {{ cov.rooms }} of {{ cov.totalRooms }} rooms, {{ cov.rates }} of {{ cov.totalRates }} rates.
                      Each Booking.com room needs its own room type here, and each of its rates its own rate plan.
                    </p>
                  }
                  @if (canManage()) {
                    <button type="submit" class="ss-btn" [disabled]="busy()">{{ busy() ? 'Activating…' : c.status === 'ACTIVE' ? 'Save mapping' : 'Save mapping & activate rooms' }}</button>
                  }
                </form>
                @if (steps().length) {
                  <ul class="steps">
                    @for (s of steps(); track $index) { <li [class.bad]="!s.result.ok">{{ s.step }}: {{ s.result.ok ? 'OK' : (s.result.error ?? s.result.outcome) }}{{ s.result.providerMessage && s.result.providerMessage !== 'OK' ? ' · ' + s.result.providerMessage : '' }}</li> }
                  </ul>
                }
              } @else {
                <p class="ss-muted">Load the Booking.com rooms to start mapping.</p>
              }
            </section>
          }

          @if (c.status === 'ACTIVE') {
            <section class="ss-card">
              <h2 class="ss-card__title">Recent updates sent to Booking.com</h2>
              @if (jobs().length) {
                <div class="ss-table-wrap">
                  <table class="ss-table">
                    <thead><tr><th scope="col">Queued</th><th scope="col">What</th><th scope="col">Dates</th><th scope="col">Status</th><th scope="col">Calls</th><th scope="col">Message</th></tr></thead>
                    <tbody>
                      @for (j of jobs(); track j.id) {
                        <tr>
                          <td>{{ j.createdAt | date: 'short' }}</td>
                          <td>{{ kind(j) }} · {{ roomTypeName(j.roomTypeId) }}{{ j.ratePlanId ? ' · ' + planName(j.ratePlanId) : '' }}</td>
                          <td>{{ j.dateFrom | date: 'd MMM' }} – {{ lastDay(j.dateTo) | date: 'd MMM y' }}</td>
                          <td><ss-status-pill [tone]="j.status === 'SUCCEEDED' ? 'success' : j.status === 'FAILED' ? 'danger' : j.status === 'CANCELLED' ? 'neutral' : 'info'">{{ j.status }}</ss-status-pill></td>
                          <td>{{ j.callsMade }}</td>
                          <td>{{ j.lastError ?? '—' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                <button type="button" class="ss-btn ss-btn--ghost" (click)="loadJobs(c)">Refresh</button>
              } @else {
                <p class="ss-muted">Nothing sent yet.</p>
              }
            </section>
          }
        }
      }
    }
  `,
  styles: `
    section.ss-card { margin-bottom: 16px; }
    .form { display: grid; gap: 12px; max-width: 560px; }
    fieldset { border: 1px solid var(--ss-border); border-radius: var(--ss-radius-sm); padding: 12px; margin: 0; display: grid; gap: 8px; }
    legend { font-weight: 600; font-size: 13.5px; padding: 0 4px; }
    .radio { display: flex; gap: 8px; align-items: center; font-size: 14px; }
    small { font-size: 12px; }
    .small { font-size: 12.5px; }
    .kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px; margin: 0 0 12px; font-size: 14px; }
    .kv dt { color: var(--ss-text-muted); }
    .kv dd { margin: 0; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .danger { color: var(--ss-red-600); }
    .refhead { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .room { border: 1px solid var(--ss-border); border-radius: var(--ss-radius-sm); padding: 12px; margin-bottom: 12px; }
    .roomhead { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .roomname { display: flex; flex-direction: column; gap: 2px; }
    .inline { min-width: 240px; }
    .rates { margin-top: 8px; }
    .rates select { height: 34px; }
    .steps { margin: 12px 0 0; padding-left: 18px; font-size: 13.5px; }
    .steps .bad { color: var(--ss-red-600); }
  `,
})
export class Mapping {
  private readonly api = inject(ChannelApi);
  private readonly org = inject(OrgApi);
  private readonly auth = inject(AuthService);
  protected readonly property = signal<Property | null>(null);
  protected readonly options = signal<{ ready: boolean; environment: string; channels: ChannelOption[] } | null>(null);
  protected readonly connection = signal<ChannelConnection | null>(null);
  protected readonly roomTypes = signal<RoomType[]>([]);
  protected readonly plans = signal<RatePlan[]>([]);
  protected readonly jobs = signal<SyncJob[]>([]);
  protected readonly draft = signal<Draft>({});
  protected readonly steps = signal<{ step: string; result: CallSummary }[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly confirmDisconnect = signal(false);
  protected readonly canManage = computed(() => this.auth.hasOrgPermission('channel.manage'));
  protected channelPropertyId = '';
  protected priceModelId = 2;

  onProperty(p: Property): void {
    this.property.set(p);
    this.connection.set(null);
    this.steps.set([]);
    this.notice.set(null);
    this.error.set(null);
    forkJoin({ options: this.api.options(), connections: this.api.connections(p.id), roomTypes: this.org.roomTypes(p.id), plans: this.api.ratePlans(p.id) }).subscribe({
      next: (r) => {
        this.options.set(r.options);
        const recommended = r.options.channels[0]?.priceModels.find((m) => m.recommended);
        if (recommended) this.priceModelId = recommended.id;
        this.roomTypes.set(r.roomTypes.filter((t) => t.status === 'ACTIVE'));
        this.plans.set(r.plans.filter((x) => x.status === 'ACTIVE'));
        this.setConnection(r.connections.find((c) => c.status !== 'DISCONNECTED') ?? null);
      },
      error: (e: unknown) => this.error.set(errorMessage(e)),
    });
  }

  protected status(c: ChannelConnection) {
    if (c.status === 'ACTIVATED' && c.roomsActivatedAt) return { label: 'Rooms activated · awaiting confirmation', tone: 'warning' as const };
    return CONNECTION_STATUS[c.status];
  }
  protected modelName(ch: ChannelOption | undefined, id: number): string {
    return ch?.priceModels.find((m) => m.id === id)?.name ?? `Model ${id}`;
  }
  protected kind(j: SyncJob): string {
    return j.kind === 'AVAILABILITY' ? 'Availability' : j.kind === 'RATES' ? 'Rates' : 'Derived prices';
  }
  protected roomTypeName(id: string | null): string {
    return this.roomTypes().find((t) => t.id === id)?.name ?? '—';
  }
  protected planName(id: string): string {
    return this.plans().find((p) => p.id === id)?.name ?? '';
  }
  protected lastDay(exclusive: string): string {
    return new Date(Date.parse(exclusive) - 86_400_000).toISOString().slice(0, 10);
  }

  protected coverage(c: ChannelConnection) {
    const rooms = c.channelRooms ?? [];
    const d = this.draft();
    let mappedRooms = 0;
    let mappedRates = 0;
    for (const r of rooms) {
      const m = d[r.id];
      if (!m?.roomTypeId) continue;
      mappedRooms++;
      mappedRates += r.rates.filter((x) => m.rates[x.id]).length;
    }
    return { rooms: mappedRooms, totalRooms: rooms.length, rates: mappedRates, totalRates: rooms.reduce((n, r) => n + r.rates.length, 0) };
  }

  protected setRoom(channelRoomId: string, roomTypeId: string): void {
    this.draft.update((d) => {
      const next = { ...d };
      if (!roomTypeId) delete next[channelRoomId];
      else next[channelRoomId] = { roomTypeId, rates: d[channelRoomId]?.rates ?? {} };
      return next;
    });
  }
  protected setRate(channelRoomId: string, channelRateId: string, ratePlanId: string): void {
    this.draft.update((d) => {
      const room = d[channelRoomId];
      if (!room) return d;
      const rates = { ...room.rates };
      if (!ratePlanId) delete rates[channelRateId];
      else rates[channelRateId] = ratePlanId;
      return { ...d, [channelRoomId]: { ...room, rates } };
    });
  }

  protected connect(channel: ChannelOption): void {
    const p = this.property();
    if (!p) return;
    this.run(this.api.connect(p.id, { channelId: channel.channelId, channelPropertyId: this.channelPropertyId.trim(), priceModelId: Number(this.priceModelId) }), (r) => {
      this.setConnection(r.connection);
      this.notice.set(r.result.ok ? 'Property activated with Zodomus. Now map your rooms and rates.' : null);
      if (!r.result.ok) this.error.set(r.connection.lastError ?? r.result.error);
    });
  }
  protected retryActivate(c: ChannelConnection): void {
    this.run(this.api.activate(c.propertyId, c.id), (r) => {
      this.setConnection(r.connection);
      if (!r.result.ok) this.error.set(r.connection.lastError ?? r.result.error);
    });
  }
  protected loadRooms(c: ChannelConnection): void {
    this.run(this.api.loadRoomRates(c.propertyId, c.id), (r) => {
      this.setConnection(r.connection);
      if (!r.result.ok) this.error.set(r.connection.lastError ?? r.result.error);
    });
  }
  protected check(c: ChannelConnection): void {
    this.run(this.api.check(c.propertyId, c.id), (r) => {
      this.setConnection(r.connection);
      if (r.result.ok) {
        this.notice.set(
          r.syncJobsQueued
            ? `Property confirmed. Connected — ${r.syncJobsQueued} updates (one year of availability and rates) are being sent to Booking.com.`
            : `Status check OK${r.result.providerMessage ? ': ' + r.result.providerMessage : ''}.`,
        );
      } else {
        const msg = r.result.providerMessage && r.result.providerMessage !== 'OK' ? `Zodomus: ${r.result.providerMessage}` : (r.result.error ?? 'Status check failed.');
        this.error.set(r.connection.status === 'ACTIVE' ? msg : `Not confirmed yet. ${msg}`);
      }
    });
  }
  protected resync(c: ChannelConnection): void {
    this.run(this.api.resync(c.propertyId, c.id), (r) => {
      this.notice.set(`${r.syncJobsQueued} updates queued. They are sent in the background.`);
      this.loadJobs(c);
    });
  }
  protected disconnect(c: ChannelConnection): void {
    if (!this.confirmDisconnect()) {
      this.confirmDisconnect.set(true);
      return;
    }
    this.confirmDisconnect.set(false);
    this.run(this.api.disconnect(c.propertyId, c.id), () => {
      this.notice.set('Disconnected. StaySync no longer sends updates for this property.');
      this.setConnection(null);
    });
  }
  protected saveMapping(c: ChannelConnection): void {
    const rooms = Object.entries(this.draft()).map(([channelRoomId, v]) => ({
      channelRoomId,
      roomTypeId: v.roomTypeId,
      rates: Object.entries(v.rates).map(([channelRateId, ratePlanId]) => ({ channelRateId, ratePlanId })),
    }));
    if (!rooms.length) {
      this.error.set('Connect at least one Booking.com room to one of your room types.');
      return;
    }
    const missing = rooms.find((r) => !r.rates.length);
    if (missing) {
      this.error.set('Each connected room needs at least one rate linked to a rate plan.');
      return;
    }
    this.run(this.api.saveMapping(c.propertyId, c.id, { rooms }), (r) => {
      this.setConnection(r.connection);
      this.steps.set(r.steps);
      if (r.connection.status === 'ACTIVE') this.notice.set(`Connected. ${r.syncJobsQueued} updates (one year of availability and rates) are being sent to Booking.com.`);
      else if (r.connection.status === 'ACTIVATED') this.notice.set(r.connection.lastError ?? 'Rooms activated. Use "Check status" to finish the connection.');
      else this.error.set(r.connection.lastError);
    });
  }
  loadJobs(c: ChannelConnection): void {
    this.api.jobs(c.propertyId, c.id).subscribe({ next: (j) => this.jobs.set(j), error: () => this.jobs.set([]) });
  }

  private setConnection(c: ChannelConnection | null): void {
    this.connection.set(c);
    const d: Draft = {};
    for (const m of c?.roomMappings ?? []) d[m.channelRoomId] = { roomTypeId: m.roomTypeId, rates: Object.fromEntries(m.rates.map((r) => [r.channelRateId, r.ratePlanId])) };
    this.draft.set(d);
    if (c?.status === 'ACTIVE') this.loadJobs(c);
  }

  private run<T>(obs: import('rxjs').Observable<T>, ok: (r: T) => void): void {
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);
    obs.subscribe({
      next: (r) => {
        this.busy.set(false);
        ok(r);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(errorMessage(e));
      },
    });
  }
}
