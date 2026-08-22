import { calculatePaymobHmac, verifyPaymobHmac } from './paymobHmac';

const object = {
  amount_cents: 30000,
  created_at: '2026-08-22T00:00:00Z',
  currency: 'EGP',
  error_occured: false,
  has_parent_transaction: false,
  id: 123,
  integration_id: 456,
  is_3d_secure: true,
  is_auth: false,
  is_capture: true,
  is_refunded: false,
  is_standalone_payment: true,
  is_voided: false,
  order: { id: 789 },
  owner: 42,
  pending: false,
  source_data: { pan: '2345', sub_type: 'MasterCard', type: 'card' },
  success: true,
};

describe('Paymob callback HMAC', () => {
  it('verifies a correctly ordered SHA-512 HMAC', () => {
    const signature = calculatePaymobHmac(object, 'test-hmac-secret');
    expect(signature).toHaveLength(128);
    expect(verifyPaymobHmac(object, signature, 'test-hmac-secret')).toBe(true);
  });

  it('rejects changed payment fields and malformed signatures', () => {
    const signature = calculatePaymobHmac(object, 'test-hmac-secret');
    expect(verifyPaymobHmac({ ...object, amount_cents: 1 }, signature, 'test-hmac-secret')).toBe(false);
    expect(verifyPaymobHmac(object, 'bad', 'test-hmac-secret')).toBe(false);
  });
});
