// In-memory task registry for P08 MVP. The contract is the public surface
// used by handlers: create / get / list. Concurrency model: a single writer
// (POST /tasks) holds the loop and mutates status; readers are lock-free
// snapshot reads. This is fine for MVP — Postgres replaces it in v0.5
// (ARCHITECTURE rule "Storage interface abstrak" + plan §17).

const VALID_STATUSES = new Set(['pending', 'running', 'completed', 'failed']);

export class TaskStore {
  #tasks = new Map();
  #runs = new Set(); // background run handles (prevent GC of in-flight promises)

  /**
   * @param {{ taskId: string, agentId: string, sandboxId: string|null,
   *   prompt: string, model: string, system?: string, maxSteps?: number,
   *   tools: string[], permissions: object }} spec
   */
  create(spec) {
    const now = new Date().toISOString();
    const rec = {
      id: spec.taskId,
      agentId: spec.agentId,
      sandboxId: spec.sandboxId,
      prompt: spec.prompt,
      model: spec.model,
      system: spec.system ?? null,
      maxSteps: spec.maxSteps ?? 16,
      tools: spec.tools ?? [],
      permissions: spec.permissions ?? {},
      status: 'running',
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      answer: null,
      error: null,
      steps: 0,
    };
    this.#tasks.set(rec.id, rec);
    return rec;
  }

  /** @returns {object|null} */
  get(id) {
    const r = this.#tasks.get(id);
    return r ? { ...r } : null;
  }

  list() {
    return [...this.#tasks.values()].map((r) => ({ ...r }));
  }

  /** Mark terminal status. Idempotent. */
  finish(id, { status, answer = null, error = null, steps = 0 }) {
    if (!VALID_STATUSES.has(status)) throw new TypeError(`bad status ${status}`);
    const r = this.#tasks.get(id);
    if (!r) return null;
    if (r.status === 'completed' || r.status === 'failed') return r; // already terminal
    r.status = status;
    r.answer = answer;
    r.error = error;
    r.steps = steps;
    r.finishedAt = new Date().toISOString();
    return r;
  }

  /** Track an in-flight background run so it isn't garbage-collected mid-flight. */
  holdRun(promise) {
    this.#runs.add(promise);
    promise.finally(() => this.#runs.delete(promise));
  }

  /** Wait for all held runs (for clean shutdown / tests). */
  async drain() {
    while (this.#runs.size > 0) {
      await Promise.allSettled([...this.#runs]);
    }
  }
}
