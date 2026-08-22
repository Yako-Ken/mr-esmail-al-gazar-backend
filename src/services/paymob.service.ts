import axios from 'axios';
import { env } from '../utils/env';

export interface PaymobCustomer {
  name: string;
  email: string;
  phone: string;
}

export interface PaymobIntentionInput {
  orderId: string;
  courseTitle: string;
  amountMinor: number;
  currency: string;
  customer: PaymobCustomer;
}

export interface PaymobIntentionResult {
  intentionId: string;
  providerOrderId?: string;
  checkoutUrl: string;
}

const normalizeEgyptianPhone = (phone: string): string => {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('01')) return `+2${digits}`;
  if (digits.startsWith('201')) return `+${digits}`;
  return phone;
};

export const isPaymobConfigured = (): boolean => Boolean(
  env.PAYMOB_SECRET_KEY &&
  env.PAYMOB_PUBLIC_KEY &&
  env.PAYMOB_INTEGRATION_ID &&
  env.PAYMOB_HMAC_SECRET,
);

export const createPaymobIntention = async (
  input: PaymobIntentionInput,
): Promise<PaymobIntentionResult> => {
  if (!isPaymobConfigured()) {
    throw new Error('PAYMOB_NOT_CONFIGURED');
  }

  const [firstName, ...remainingNames] = input.customer.name.trim().split(/\s+/);
  const lastName = remainingNames.join(' ') || firstName || 'Customer';
  const callbackBase = env.PRODUCTION_URL?.replace(/\/$/, '');

  const response = await axios.post(
    `${env.PAYMOB_API_BASE_URL.replace(/\/$/, '')}/v1/intention/`,
    {
      amount: input.amountMinor,
      currency: input.currency,
      payment_methods: [Number(env.PAYMOB_INTEGRATION_ID)],
      items: [{
        name: input.courseTitle,
        amount: input.amountMinor,
        description: `Course enrollment ${input.orderId}`,
        quantity: 1,
      }],
      billing_data: {
        first_name: firstName || 'Customer',
        last_name: lastName,
        email: input.customer.email,
        phone_number: normalizeEgyptianPhone(input.customer.phone),
        country: 'EG',
      },
      extras: { merchant_order_id: input.orderId },
      special_reference: input.orderId,
      notification_url: callbackBase ? `${callbackBase}/api/store/paymob/webhook` : undefined,
      redirection_url: callbackBase ? `${callbackBase}/payment/return?orderId=${input.orderId}` : undefined,
    },
    {
      headers: {
        Authorization: `Token ${env.PAYMOB_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 20_000,
    },
  );

  const data = response.data as Record<string, any>;
  const clientSecret = data.client_secret as string | undefined;
  const intentionId = String(data.id ?? data.intention_id ?? '');
  const providerOrderId = data.intention_detail?.order_id != null
    ? String(data.intention_detail.order_id)
    : undefined;

  if (!clientSecret || !intentionId) {
    throw new Error('PAYMOB_INVALID_INTENTION_RESPONSE');
  }

  const checkoutUrl = `${env.PAYMOB_API_BASE_URL.replace(/\/$/, '')}/unifiedcheckout/?publicKey=${encodeURIComponent(env.PAYMOB_PUBLIC_KEY!)}&clientSecret=${encodeURIComponent(clientSecret)}`;
  return { intentionId, providerOrderId, checkoutUrl };
};
