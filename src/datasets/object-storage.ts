import * as fs from "fs/promises";
import * as path from "path";

/**
 * Minimal object-storage abstraction for the public datasets bucket.
 *
 * The production deployment points this at a real public bucket (S3/GCS); the
 * interfaces here are deliberately narrow so a cloud adapter can be dropped in
 * without touching the export logic.  Two adapters ship in-repo:
 *
 *   - `LocalFilesystemStorage` — writes under a root directory (dev / CI).
 *   - `InMemoryObjectStorage` — in-process Map (unit tests).
 */

export interface ObjectStorage {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  list(prefix: string): Promise<string[]>;
}

export class LocalFilesystemStorage implements ObjectStorage {
  constructor(private readonly rootDir: string) {}

  private resolve(key: string): string {
    // Keys are treated as relative paths; reject traversal outside the root.
    const target = path.resolve(this.rootDir, key);
    if (!target.startsWith(path.resolve(this.rootDir) + path.sep) && target !== path.resolve(this.rootDir)) {
      throw new Error(`Refusing to write outside storage root: ${key}`);
    }
    return target;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const base = this.resolve(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
    const entries = await this.walk(path.resolve(this.rootDir));
    const relBase = path.relative(this.rootDir, base);
    return entries
      .filter((p) => (relBase === "" ? true : p.startsWith(relBase + path.sep) || p.startsWith(relBase + "/")))
      .map((p) => p.split(path.sep).join("/"));
  }

  private async walk(dir: string): Promise<string[]> {
    let entries: string[] = [];
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return entries;
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        entries = entries.concat(await this.walk(full));
      } else {
        entries.push(path.relative(this.rootDir, full));
      }
    }
    return entries;
  }
}

export class InMemoryObjectStorage implements ObjectStorage {
  private readonly store = new Map<string, Buffer>();

  async put(key: string, body: Buffer): Promise<void> {
    this.store.set(key, Buffer.from(body));
  }

  async get(key: string): Promise<Buffer | null> {
    const value = this.store.get(key);
    return value ? Buffer.from(value) : null;
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
