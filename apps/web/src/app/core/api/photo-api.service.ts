import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { API_BASE } from './api.config';

export interface Photo {
  id: string;
  propertyId: string;
  roomTypeId: string | null;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
  caption: string | null;
  isMain: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** Same-origin URL of the file (sent with the session cookie). */
  url: string;
}

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

interface Envelope<T> {
  data: T;
}

@Injectable({ providedIn: 'root' })
export class PhotoApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  private base(propertyId: string): string {
    const org = this.auth.currentOrg();
    if (!org) throw new Error('No organization selected');
    return `${API_BASE}/organizations/${org.organizationId}/properties/${encodeURIComponent(propertyId)}/photos`;
  }

  list(propertyId: string): Observable<Photo[]> {
    return this.http.get<Envelope<Photo[]>>(this.base(propertyId)).pipe(map((r) => r.data));
  }
  /** Sends the file as the raw request body; the server checks its real type, re-encodes it and strips metadata. */
  upload(propertyId: string, file: Blob, roomTypeId: string | null): Observable<Photo> {
    const params: Record<string, string> = roomTypeId ? { roomTypeId } : {};
    return this.http.post<Envelope<Photo>>(this.base(propertyId), file, { params, headers: { 'Content-Type': file.type } }).pipe(map((r) => r.data));
  }
  update(propertyId: string, id: string, body: { caption?: string | null; isMain?: true; sortOrder?: number }): Observable<Photo> {
    return this.http.patch<Envelope<Photo>>(`${this.base(propertyId)}/${encodeURIComponent(id)}`, body).pipe(map((r) => r.data));
  }
  remove(propertyId: string, id: string): Observable<unknown> {
    return this.http.delete(`${this.base(propertyId)}/${encodeURIComponent(id)}`);
  }
}
