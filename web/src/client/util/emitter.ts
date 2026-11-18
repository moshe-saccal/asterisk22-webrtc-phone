type Listener<T> = (payload: T) => void;

/** Minimal strongly-typed event emitter. */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (error) {
        console.error(`listener for "${String(event)}" failed`, error);
      }
    }
  }

  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}
