import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { errorMessage } from '../../../core/api/error-message';
import { Amenity, OrgApi, Room, RoomType, expandRoomNames } from '../../../core/api/org-api.service';
import { AuthService } from '../../../core/auth/auth.service';
import { AmenityPicker } from '../../../shared/ui/amenity-picker/amenity-picker';
import { StatusPill } from '../../../shared/ui/status-pill/status-pill';

/** Room types and physical rooms/units for one property. */
@Component({
  selector: 'ss-rooms-manager',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ReactiveFormsModule, StatusPill, AmenityPicker],
  templateUrl: './rooms-manager.html',
  styleUrl: './rooms-manager.scss',
})
export class RoomsManager {
  readonly propertyId = input.required<string>();

  private readonly api = inject(OrgApi);
  private readonly auth = inject(AuthService);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly canWrite = computed(() => this.auth.hasOrgPermission('property.write'));
  protected readonly canSetStatus = computed(() => this.auth.hasOrgPermission('inventory.write'));
  protected readonly roomTypes = signal<RoomType[]>([]);
  protected readonly rooms = signal<Room[]>([]);
  protected readonly amenities = signal<Amenity[]>([]);
  protected readonly message = signal<{ tone: 'success' | 'error'; text: string } | null>(null);
  protected readonly editing = signal<RoomType | 'new' | null>(null);
  protected readonly typeAmenities = signal<string[]>([]);
  protected readonly busy = signal(false);

  protected readonly typeForm = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    code: ['', [Validators.required, Validators.pattern(/^[A-Za-z0-9_-]{1,20}$/)]],
    baseOccupancy: [2, [Validators.required, Validators.min(1)]],
    maxAdults: [2, [Validators.required, Validators.min(1)]],
    maxChildren: [0, [Validators.required, Validators.min(0)]],
    maxOccupancy: [2, [Validators.required, Validators.min(1)]],
    bedConfiguration: [''],
    sizeSqm: [''],
    description: [''],
    status: ['ACTIVE' as 'ACTIVE' | 'INACTIVE'],
  });

  protected readonly roomForm = this.fb.group({ roomTypeId: ['', Validators.required], names: ['', Validators.required], floor: [''] });

  constructor() {
    this.api.amenities().subscribe((a) => this.amenities.set(a));
    effect(() => {
      const id = this.propertyId();
      if (id) this.load(id);
    });
  }

  protected roomsOf(typeId: string): Room[] {
    return this.rooms().filter((r) => r.roomTypeId === typeId);
  }

  private load(id = this.propertyId()): void {
    forkJoin([this.api.roomTypes(id), this.api.rooms(id)]).subscribe({
      next: ([t, r]) => {
        this.roomTypes.set(t);
        this.rooms.set(r);
        if (!this.roomForm.controls.roomTypeId.value && t[0]) this.roomForm.controls.roomTypeId.setValue(t[0].id);
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  private ok(text: string): void {
    this.busy.set(false);
    this.message.set({ tone: 'success', text });
  }
  private fail(e: unknown): void {
    this.busy.set(false);
    this.message.set({ tone: 'error', text: errorMessage(e) });
  }

  protected newType(): void {
    this.typeForm.reset({ name: '', code: '', baseOccupancy: 2, maxAdults: 2, maxChildren: 0, maxOccupancy: 2, bedConfiguration: '', sizeSqm: '', description: '', status: 'ACTIVE' });
    this.typeAmenities.set([]);
    this.editing.set('new');
  }

  protected editType(t: RoomType): void {
    this.typeForm.reset({
      name: t.name,
      code: t.code,
      baseOccupancy: t.baseOccupancy,
      maxAdults: t.maxAdults,
      maxChildren: t.maxChildren,
      maxOccupancy: t.maxOccupancy,
      bedConfiguration: t.bedConfiguration ?? '',
      sizeSqm: t.sizeSqm?.toString() ?? '',
      description: t.description ?? '',
      status: t.status,
    });
    this.typeAmenities.set(t.amenities);
    this.editing.set(t);
  }

  protected saveType(): void {
    if (this.typeForm.invalid) {
      this.typeForm.markAllAsTouched();
      this.message.set({ tone: 'error', text: 'Check the room type fields.' });
      return;
    }
    const v = this.typeForm.getRawValue();
    const body: Partial<RoomType> = {
      ...v,
      code: v.code.toUpperCase(),
      sizeSqm: v.sizeSqm ? Number(v.sizeSqm) : null,
      bedConfiguration: v.bedConfiguration || null,
      description: v.description || null,
      amenities: this.typeAmenities(),
    };
    const editing = this.editing();
    this.busy.set(true);
    const req = editing === 'new' || !editing ? this.api.createRoomType(this.propertyId(), body) : this.api.updateRoomType(this.propertyId(), editing.id, body);
    req.subscribe({
      next: () => {
        this.editing.set(null);
        this.ok('Room type saved.');
        this.load();
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected deleteType(t: RoomType): void {
    if (!confirm(`Delete room type "${t.name}"?`)) return;
    this.api.deleteRoomType(this.propertyId(), t.id).subscribe({
      next: () => {
        this.ok('Room type deleted.');
        this.load();
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected addRooms(): void {
    const v = this.roomForm.getRawValue();
    let names: string[];
    try {
      names = expandRoomNames(v.names);
    } catch (e) {
      this.message.set({ tone: 'error', text: (e as Error).message });
      return;
    }
    if (!v.roomTypeId || names.length === 0) {
      this.message.set({ tone: 'error', text: 'Choose a room type and enter room numbers, for example 101-110.' });
      return;
    }
    this.busy.set(true);
    this.api.createRooms(this.propertyId(), v.roomTypeId, names, v.floor || undefined).subscribe({
      next: (r) => {
        this.roomForm.controls.names.reset('');
        this.ok(`Added ${r.created} room${r.created === 1 ? '' : 's'}.`);
        this.load();
      },
      error: (e: unknown) => this.fail(e),
    });
  }

  protected toggleStatus(room: Room): void {
    const status = room.status === 'AVAILABLE' ? 'OUT_OF_SERVICE' : 'AVAILABLE';
    this.api.updateRoom(this.propertyId(), room.id, { status }).subscribe({
      next: () => this.load(),
      error: (e: unknown) => this.fail(e),
    });
  }

  protected deleteRoom(room: Room): void {
    if (!confirm(`Delete room ${room.name}?`)) return;
    this.api.deleteRoom(this.propertyId(), room.id).subscribe({ next: () => this.load(), error: (e: unknown) => this.fail(e) });
  }
}
