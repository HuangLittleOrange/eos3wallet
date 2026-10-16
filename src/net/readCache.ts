import AsyncStorage from '@react-native-async-storage/async-storage';

export type ReadSnapshot<T> = { data: T | undefined; updatedAt: number; refreshing: boolean; error: Error | null };
type Entry<T> = { snapshot: ReadSnapshot<T>; loaded: boolean; generation: number; attemptedAt?: number;
  loading?: Promise<void>; pending?: Promise<T>; listeners: Set<() => void>; writing?: Promise<unknown> };
const MAX_BYTES = 512 * 1024;

/** For read-only display data. Transaction builders, credentials and signed bytes do not belong here. */
export class ReadCache<T> {
  private entries = new Map<string, Entry<T>>();
  constructor(readonly ttl: number, private options: {
    storagePrefix?: string; validate?: (data: unknown) => data is T; equal?: (a: T, b: T) => boolean;
  } = {}) {}

  private entry(key: string): Entry<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      // Bound in-memory history/probe pages; active consumers and requests stay pinned.
      if (this.entries.size >= 100) {
        for (const [oldKey, old] of this.entries) {
          if (!old.listeners.size && !old.pending && !old.loading && !old.writing) { this.entries.delete(oldKey); break; }
        }
      }
      entry = { snapshot: { data: undefined, updatedAt: 0, refreshing: false, error: null },
        loaded: false, generation: 0, listeners: new Set() };
      this.entries.set(key, entry);
    }
    return entry;
  }
  get(key: string): ReadSnapshot<T> { return this.entry(key).snapshot; }
  subscribe(key: string, listener: () => void): () => void {
    const entry = this.entry(key); entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }
  private publish(entry: Entry<T>, snapshot: ReadSnapshot<T>) {
    entry.snapshot = snapshot; entry.listeners.forEach(listener => listener());
  }
  private persist(key: string, entry: Entry<T>, value: string | null) {
    if (!this.options.storagePrefix) return;
    const storageKey = this.options.storagePrefix + key;
    const writing = (entry.writing ?? Promise.resolve()).then(() => value === null
      ? AsyncStorage.removeItem(storageKey) : AsyncStorage.setItem(storageKey, value)).catch(() => {});
    entry.writing = writing;
    void writing.finally(() => { if (entry.writing === writing) entry.writing = undefined; });
  }
  hydrate(key: string): Promise<void> {
    const entry = this.entry(key);
    if (entry.loaded) return Promise.resolve();
    if (entry.loading) return entry.loading;
    if (!this.options.storagePrefix || !this.options.validate) { entry.loaded = true; return Promise.resolve(); }
    const generation = entry.generation;
    entry.loading = AsyncStorage.getItem(this.options.storagePrefix + key).then(raw => {
      if (!raw || raw.length > MAX_BYTES || generation !== entry.generation || entry.snapshot.data !== undefined) return;
      const value = JSON.parse(raw);
      if (value.version === 1 && Number.isFinite(value.updatedAt) && value.updatedAt >= 0
        && value.updatedAt <= Date.now() && this.options.validate!(value.data)) {
        this.publish(entry, { ...entry.snapshot, data: value.data, updatedAt: value.updatedAt });
      }
    }).catch(() => {}).finally(() => { entry.loaded = true; entry.loading = undefined; });
    return entry.loading;
  }
  remember(key: string, data: T, updatedAt = Date.now()): void {
    const entry = this.entry(key);
    if (this.options.validate && !this.options.validate(data)) throw new Error('Invalid cached response');
    const previous = entry.snapshot.data;
    const next = previous !== undefined && this.options.equal?.(previous, data) ? previous : data;
    entry.loaded = true;
    this.publish(entry, { data: next, updatedAt, refreshing: !!entry.pending, error: null });
    const value = JSON.stringify({ version: 1, data: next, updatedAt: entry.snapshot.updatedAt });
    if (value.length <= MAX_BYTES) this.persist(key, entry, value);
  }
  /** Preserve visible rows but invalidate freshness and any pre-mutation in-flight response. */
  invalidate(key: string): void {
    const entry = this.entry(key); entry.generation++; entry.loaded = true;
    entry.pending = undefined; entry.attemptedAt = undefined;
    this.publish(entry, { ...entry.snapshot, updatedAt: 0, refreshing: false, error: null });
    this.persist(key, entry, null);
  }
  async fetch(key: string, loader: () => Promise<T>, force = false): Promise<T> {
    await this.hydrate(key);
    const entry = this.entry(key);
    if (entry.pending) return entry.pending;
    const { snapshot } = entry;
    if (!force && snapshot.data !== undefined && snapshot.updatedAt > 0 && Date.now() - snapshot.updatedAt < this.ttl) return snapshot.data;
    if (!force && snapshot.error && entry.attemptedAt !== undefined && Date.now() - entry.attemptedAt < 30000) throw snapshot.error;
    entry.attemptedAt = Date.now();
    const generation = entry.generation;
    this.publish(entry, { ...snapshot, refreshing: true, error: null });
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Read request timed out')), 30000);
    });
    const pending = Promise.race([Promise.resolve().then(loader), timeout]).then(data => {
      if (generation !== entry.generation) throw new Error('Read superseded by a newer change');
      this.remember(key, data); return entry.snapshot.data!;
    }).catch(error => {
      if (generation === entry.generation) this.publish(entry, { ...entry.snapshot,
        error: error instanceof Error ? error : new Error(String(error)) });
      throw error;
    }).finally(() => {
      clearTimeout(timeoutId);
      if (entry.pending !== pending) return;
      entry.pending = undefined;
      this.publish(entry, { ...entry.snapshot, refreshing: false });
    });
    entry.pending = pending;
    return pending;
  }
}
