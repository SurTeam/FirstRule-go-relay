import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CORS_ALLOW_HEADERS, corsHeaders, isCorsPreflight } from '../shared.mjs';

describe('browser CORS for /c/<token> clients', () => {
  it('allows the session binding header used by relay/web', () => {
    assert.match(CORS_ALLOW_HEADERS, /\bx-firstrule-session\b/i);
    const headers = corsHeaders({ origin: 'https://example.com' });
    assert.equal(headers['access-control-allow-origin'], 'https://example.com');
    assert.match(headers['access-control-allow-headers'], /\bx-firstrule-session\b/i);
  });

  it('treats OPTIONS as preflight', () => {
    assert.equal(isCorsPreflight('OPTIONS'), true);
    assert.equal(isCorsPreflight('POST'), false);
  });
});
