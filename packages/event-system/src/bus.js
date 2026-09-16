/**
 * In-process event bus (plan-nexus.md sec 11; Redis pub/sub is v0.5+).
 * Subscribe returns an unsubscribe fn. Listener errors never break the emitter.
 */
export class EventBus {
  #listeners = new Map();
  #any = new Set();


  /**
   * @param {string|'*'} name exact event name, or '*' for all events
   * @param {(event: object) => void} listener
   * @returns {() => void} unsubscribe
   */
  on(name, listener) {
    if (typeof name !== 'string' || name.length === 0) throw new TypeError('name required');
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (name === '*') {
      this.#any.add(listener);
      return () => this.#any.delete(listener);
    }
    let set = this.#listeners.get(name);
    if (!set) { set = new Set(); this.#listeners.set(name, set); }
    set.add(listener);
    return () => set.delete(listener);
  }

  /** @param {string} type @returns {() => void} */
  once(name, listener) {
    const off = this.on(name, (e) => { off(); listener(e); });
    return off;
  }

  /**
   * Emit to matching listeners. Returns the number of listeners invoked.
   * @param {object} event shared envelope { id, ts, name, subject, data }
   * @returns {number}
   */
  emit(event) {
    if (!event || typeof event.name !== 'string') throw new TypeError('event.name required');
    const matched = this.#listeners.get(event.name);
    if (!matched) { if (this.#any.size === 0) return 0; }
    const targets = [];
    if (matched) for (const fn of matched) targets.push(fn);
    for (const fn of this.#any) targets.push(fn);
    for (const fn of targets) {
      try { fn(event); } catch (err) { this.#report(event, err); }
    }
    return targets.length;
  }

  #report(event, err) {
    // last-resort: never let one listener kill the bus or other listeners
    process.emitWarning(`EventBus listener failed for "${event?.name}": ${err?.message ?? err}`);
  }

  removeAllListeners(name) {
    if (name === undefined) { this.#listeners.clear(); this.#any.clear(); return; }
    this.#listeners.delete(name);
  }
}
