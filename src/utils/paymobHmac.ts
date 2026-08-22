import crypto from 'crypto';

const orderedFields = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
] as const;

const valueAtPath = (input: Record<string, any>, path: string): unknown =>
  path.split('.').reduce<unknown>((value, key) =>
    value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : '', input);

export const buildPaymobHmacPayload = (object: Record<string, any>): string =>
  orderedFields.map((field) => String(valueAtPath(object, field) ?? '')).join('');

export const calculatePaymobHmac = (
  object: Record<string, any>,
  secret: string,
): string => crypto.createHmac('sha512', secret)
  .update(buildPaymobHmacPayload(object))
  .digest('hex');

export const verifyPaymobHmac = (
  object: Record<string, any>,
  received: string,
  secret: string,
): boolean => {
  const expected = calculatePaymobHmac(object, secret);
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
};
