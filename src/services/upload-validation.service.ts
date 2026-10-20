import fs from 'fs';

/**
 * Content-based upload validation.
 *
 * What a file *claims* to be — `originalname`'s extension, the client-supplied
 * `Content-Type`, the multipart field name — is entirely under the uploader's
 * control. `avatar.jpg` with `Content-Type: image/jpeg` can carry a PHP web
 * shell, an ELF binary, or a zip archive, and any check that reads those strings
 * is a check the attacker writes. The only input a client cannot forge is the
 * bytes, so this module decides acceptance from the leading file signature
 * ("magic bytes") and derives the stored extension from the same read.
 *
 * Image formats covered are the ones the product accepts for course/lesson
 * thumbnails: JPEG, PNG, WebP and GIF. PDFs get the same treatment because the
 * homework-PDF field had the identical hole and the check is one signature.
 *
 * multer is pinned at ^1.4.5-lts.1 in package.json. In that line `fileFilter`
 * receives only the request and the file *headers* — never the payload — so a
 * `fileFilter` cannot do this job. Storage here is `multer.diskStorage`, which
 * means the bytes are on disk by the time a handler runs, and the signature is
 * read with a bounded `read` of the first kilobyte. Nothing here loads a whole
 * file into the heap, and no new middleware is introduced.
 *
 * Video is deliberately NOT checked here, for two reasons that are structural
 * rather than cautious: `/chunk` assembles arbitrary fragments, and a fragment
 * legitimately has no `ftyp` box until the last one arrives, so a signature
 * check would either reject every legitimate chunked upload or be trivially
 * bypassed. Videos also travel a second, signature-free path (Bunny Stream /
 * TUS), which the acceptance decision cannot cover from inside this file.
 */

/** How many leading bytes a signature decision is allowed to look at. */
const HEAD_BYTES = 1024;

export type ContentKind = 'image' | 'pdf';

export interface DetectedContent {
  kind: ContentKind;
  format: string;
  mime: string;
  extension: string;
}

/** The multipart fields whose contents this module is able to verify. */
export type VerifiedUploadField = 'thumbnail' | 'pdf';

const EXPECTED_KIND: Record<VerifiedUploadField, ContentKind> = {
  thumbnail: 'image',
  pdf: 'pdf',
};

interface Signature {
  kind: ContentKind;
  format: string;
  mime: string;
  extension: string;
  matches: (head: Buffer) => boolean;
}

const startsWithBytes = (head: Buffer, bytes: readonly number[]): boolean =>
  head.length >= bytes.length && bytes.every((b, i) => head[i] === b);

const asciiAt = (head: Buffer, offset: number, text: string): boolean =>
  head.length >= offset + text.length &&
  head.subarray(offset, offset + text.length).toString('latin1') === text;

/**
 * `%PDF-` is normally at offset 0. The spec tolerates a small amount of
 * preceding junk, so leading whitespace is accepted — but only whitespace, which
 * keeps an attacker from prefixing a payload with the marker to smuggle it past
 * the check.
 */
const PDF_MARKER = '%PDF-';
const isPdf = (head: Buffer): boolean => {
  const text = head.toString('latin1');
  const at = text.indexOf(PDF_MARKER);
  if (at < 0) return false;
  for (let i = 0; i < at; i++) {
    const code = text.charCodeAt(i);
    const isSpace =
      code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
    if (!isSpace && code !== 0x00) return false;
  }
  return true;
};

const SIGNATURES: Signature[] = [
  {
    kind: 'image',
    format: 'jpeg',
    mime: 'image/jpeg',
    extension: '.jpg',
    matches: (head) => startsWithBytes(head, [0xff, 0xd8, 0xff]),
  },
  {
    kind: 'image',
    format: 'png',
    mime: 'image/png',
    extension: '.png',
    matches: (head) =>
      startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    kind: 'image',
    format: 'webp',
    mime: 'image/webp',
    extension: '.webp',
    matches: (head) => asciiAt(head, 0, 'RIFF') && asciiAt(head, 8, 'WEBP'),
  },
  {
    kind: 'image',
    format: 'gif',
    mime: 'image/gif',
    extension: '.gif',
    matches: (head) => asciiAt(head, 0, 'GIF87a') || asciiAt(head, 0, 'GIF89a'),
  },
  {
    kind: 'pdf',
    format: 'pdf',
    mime: 'application/pdf',
    extension: '.pdf',
    matches: isPdf,
  },
];

/** Human-readable list, used in the client-facing rejection message. */
const ACCEPTED_DESCRIPTION: Record<ContentKind, string> = {
  image: 'a JPEG, PNG, WebP or GIF image',
  pdf: 'a PDF document',
};

const readHead = (file: Express.Multer.File): Buffer => {
  if (file.buffer && file.buffer.length > 0) {
    return file.buffer.subarray(0, HEAD_BYTES);
  }
  if (!file.path) return Buffer.alloc(0);
  const fd = fs.openSync(file.path, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
};

export const detectContent = (file: Express.Multer.File): DetectedContent | null => {
  const head = readHead(file);
  if (head.length === 0) return null;
  const match = SIGNATURES.find((signature) => signature.matches(head));
  if (!match) return null;
  return {
    kind: match.kind,
    format: match.format,
    mime: match.mime,
    extension: match.extension,
  };
};

export interface ValidatedField {
  format: string;
  mime: string;
  extension: string;
}

export interface ValidationFailure {
  field: VerifiedUploadField;
  expected: ContentKind;
  detected: string | null;
  message: string;
}

export type ValidationResult =
  | { ok: true; fields: Partial<Record<VerifiedUploadField, ValidatedField>> }
  | { ok: false; failure: ValidationFailure };

/**
 * Verifies every present file against the kind its field is supposed to hold.
 *
 * All-or-nothing on purpose: a caller must learn that the request was refused
 * before anything is streamed to remote storage, so the first mismatch is
 * returned and no partial upload is performed.
 */
export const validateUploadedFiles = (
  files: Partial<Record<VerifiedUploadField, Express.Multer.File | undefined>>,
): ValidationResult => {
  const fields: Partial<Record<VerifiedUploadField, ValidatedField>> = {};

  for (const field of Object.keys(EXPECTED_KIND) as VerifiedUploadField[]) {
    const file = files[field];
    if (!file) continue;

    const expected = EXPECTED_KIND[field];
    const detected = detectContent(file);

    if (!detected || detected.kind !== expected) {
      return {
        ok: false,
        failure: {
          field,
          expected,
          detected: detected ? detected.format : null,
          // Never echo back the client's filename or Content-Type, and never
          // name the detected format: both are attacker-supplied hints and the
          // detected format is only useful to someone probing the filter.
          message: `Rejected: the uploaded "${field}" is not ${ACCEPTED_DESCRIPTION[expected]}. The file's content does not match the type required for this field.`,
        },
      };
    }

    fields[field] = { format: detected.format, mime: detected.mime, extension: detected.extension };
  }

  return { ok: true, fields };
};