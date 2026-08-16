import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSubmissionDeliveryMode } from './submission-delivery.js';

test('an embedded MCP app also requires the current conversation listener', () => {
  assert.equal(resolveSubmissionDeliveryMode({
    requestedMcpApp: true,
    conversationBridgeOnline: true,
  }), 'conversation_bridge');
  assert.equal(resolveSubmissionDeliveryMode({
    requestedMcpApp: true,
    conversationBridgeOnline: false,
  }), 'unavailable');
});

test('a browser workbench with an online listener uses the visible conversation bridge', () => {
  assert.equal(resolveSubmissionDeliveryMode({
    requestedMcpApp: false,
    conversationBridgeOnline: true,
  }), 'conversation_bridge');
});

test('a browser workbench never falls back to an invisible background turn', () => {
  assert.equal(resolveSubmissionDeliveryMode({
    requestedMcpApp: false,
    conversationBridgeOnline: false,
  }), 'unavailable');
});

test('a busy conversation accepts a queued split while the listener is temporarily offline', () => {
  assert.equal(resolveSubmissionDeliveryMode({
    conversationBridgeOnline: false,
    queued: true,
  }), 'conversation_queue');
});
