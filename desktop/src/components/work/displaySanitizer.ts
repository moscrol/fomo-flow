const DEFAULT_LIMIT = 220

/**
 * Turn untrusted runtime summaries into short, safe display text.
 *
 * This is intentionally a presentation boundary: it does not attempt to
 * validate or repair the underlying payload and must never be used for
 * commands, paths, or navigation tokens.
 */
export function sanitizeDisplayText(value: unknown, fallback = '', limit = DEFAULT_LIMIT): string {
  if (value === null || value === undefined) return fallback
  const sanitized = String(value)
    // Authorization values can contain many signed fields and tokens. Redact
    // the complete header line before newlines are flattened for display.
    .replace(/\bAuthorization\s*:[^\r\n]*/gi, 'Authorization: [凭据已隐藏]')
    // Also cover credentials copied without their header (Bearer, sk-*, etc.).
    .replace(
      /\b(?:Bearer|Basic|Digest|Token|Api[-_ ]?Key)\s+[A-Za-z0-9._~+/-]+=*/gi,
      '[凭据已隐藏]'
    )
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/gi, '[凭据已隐藏]')
    // Match any absolute POSIX path. URL delimiters and hosts are excluded by
    // the boundary so http(s) paths such as https://host/root stay readable.
    .replace(/(?<![A-Za-z0-9._~%+:/-])(?:file:\/\/)?\/(?!\/)[^\s,;)}\]]+/gi, '[路径已隐藏]')
    .replace(/\b[A-Za-z]:[\\/][^\s,;)}\]]*/g, '[路径已隐藏]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
  return sanitized || fallback
}
