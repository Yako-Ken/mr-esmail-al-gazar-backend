/**
 * Redaction helpers for log lines.
 *
 * Rule L-4: no phone number, email address, personal name, JWT, or password
 * hash may appear in any log at any level. Redaction is applied by ALLOW-LIST
 * (say what is safe) rather than deny-list (try to enumerate what is not), so a
 * new field added to a log call is redacted by default instead of leaking.
 *
 * The masked forms are deliberately still useful for operations: two masked
 * values can be compared for equality, so "is this the same caller?" remains
 * answerable without ever writing the raw value to disk.
 */

/** Egyptian mobile numbers: keep the operator prefix and the last two digits. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return 'none';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-2)}`;
}

/** Email addresses: keep the first character of the local part and the TLD. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return 'none';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const tld = email.slice(email.lastIndexOf('.') + 1);
  return `${email[0]}***@***.${tld}`;
}

/** Personal names: keep the first character only. */
export function maskName(name: string | null | undefined): string {
  if (!name) return 'none';
  return `${name[0]}***`;
}

/**
 * Allow-list projection of a user-ish object for logging.
 * Anything not named here is dropped rather than passed through.
 */
export function redactUser<T extends Record<string, unknown>>(
  user: T,
): Record<string, unknown> {
  const {
    id,
    role,
    status,
    isApproved,
    isVerified,
    phone,
    email,
    name,
    ...rest
  } = user;
  void rest;
  return {
    id,
    role,
    status,
    isApproved,
    isVerified,
    phone: maskPhone(phone as string | null | undefined),
    email: maskEmail(email as string | null | undefined),
    name: maskName(name as string | null | undefined),
  };
}
