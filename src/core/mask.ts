// Email masking for everything t3sm prints or writes for people to read (screens, --json, diagnostics that users paste
// into issues): "demo@example.com" becomes "d***@example.com". Pure; no imports.

/** One email address, masked: its first character, then ***@ and the domain. Anything without a local part: "***". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***@${email.slice(at + 1)}`;
}

/**
 * An email address inside free text (Unicode local part and IDN domain; the domain needs a dot and a letter TLD, so a
 * package spec such as `t3sm@t3code-session-manager` or `node@22` in a command is left as it is).
 */
export const EMAIL_RE = /([\p{L}\p{N}])[\p{L}\p{N}\p{M}._%+-]*@([\p{L}\p{N}\p{M}-]+(?:\.[\p{L}\p{N}\p{M}-]+)*\.[\p{L}\p{M}]{2,})/gu;

/**
 * Any token holding an "@" after a non-empty local part: the broad form, for account names. The domain may be a
 * single label ("user@localhost", "a@b") or an IP literal ("user@[10.0.0.5]").
 */
const ADDRESS_RE = /([\p{L}\p{N}])[^\s@,;:<>()[\]"]*@(\[[^\]\s]*\]|[^\s@,;:<>()[\]"]+)/gu;

/** Every email address inside free text masked (EMAIL_RE); the rest unchanged. */
export function maskEmailsIn(text: string): string {
  return text.replace(EMAIL_RE, (_m, a: string, d: string) => `${a}***@${d}`);
}

/** Every token that looks like an address ("x@y", with or without a dot) masked: for names, where no command lives. */
export function maskAddressesIn(text: string): string {
  return text.replace(ADDRESS_RE, (_m, a: string, d: string) => `${a}***@${d}`);
}
