// FCM HTTP v1 client — protocol only (no Prisma, no domain knowledge).
//
// Why not `firebase-admin`: the only things we need from it are an RS256-signed
// JWT and one HTTPS POST. Doing that with the `axios` + `jsonwebtoken` already in
// package.json keeps the dependency tree (and `npm audit`) untouched.
//
// Security rules for this file:
//   - the private key is only ever passed to `jwt.sign` as an argument
//   - the minted access token is only ever sent in an Authorization header
//   - device tokens are only ever sent in a request body
//   - none of the three is ever included in a log line or an error message
//
// Every function here is total: it reports failure through its return value and
// never throws, because push must never be able to fail a notification write.
import axios, { AxiosError } from 'axios';
import jwt from 'jsonwebtoken';
import { env } from './env';

const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const MESSAGING_SEND_URI = 'https://fcm.googleapis.com/v1/projects';
const MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

// Both calls are short and bounded. A hung socket must not pin a background
// promise (and therefore a worker) forever.
const REQUEST_TIMEOUT_MS = 10_000;

// Refresh a little early so a token can never expire mid-flight.
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Android channel the client registers locally; must match the Dart side. */
const ANDROID_CHANNEL_ID = 'main_channel';

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface FcmOutgoingMessage {
  title: string;
  body: string;
  /** Values are stringified — the HTTP v1 API rejects non-string data payloads. */
  data?: Record<string, unknown>;
}

export interface FcmSendResult {
  ok: boolean;
  /**
   * FCM reported the registration token as permanently invalid (app uninstalled,
   * token rotated, project deleted). The caller should deactivate the token.
   */
  unregistered: boolean;
  /** Safe, credential-free summary for logs. Never contains a token. */
  reason?: string;
}

/**
 * Resolved service-account config, or `null` when push is off or incomplete.
 * `null` is the normal, expected state for local dev and CI — callers treat it
 * as "skip silently", never as an error.
 */
export function readFcmConfig(): FcmConfig | null {
  if (env.FCM_ENABLED !== 'true') return null;

  const projectId = env.FCM_PROJECT_ID?.trim() ?? '';
  const clientEmail = env.FCM_CLIENT_EMAIL?.trim() ?? '';
  const rawKey = env.FCM_PRIVATE_KEY ?? '';

  // env.ts already rejects a partial key at boot when FCM_ENABLED=true, so this
  // is defence in depth rather than a reachable branch.
  if (!projectId || !clientEmail || !rawKey.trim()) return null;

  return { projectId, clientEmail, privateKey: normalizePrivateKey(rawKey) };
}

/**
 * Accepts the documented one-line escaped form and a real multi-line PEM.
 *
 * Escaped form (what CI secret stores and `.env` files should hold):
 *   "-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n"
 * A real PEM already contains real newlines, so the replace is a no-op for it.
 */
