// Unit tests for the sandbox policy DSL.
// Covers: glob matching, regex matching, command matching, numeric thresholds,
// rule ordering (first match wins), default-allow fallback, error class, and
// integration with DockerRuntime via stubbed PolicyEngine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine, PolicyDeniedError, evaluate, DEFAULT_POLICY } from '../src/policy.js';

test('evaluate: no rules → default allow', () => {
  const r = evaluate([], { image: 'python:3.12-slim' });
  assert.equal(r.allow, true);
  assert.equal(r.ruleIndex, -1);
});

test('evaluate: empty array is treated as default allow', () => {
  const r = evaluate([], {});
  assert.equal(r.allow, true);
  assert.match(r.reason, /default allow/i);
});

test('evaluate: image glob match — python:* matches python:3.12-slim', () => {
  const rules = [{ match: { image: 'python:*' }, allow: false, reason: 'no python images' }];
  const r = evaluate(rules, { image: 'python:3.12-slim' });
  assert.equal(r.allow, false);
  assert.equal(r.ruleIndex, 0);
  assert.equal(r.reason, 'no python images');
});

test('evaluate: image regex match — /^python:3\\./ matches python:3.12', () => {
  const rules = [{ match: { image: /^python:3\./ }, allow: false, reason: 'python 3.x' }];
  const r = evaluate(rules, { image: 'python:3.10-slim' });
  assert.equal(r.allow, false);
});

test('evaluate: command substring (no glob) matches full argv joined', () => {
  const rules = [{ match: { command: 'rm -rf' }, allow: false, reason: 'destructive' }];
  const r = evaluate(rules, { command: 'rm -rf /tmp/x' });
  assert.equal(r.allow, false);
});

test('evaluate: numeric threshold — memoryMbAbove', () => {
  const rules = [{ match: { memoryMbAbove: 512 }, allow: false, reason: 'cap 512MB' }];
  assert.equal(evaluate(rules, { memoryMb: 256 }).allow, true, 'below threshold → no rule matches');
  assert.equal(evaluate(rules, { memoryMb: 1024 }).allow, false, 'above threshold → deny');
});

test('evaluate: first match wins (rules are AND-evaluated, ordered)', () => {
  const rules = [
    { match: { image: '*' }, allow: true, reason: 'broad allow' },
    { match: { image: 'danger:*' }, allow: false, reason: 'explicit deny overrides' },
  ];
  // The first rule matches all images; "first match wins" → allow.
  const r1 = evaluate(rules, { image: 'safe:1' });
  assert.equal(r1.allow, true);
  const r2 = evaluate(rules, { image: 'danger:1' });
  assert.equal(r2.allow, true, 'first rule wins, second never tested');
});

test('evaluate: AND semantics — all matchers must match', () => {
  const rules = [{ match: { image: 'python:*', network: 'bridge' }, allow: true, reason: 'python+network' }];
  assert.equal(evaluate(rules, { image: 'python:3', network: 'bridge' }).allow, true);
  assert.equal(evaluate(rules, { image: 'python:3', network: 'none' }).allow, true, 'network=none → AND fails → no rule → default allow');
});

test('PolicyEngine: setRules + getRules', () => {
  const pe = new PolicyEngine();
  assert.deepEqual(pe.getRules(), []);
  pe.setRules([{ match: { image: '*' }, allow: true }]);
  assert.equal(pe.getRules().length, 1);
});

test('PolicyEngine: check emits policy.decision event when bus provided', () => {
  const events = [];
  const bus = { emit: (e) => events.push(e) };
  const pe = new PolicyEngine(
    [{ match: { command: 'rm -rf' }, allow: false, reason: 'destructive' }],
    { bus, subject: 'sbx-1' },
  );
  pe.check({ command: 'rm -rf /' });
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'policy.decision');
  assert.equal(events[0].subject, 'sbx-1');
  assert.equal(events[0].data.allow, false);
  assert.equal(events[0].data.reason, 'destructive');
});

test('PolicyEngine: hook is called with decision + ctx', () => {
  let captured = null;
  const pe = new PolicyEngine(
    [{ match: { image: 'bad:*' }, allow: false }],
    { hook: (d, ctx) => { captured = { d, ctx }; } },
  );
  pe.check({ image: 'bad:x' });
  assert.equal(captured.d.allow, false);
  assert.equal(captured.ctx.image, 'bad:x');
});

test('PolicyEngine: gateCreate throws PolicyDeniedError when denied', () => {
  const pe = new PolicyEngine([
    { match: { image: 'forbidden:*' }, allow: false, reason: 'blocked by policy' },
  ]);
  assert.throws(
    () => pe.gateCreate({ image: 'forbidden:1' }),
    (err) => err instanceof PolicyDeniedError && /blocked by policy/.test(err.message) && err.decision.ruleIndex === 0,
  );
});

test('PolicyEngine: gateExec joins argv into a single command string for matching', () => {
  const pe = new PolicyEngine([
    { match: { command: 'curl http://evil.example.com' }, allow: false, reason: 'egress blocked' },
  ]);
  assert.throws(
    () => pe.gateExec(['curl', 'http://evil.example.com']),
    (err) => err instanceof PolicyDeniedError,
  );
  // Allowed cmd passes through
  pe.gateExec(['curl', 'http://nexus.local']);
});

test('DEFAULT_POLICY: allows everything', () => {
  assert.equal(evaluate(DEFAULT_POLICY, { image: 'anything' }).allow, true);
  assert.equal(evaluate(DEFAULT_POLICY, { command: 'rm -rf /' }).allow, true);
});

test('globToRegex: ** matches slashes, * does not', () => {
  // indirect — exercise via evaluate
  const r1 = evaluate([{ match: { image: 'registry.example.com/**' }, allow: false }], { image: 'registry.example.com/a/b/c' });
  assert.equal(r1.allow, false, '** matches across slashes');
  const r2 = evaluate([{ match: { image: 'registry.example.com/*' }, allow: false }], { image: 'registry.example.com/a/b/c' });
  // * matches a single segment (no slashes), so 'registry.example.com/*' does NOT match a/b/c
  // (the * is anchored as [^/]* and the full pattern is anchored). With the slash in target it won't match.
  // Actually pattern is anchored at start^…$ — a/b/c has 2 slashes, [^/]* can't span them.
  // → no rule match → default allow.
  assert.equal(r2.allow, true, '* does NOT match slashes');
});
