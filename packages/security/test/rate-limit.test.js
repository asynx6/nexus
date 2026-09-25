import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, SlidingWindow, RateLimitError } from '../src/rate-limit.js';

// Deterministic clock: start at 1000s, advance manually.
let fakeNow = 1_000_000;
const clock = () => fakeNow;

test('TokenBucket allows burst up to capacity then blocks', () => {
  const b = new TokenBucket({ capacity: 3, refillPerSec: 1, clock });
  assert.equal(b.tryConsume('k'), true);
  assert.equal(b.tryConsume('k'), true);
  assert.equal(b.tryConsume('k'), true);
  assert.equal(b.tryConsume('k'), false, '4th in burst should be blocked');
});

test('TokenBucket refills over elapsed time', () => {
  const b = new TokenBucket({ capacity: 2, refillPerSec: 2, clock });
  assert.equal(b.tryConsume('k'), true);
  assert.equal(b.tryConsume('k'), true);
  assert.equal(b.tryConsume('k'), false);
  fakeNow += 1000; // +1s → +2 tokens
  assert.equal(b.tryConsume('k'), true);
  assert.equal(b.tryConsume('k'), true);
  assert.equal(b.tryConsume('k'), false, 'refill is capped at capacity');
});

test('TokenBucket keys are independent', () => {
  const b = new TokenBucket({ capacity: 1, refillPerSec: 1, clock });
  assert.equal(b.tryConsume('a'), true);
  assert.equal(b.tryConsume('a'), false);
  assert.equal(b.tryConsume('b'), true, 'different key has own bucket');
});

test('TokenBucket waitMs is 0 when allowed, else the refill delay', () => {
  const b = new TokenBucket({ capacity: 1, refillPerSec: 2, clock });
  assert.equal(b.waitMs('k'), 0);
  b.tryConsume('k');
  assert.equal(b.waitMs('k'), 500, '0.5 token deficit at 2/s = 500ms');
});

test('TokenBucket reset clears per-key state', () => {
  const b = new TokenBucket({ capacity: 1, refillPerSec: 1, clock });
  b.tryConsume('k');
  assert.equal(b.tryConsume('k'), false);
  b.reset('k');
  assert.equal(b.tryConsume('k'), true);
});

test('TokenBucket rejects bad config', () => {
  assert.throws(() => new TokenBucket({ capacity: 0, refillPerSec: 1 }), /capacity/);
  assert.throws(() => new TokenBucket({ capacity: 1, refillPerSec: -1 }), /refillPerSec/);
});

test('SlidingWindow allows max hits then blocks', () => {
  const w = new SlidingWindow({ max: 3, windowMs: 10_000, clock });
  assert.equal(w.tryHit('k'), true);
  assert.equal(w.tryHit('k'), true);
  assert.equal(w.tryHit('k'), true);
  assert.equal(w.tryHit('k'), false, '4th hit within window must be blocked');
});

test('SlidingWindow counts only hits in the window', () => {
  const w = new SlidingWindow({ max: 2, windowMs: 10_000, clock });
  w.tryHit('k');
  w.tryHit('k');
  assert.equal(w.tryHit('k'), false);
  fakeNow += 10_001; // window slides past the first hits
  assert.equal(w.tryHit('k'), true, 'old hits must not count');
  assert.equal(w.count('k'), 1);
});

test('SlidingWindow keys are independent', () => {
  const w = new SlidingWindow({ max: 1, windowMs: 10_000, clock });
  assert.equal(w.tryHit('a'), true);
  assert.equal(w.tryHit('a'), false);
  assert.equal(w.tryHit('b'), true);
});

test('SlidingWindow drops stale entries so memory cannot grow unbounded', () => {
  const w = new SlidingWindow({ max: 1000, windowMs: 1000, clock });
  for (let i = 0; i < 5000; i++) { w.tryHit('k'); fakeNow += 1; }
  // Every call prunes entries older than the window.
  assert.ok(w.hits.get('k').length <= 1001, 'stale hits must be pruned');
});

test('SlidingWindow rejects bad config', () => {
  assert.throws(() => new SlidingWindow({ max: 0, windowMs: 100 }), /max/);
  assert.throws(() => new SlidingWindow({ max: 1, windowMs: 0 }), /windowMs/);
});

test('RateLimitError carries retry metadata', () => {
  const e = new RateLimitError('too fast', { key: 'a', limit: 5, retryAfterMs: 250 });
  assert.equal(e.name, 'RateLimitError');
  assert.equal(e.key, 'a');
  assert.equal(e.limit, 5);
  assert.equal(e.retryAfterMs, 250);
});