function normalizePrivateKey(raw: string): string {
  return raw
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/^["']|["']$/g, '')
    .trim();
}

let cachedAccessToken: { token: string; validUntilMs: number } | null = null;

/** Exposed for tests; clears the memoised access token. */
export function resetFcmAccessTokenCache(): void {
  cachedAccessToken = null;
}

/**
 * Mints an OAuth2 access token via Google's JWT-bearer grant and memoises it
 * until shortly before it expires, so a burst of pushes signs one JWT, not N.
 */
export async function getMessagingAccessToken(
  config: FcmConfig,
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  if (
    cachedAccessToken &&
    cachedAccessToken.validUntilMs - Date.now() > TOKEN_REFRESH_MARGIN_MS
  ) {
    return { ok: true, token: cachedAccessToken.token };
  }

  try {
    const issuedAtSec = Math.floor(Date.now() / 1000);

    // Google requires iss/sub/aud/scope/exp exactly; `exp` is set explicitly
    // because jsonwebtoken refuses to combine it with an `expiresIn` option.
    const assertion = jwt.sign(
      {
        iss: config.clientEmail,
        sub: config.clientEmail,
        scope: MESSAGING_SCOPE,
        aud: TOKEN_URI,
        iat: issuedAtSec,
        exp: issuedAtSec + 3600,
      },
      config.privateKey,
      { algorithm: 'RS256' },
    );

    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const response = await axios.post<{ access_token: string; expires_in?: number }>(
      TOKEN_URI,
      form.toString(),
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );

    const token = response.data?.access_token;
    if (!token) {
      return { ok: false, reason: 'token endpoint returned no access_token' };
    }

    cachedAccessToken = {
      token,
      validUntilMs: Date.now() + (response.data.expires_in ?? 3600) * 1000,
    };
    return { ok: true, token };
  } catch (err) {
    // A rejected token endpoint response carries the assertion in `data`, and a
    // network error carries the full request config — both can leak the key.
    // Only a status code is safe to surface.
    cachedAccessToken = null;
    return { ok: false, reason: describeFcmError(err) };
  }
}

/**
 * Sends one message to one registration token.
 *
 * Never throws. Returns `{ ok: false, unregistered: true }` when FCM says the
 * token is dead so the caller can retire it.
 */
export async function sendHttpV1(
  config: FcmConfig,
  deviceToken: string,
  message: FcmOutgoingMessage,
): Promise<FcmSendResult> {
  const access = await getMessagingAccessToken(config);
  if (!access.ok) {
    // A 401/400 on the token endpoint means the service account itself is bad.
    // The memoised copy would keep replaying it, so drop it.
    resetFcmAccessTokenCache();
    return { ok: false, unregistered: false, reason: access.reason };
  }

  try {
    await axios.post(
      `${MESSAGING_SEND_URI}/${config.projectId}/messages:send`,
      {
        message: {
          token: deviceToken,
          notification: { title: message.title, body: message.body },
          data: stringifyData(message.data),
          android: {
            // 'HIGH' so grades and payment decisions arrive while the phone is idle.
            priority: 'HIGH',
            notification: {
              channelId: ANDROID_CHANNEL_ID,
              clickAction: 'FLUTTER_NOTIFICATION_CLICK',
            },
          },
          apns: {
            headers: { 'apns-priority': '10' },
            payload: {
              aps: {
                alert: { title: message.title, body: message.body },
                sound: 'default',
              },
            },
          },
        },
      },
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${access.token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    return { ok: true, unregistered: false };
  } catch (err) {
    return {
      ok: false,
      unregistered: isUnregistered(err),
      reason: describeFcmError(err),
    };
  }
}

/**
 * HTTP v1 signals a dead registration token with 404 / NOT_FOUND and an
 * `UNREGISTERED` code in `error.details` (older responses only carried the
 * status), so both are checked.
 */
function isUnregistered(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const data = err.response?.data as
    | { error?: { status?: string; details?: Array<Record<string, unknown>> } }
    | undefined;

  const details = data?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (detail?.errorCode === 'UNREGISTERED') return true;
    }
  }
  return data?.error?.status === 'NOT_FOUND';
}

/**
 * A log-safe description of a failure.
 *
 * Axios errors are reduced to a status code on purpose: `err.config.headers`
 * carries `Authorization: Bearer <access token>` and `err.request` can carry the
 * body with the device token. Non-Axios errors (e.g. from jsonwebtoken) do not
 * embed the key, so their message is kept — with any PEM block stripped as a
 * belt-and-braces guard.
 */
function describeFcmError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const axiosErr = err as AxiosError<{
      error?: { status?: string; message?: string };
    }>;
    const status = axiosErr.response?.status;
    const apiStatus = axiosErr.response?.data?.error?.status;
    if (status && apiStatus) return `HTTP ${status} ${apiStatus}`;
    if (status) return `HTTP ${status}`;
    return axiosErr.code ? `network ${axiosErr.code}` : 'network error';
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message.replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[redacted-pem]')}`;
  }
  return 'unknown error';
}

/** HTTP v1 requires every data value to be a string. */
function stringifyData(
  data: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!data) return undefined;
  const entries = Object.entries(data).filter(
    ([, value]) => value !== null && value !== undefined,
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
  );
}