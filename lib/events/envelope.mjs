import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const eventIdFor = (source, tenant, id, type) => 'evt_' + digest([source, tenant, id, type]);
export const fault = (code = 'EVENT_INPUT') => Object.assign(new Error('Event operation refused'), { code });
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max;
export function exact(value, keys) {
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) throw fault();
}
export function validateEnvelope(event) {
  exact(event, ['version', 'eventId', 'name', 'timestamp', 'source', 'origin', 'data', 'contextPolicy']);
  if (event.version !== 1 || !/^evt_[a-f0-9]{64}$/.test(event.eventId) ||
      !text(event.name, 100) || !/^[a-z][a-z0-9_.-]+$/.test(event.name) ||
      !text(event.source, 64) || !/^[a-z][a-z0-9_-]+$/.test(event.source) ||
      !text(event.timestamp, 32) || new Date(event.timestamp).toISOString() !== event.timestamp ||
      event.contextPolicy !== 'origin_event_only' || !record(event.data)) throw fault();
  exact(event.origin, ['tenantId', 'channelId', 'messageId', 'actorId']);
  if (!['tenantId', 'channelId', 'messageId', 'actorId'].every(key => text(event.origin[key], 128)) ||
      event.eventId !== eventIdFor(event.source, event.origin.tenantId, event.origin.messageId, event.name) ||
      Buffer.byteLength(JSON.stringify(event)) > 16384) throw fault();
  return structuredClone(event);
}
