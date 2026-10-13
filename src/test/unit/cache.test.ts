import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompletionCache } from '../../core/cache';

describe('CompletionCache', () => {
  it('returns the rest of a suggestion as the user types through it', () => {
    const cache = new CompletionCache();
    cache.set('const total = ', ';', 'items.length');
    assert.equal(cache.get('const total = ', ';'), 'items.length');
    assert.equal(cache.get('const total = item', ';'), 's.length');
  });

  it('misses when the typing diverges, the suggestion is used up, or the code after the cursor changed', () => {
    const cache = new CompletionCache();
    cache.set('const total = ', ';', 'items.length');
    assert.equal(cache.get('const total = x', ';'), undefined);
    assert.equal(cache.get('const total = items.length', ';'), undefined);
    assert.equal(cache.get('const total = ', ''), undefined);
  });

  it('forgets the oldest entries beyond its capacity', () => {
    const cache = new CompletionCache(2);
    cache.set('a', '', '1');
    cache.set('b', '', '2');
    cache.set('c', '', '3');
    assert.equal(cache.get('a', ''), undefined);
    assert.equal(cache.get('b', ''), '2');
    assert.equal(cache.get('c', ''), '3');
  });
});
