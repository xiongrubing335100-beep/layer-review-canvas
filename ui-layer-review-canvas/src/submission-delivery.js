export function resolveSubmissionDeliveryMode({
  conversationBridgeOnline = false,
  queued = false,
} = {}) {
  if (queued) return 'conversation_queue';
  if (conversationBridgeOnline) return 'conversation_bridge';
  return 'unavailable';
}
