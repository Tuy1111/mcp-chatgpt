import test from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greeting.js';

test('greet returns a personalized greeting', () => {
  assert.equal(greet('MCP'), 'Hello, MCP!');
});
