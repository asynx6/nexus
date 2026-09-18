// Sandbox policy DSL — declarative JSON rules that gate DockerRuntime.create()
// and .exec() calls. Evaluated in order; first match wins. If no rule matches,
// the action is allowed (open by default; user supplies explicit deny rules).
//
// Rule shape:
//   {
//     "match": {                        // all matchers are AND-ed
//       "image": "python:3.12-slim" | "python:*" | /^python:3\.12/,  // string|RegExp|glob
//       "command": "rm -rf" | /^curl\s/,                            // matches the full argv joined
//       "network": "bridge" | "none",
//       "memoryMbAbove": 512,
//       "pidsLimitAbove": 64
//     },
//     "allow": false,
//     "reason": "destructive command not permitted in dev sandboxes"
//   }
//
// Glob support for `image` and `command`:
//   `*`  matches any chars except `/`
//   `**` matches any chars including `/`
//   `?`  matches a single char
//
// Examples:
//   [
//     { match: { image: "**" }, allow: true, reason: "default allow" },
//     { match: { command: "rm -rf /*" }, allow: false, reason: "dangerous rm" },
//     { match: { network: "bridge", image: "alpine:*" }, allow: true, reason: "alpine network ok" },
//     { match: { memoryMbAbove: 1024 }, allow: false, reason: "memory cap 1GB" }
//   ]

/** Convert a glob to a RegExp. */
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; }
      else { re += '[^/]*'; }
    } else if (c === '?') {
      re += '.';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Match a single match-clause value against a target. */
function matchValue(pattern, target) {
  if (pattern == null) return true; // matcher absent → wildcard
  if (target == null) return false;
  if (pattern instanceof RegExp) return pattern.test(target);
  if (typeof pattern === 'string') {
    if (pattern.includes('*') || pattern.includes('?')) {
      return globToRegex(pattern).test(target);
    }
    return pattern === target;
  }
  if (typeof pattern === 'number') {
    return typeof target === 'number' && target === pattern;
  }
  return false;
}

/** Command-string matching: substring OR exact match. Lets users write
 *  `command: "rm -rf"` and have it match any argv whose joined string
 *  contains that prefix. */
function matchCommand(pattern, target) {
  if (pattern instanceof RegExp) return pattern.test(target);
  if (typeof pattern === 'string') {
    if (pattern.includes('*') || pattern.includes('?')) return globToRegex(pattern).test(target);
    return target.includes(pattern);
  }
  return false;
}

/** Resolve a single rule's match-clause against an action context. */
function ruleMatches(rule, ctx) {
  const m = rule.match ?? {};
  if (!matchValue(m.image, ctx.image)) return false;
  if (m.command != null) {
    if (ctx.command == null) return false;
    if (!matchCommand(m.command, ctx.command)) return false;
  }
  if (!matchValue(m.network, ctx.network)) return false;
  // numeric thresholds: *Above triggers when target > threshold
  if (typeof m.memoryMbAbove === 'number' && !(typeof ctx.memoryMb === 'number' && ctx.memoryMb > m.memoryMbAbove)) return false;
  if (typeof m.pidsLimitAbove === 'number' && !(typeof ctx.pidsLimit === 'number' && ctx.pidsLimit > m.pidsLimitAbove)) return false;
  if (typeof m.cpusAbove === 'number' && !(typeof ctx.cpus === 'number' && ctx.cpus > m.cpusAbove)) return false;
  return true;
}

/**
 * Evaluate a rule list against an action.
 * @param {Array<object>} rules
 * @param {{ image?: string, command?: string, network?: string,
 *           memoryMb?: number, pidsLimit?: number, cpus?: number }} ctx
 * @returns {{ allow: boolean, reason: string, ruleIndex: number }}
 */
export function evaluate(rules, ctx = {}) {
  if (!Array.isArray(rules)) {
    throw new TypeError('rules must be an array');
  }
  for (let i = 0; i < rules.length; i++) {
    if (ruleMatches(rules[i], ctx)) {
      const r = rules[i];
      return {
        allow: r.allow !== false, // default to allow if unspecified
        reason: r.reason ?? (r.allow === false ? 'denied by policy' : 'allowed by policy'),
        ruleIndex: i,
      };
    }
  }
  // No rule matched → open default
  return { allow: true, reason: 'no rule matched (default allow)', ruleIndex: -1 };
}

/**
 * PolicyEngine wraps evaluate() with a fixed ruleset + audit hook.
 * Optionally emits `policy.decision` events when given an eventBus.
 */
export class PolicyEngine {
  /**
   * @param {Array<object>} rules
   * @param {{ bus?: {emit: Function}, subject?: string, hook?: (decision, ctx) => void }} [opts]
   */
  constructor(rules = [], opts = {}) {
    this.rules = [...rules];
    this.bus = opts.bus ?? null;
    this.subject = opts.subject ?? null;
    this.hook = opts.hook ?? null;
  }

  /** Replace rules. */
  setRules(rules) {
    if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
    this.rules = [...rules];
  }

  getRules() {
    return [...this.rules];
  }

  /** Evaluate one action; returns {allow, reason, ruleIndex}. */
  check(ctx = {}) {
    const decision = evaluate(this.rules, ctx);
    if (this.hook) {
      try { this.hook(decision, ctx); } catch { /* hook must never break eval */ }
    }
    if (this.bus) {
      try {
        this.bus.emit({
          name: 'policy.decision',
          ts: new Date().toISOString(),
          subject: this.subject,
          data: { allow: decision.allow, reason: decision.reason, ruleIndex: decision.ruleIndex, ctx },
        });
      } catch { /* observability must never break eval */ }
    }
    return decision;
  }

  /**
   * Convenience: gate a DockerRuntime.create(spec) call. Throws if denied.
   * @param {object} spec CreateSpec
   * @throws {PolicyDeniedError}
   */
  gateCreate(spec = {}) {
    const d = this.check({
      image: spec.image,
      network: spec.network,
      memoryMb: spec.memoryMb,
      pidsLimit: spec.pidsLimit,
      cpus: spec.cpus,
    });
    if (!d.allow) throw new PolicyDeniedError('create(' + (spec.image ?? 'default') + ') denied: ' + d.reason, d);
  }

  /**
   * Convenience: gate a DockerRuntime.exec(id, cmd) call. Throws if denied.
   * @param {string[]} cmd
   * @throws {PolicyDeniedError}
   */
  gateExec(cmd = []) {
    const command = Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '');
    const d = this.check({ command });
    if (!d.allow) throw new PolicyDeniedError('exec(' + command + ') denied: ' + d.reason, d);
  }
}

/** Error thrown when policy denies an action. Carries the decision for callers. */
export class PolicyDeniedError extends Error {
  constructor(message, decision) {
    super(message);
    this.name = 'PolicyDeniedError';
    this.decision = decision;
  }
}

/** Default policy (permissive) — allows everything; replace in prod with explicit deny list. */
export const DEFAULT_POLICY = [
  { match: { image: '**' }, allow: true, reason: 'all images allowed (default)' },
];
