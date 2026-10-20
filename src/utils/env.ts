import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('5000'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z
    .string()
    .min(16, 'JWT_SECRET must be at least 16 characters')
    .refine((v) =>
      ![
        'your-secret-key-change-in-production',
        'your-secret-key',
        'change-me-to-a-long-random-string',
      ].includes(v),
    {
      message: 'JWT_SECRET is still set to the default placeholder value',
    }),
  ALLOWED_ORIGINS: z.string().default('*'),
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
  SUPER_ADMIN_EMAIL: z.string().email().optional(),
  SUPER_ADMIN_PASSWORD_HASH: z.string().optional(),

  // Feature flags
  WHATSAPP_OTP_ENABLED: z.enum(['true', 'false']).optional(),
  APP_DOMAIN: z.string().default('elgazar.edu'),
  SUPPORT_EMAIL: z.string().default('support@elgazar.edu'),

  // ── Firebase Cloud Messaging (FCM HTTP v1) ───────────────────────────────
  // Off by default: a backend with no Firebase project must still boot and a
  // disabled/misconfigured FCM integration must never fail a notification
  // write. Turning it on makes the three values below mandatory (superRefine).
  FCM_ENABLED: z.enum(['true', 'false']).default('false'),
  FCM_PROJECT_ID: z.string().min(1).optional(),
  FCM_CLIENT_EMAIL: z.string().email().optional(),
  // Service-account private key (the `private_key` field of the JSON key you
  // downloaded from Firebase console → Project settings → Service accounts).
  //
  // Supply it as a SINGLE env var. Real newlines are awkward in .env files and
  // impossible in most CI secret stores, so the documented format is a
  // one-line value with escaped newlines, which is unescaped when signing:
  //
  //   FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n"
  //
  // A real-PEM multi-line value also works. Either way this value is treated as
  // a secret: it is never logged, never returned by any endpoint, and the only
  // place it is read is the RS256 signature in src/utils/fcm.ts.
  FCM_PRIVATE_KEY: z.string().min(1).optional(),
});

const parsed = envSchema.superRefine((data, ctx) => {
  // PostgreSQL is the only supported product database. Previously this guard
  // only rejected one hard-coded SQLite path ('prisma/dev.db'), which meant any
  // OTHER SQLite URL — or a typo'd protocol — booted happily in production and
  // produced an ephemeral or wrong-engine database. Now the protocol itself is
  // enforced, so production cannot start on the wrong engine at all.
  if (data.NODE_ENV === 'production' && !/^postgres(ql)?:\/\//i.test(data.DATABASE_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message:
        'Production must use PostgreSQL (postgresql://). SQLite and other engines are not supported for the product.',
    });
  }


  // FCM is deliberately fail-safe: it is only enforced when someone has
  // explicitly switched it on. Enabling it with a partial service-account key
  // would otherwise look like "push silently doesn't work" forever, so we make
  // the mistake loud at boot instead.
  if (data.FCM_ENABLED === 'true') {
    const missing = (['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY'] as const).filter(
      (key) => (data[key] ?? '').trim() === '',
    );
    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FCM_ENABLED'],
        message: `FCM_ENABLED=true requires a complete service account: ${missing.join(', ')}`,
      });
    }
  }
}).safeParse(process.env);

if (!parsed.success) {
  // Fail fast at boot instead of crashing unpredictably mid-request (e.g. on a missing JWT_SECRET)
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  const details = parsed.error.issues.map((i: any) => '   - ' + i.path.join('.') + ': ' + i.message).join('\n');
  const err: any = new Error('Invalid environment configuration:\n' + details);
  err.details = parsed.error.issues;
  throw err;
}

export const env = parsed.data;
export const APP_DOMAIN: string = process.env.APP_DOMAIN || env.APP_DOMAIN || 'elgazar.edu';
export const SUPPORT_EMAIL: string = process.env.SUPPORT_EMAIL || env.SUPPORT_EMAIL || 'support@elgazar.edu';
