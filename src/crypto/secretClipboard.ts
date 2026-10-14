type Clipboard = {
  setStringAsync: (value: string) => Promise<unknown>;
  getStringAsync: () => Promise<string>;
};

/** Explicit secret export only. Serializes native writes and clears only our last value.
 * Clipboard APIs cannot revoke clipboard history/sync or guarantee cleanup after termination.
 */
export class SecretClipboard {
  private value: string | null = null;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private clipboard: Clipboard) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async copy(value: string, isCurrent: () => boolean): Promise<boolean> {
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation || !isCurrent()) return false;
      // Remember it before awaiting: cancellation must also clear a late native write.
      this.value = value;
      try {
        const result = await this.clipboard.setStringAsync(value);
        if (result === false) throw new Error('Clipboard write failed');
      } catch {
        await this.clearOwnedValue();
        return false;
      }
      if (generation !== this.generation || !isCurrent()) {
        await this.clearOwnedValue();
        return false;
      }
      return true;
    });
  }

  clear(): Promise<void> {
    this.generation++;
    return this.enqueue(() => this.clearOwnedValue());
  }

  private async clearOwnedValue(): Promise<void> {
    const owned = this.value;
    try {
      if (owned !== null && await this.clipboard.getStringAsync() === owned) {
        await this.clipboard.setStringAsync('');
      }
    } catch {
      // OS access may be unavailable in the background. Never log secret/error contents.
    } finally {
      this.value = null;
    }
  }
}
