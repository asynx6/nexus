// @nexus/model-provider — OpenAI-compatible chat client for the NEXUS gateway.
// Zero deps: global fetch + AbortSignal.timeout. No keys in logs, ever.
// Secrets reach this module only via explicit `apiKey` option (caller pulls
// from SecretStore / env — plan sec 22).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal token bucket, inlined so this package stays zero-dep.
// Capacity = burst; refills steadily at capacity/rpm per ms.
export class MiniBucket {
  constructor({ rpm, burst }) {
    this.capacity = burst;
    this.perMs = rpm / 60_000;
    this.tokens = burst;
    this.last = Date.now();
  }
  waitMs(cost = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
    if (this.tokens >= cost) return 0;
    return Math.ceil((cost - this.tokens) / this.perMs);
  }
  consume(cost = 1) { this.tokens -= cost; }
}

/** Parse an SSE chat-completions body into the final aggregated response. */
function parseSseBody(text) {
  let acc = { choices: [{ message: { content: '' } }] };
  let sawChunk = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const chunk = JSON.parse(payload);
      sawChunk = true;
      const dc = chunk.choices?.[0]?.delta;
      if (dc?.content) acc.choices[0].message.content += dc.content;
      if (dc?.tool_calls?.[0]?.function?.name && !acc.choices[0].message.tool_calls) {
        acc = chunk; // providers that stream tool_calls send them in full in one chunk
      }
      if (chunk.usage) acc.usage = chunk.usage;
      if (chunk.model) acc.model = chunk.model;
    } catch { /* skip malformed frames */ }
  }
  return sawChunk ? acc : null;
}

export class ModelProvider {
  #base; #key; #models; #timeoutMs; #retries; #rateLimit;

  /**
   * @param {{ baseUrl: string, apiKey?: string, models?: string[], timeoutMs?: number, retries?: number, rateLimit?: { rpm?: number, burst?: number } }} opts
   *   models: ordered fallback list; first entry is primary.
   *   rateLimit: optional client-side throttle — rpm = sustained calls/min,
   *     burst = max instant calls. Prevents burning quota on a tight loop.
   */
  constructor({ baseUrl, apiKey = process.env.NEXUS_GATEWAY_KEY, models = ['hermes-agent'], timeoutMs = 60000, retries = 1, rateLimit = null }) {
    if (typeof baseUrl !== 'string' || !baseUrl.startsWith('http')) throw new TypeError('baseUrl must be an http(s) URL');
    if (!apiKey) throw new Error('apiKey required (pass explicitly or set NEXUS_GATEWAY_KEY)');
    if (!Array.isArray(models) || models.length === 0) throw new TypeError('models must be a non-empty array');
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#key = apiKey;
    this.#models = [...models];
    this.#timeoutMs = timeoutMs;
    this.#retries = retries;
    this.#rateLimit = rateLimit ? new MiniBucket({
      rpm: rateLimit.rpm ?? 1,
      burst: rateLimit.burst ?? rateLimit.rpm ?? 1
    }) : null;
  }

  get models() { return [...this.#models]; }

  /** Sleep until the rate limiter allows a call. No-op when unconfigured. */
  async #awaitRateLimit() {
    if (!this.#rateLimit) return;
    const waitMs = this.#rateLimit.waitMs();
    if (waitMs > 0) await sleep(waitMs);
    this.#rateLimit.consume();
  }

  /**
   * Chat completion with fallback across configured models.
   * @param {Array<{role: string, content: string}>} messages
   * @param {{ model?: string, maxTokens?: number, temperature?: number }} [opts]
   * @returns {Promise<{ model: string, content: string, usage: object|null }>}
   */
  async chat(messages, opts = {}) {
    if (!Array.isArray(messages) || messages.length === 0) throw new TypeError('messages must be a non-empty array');
    const order = opts.model ? [opts.model, ...this.#models.filter((m) => m !== opts.model)] : this.#models;
    let lastErr;
    for (const model of order) {
      for (let attempt = 0; attempt <= this.#retries; attempt++) {
        try {
          await this.#awaitRateLimit();
          return await this.#oneCall(model, messages, opts);
        } catch (e) {
          lastErr = e;
          // 4xx (except 429) = permanent, try next model immediately
          if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) break;
          if (attempt < this.#retries) await sleep(400 * (attempt + 1));
        }
      }
    }
    throw new Error('all models failed; last: ' + (lastErr?.message || 'unknown'));
  }

  async #oneCall(model, messages, opts) {
    const body = { model, messages, max_tokens: opts.maxTokens ?? 1024 };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    // native OpenAI function calling: caller passes plain [{name,description,parameters}]
    if (Array.isArray(opts.tools) && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({ type: 'function', function: t }));
    }
    const r = await fetch(this.#base + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.#key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!r.ok) {
      const err = new Error('provider ' + r.status + ' on ' + model);
      err.status = r.status;
      throw err;
    }
    const text = await r.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      j = parseSseBody(text); // gateway sometimes replies SSE (data: {...}) to non-stream calls
    }
    if (!j) { const err = new Error('provider returned unparseable body for ' + model); err.status = 502; throw err; }
    // gateway may add non-standard fields (e.g. _manifest); choices must exist
    const choice = Array.isArray(j.choices) && j.choices[0];
    if (!choice) { const err = new Error('provider returned no choices for ' + model); err.status = 502; throw err; }
    const msg = choice.message ?? {};
    const native = Array.isArray(msg.tool_calls) ? msg.tool_calls[0] : null;
    let tool_call = null;
    if (native?.function?.name) {
      let args = native.function.arguments ?? '{}';
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { _raw: args }; } }
      tool_call = { name: native.function.name, arguments: args };
    }
    return { model, content: msg.content ?? null, tool_call, usage: j.usage ?? null, id: j.id ?? null };
  }

  /** List model ids from /models (gateway-provided). */
  async listModels() {
    const r = await fetch(this.#base + '/models', {
      headers: { Authorization: 'Bearer ' + this.#key, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!r.ok) { const e = new Error('listModels ' + r.status); e.status = r.status; throw e; }
    const j = await r.json();
    return (j.data || j).map?.((m) => m.id ?? m) ?? [];
  }
}
