import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** Where photo files live. Local disk today; an object store (private bucket) can implement the same interface. */
export interface PhotoStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export const STORAGE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

export class LocalPhotoStorage implements PhotoStorage {
  private readonly root: string;

  constructor(dir: string) {
    this.root = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
  }

  /** Keys are random UUID file names only, so no path from a request can ever leave the storage folder. */
  private path(key: string): string {
    if (!STORAGE_KEY.test(key)) throw new Error('invalid storage key');
    const p = join(this.root, key.slice(0, 2), key);
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage path');
    return p;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(join(this.root, key.slice(0, 2)), { recursive: true });
    const tmp = `${p}.tmp`;
    await writeFile(tmp, data, { flag: 'wx' });
    await rename(tmp, p);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
