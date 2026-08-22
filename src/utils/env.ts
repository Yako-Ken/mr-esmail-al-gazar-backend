import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z
    .string()
    .min(16, 'JWT_SECRET must be at least 16 characters')
    .refine((v) => v !== 'your-secret-key-change-in-production' && v !== 'your-secret-key', {
      message: 'JWT_SECRET is still set to the default placeholder value',
    }),
  ALLOWED_ORIGINS: z.string().default(''),
  EMAIL_USER: z.string().optional(),
  EMAIL_PASS: z.string().optional(),
  BUNNY_STORAGE_ZONE_NAME: z.string().optional(),
  BUNNY_STORAGE_ACCESS_KEY: z.string().optional(),
  BUNNY_CDN_URL: z.string().optional(),
  BUNNY_CDN_TOKEN_KEY: z.string().optional(),
  BUNNY_STORAGE_REGION: z.string().optional(),
  BUNNY_STREAM_API_KEY: z.string().optional(),
  BUNNY_STREAM_LIBRARY_ID: z.string().optional(),
  BUNNY_STREAM_CDN_URL: z.union([z.string().url(), z.literal('')]).optional(),
  BUNNY_STREAM_TOKEN_KEY: z.string().optional(),
  PAYMOB_SECRET_KEY: z.string().optional(),
  PAYMOB_PUBLIC_KEY: z.string().optional(),
  PAYMOB_HMAC_SECRET: z.string().optional(),
  PAYMOB_INTEGRATION_ID: z.string().optional(),
  PAYMOB_API_BASE_URL: z.string().url().default('https://accept.paymob.com'),
  PRODUCTION_URL: z.string().optional(),
  SUPER_ADMIN_PHONE: z.string().optional(),
  SUPER_ADMIN_PASSWORD_HASH: z.string().optional(),

  // Feature flags
  WHATSAPP_OTP_ENABLED: z.enum(['true', 'false']).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast at boot instead of crashing unpredictably mid-request (e.g. on a missing JWT_SECRET)
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
