/**
 * Shared SSRF hostname blocklist.
 *
 * Used by API routes that fetch external URLs (e.g., ARC-19 metadata)
 * to prevent server-side request forgery against internal services.
 */
export function isBlockedHostname(rawHostname: string): boolean {
  // Normalize: lowercase, strip IPv6 brackets
  let hostname = rawHostname.toLowerCase().trim();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }

  // Exact matches
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "0" ||
    hostname === "::1" ||
    hostname === "::ffff:127.0.0.1" ||
    hostname === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  // Suffix matches for local/internal TLDs
  if (
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".localhost")
  ) {
    return true;
  }
  // Private IPv4 ranges (including link-local)
  if (
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("169.254.") ||
    hostname.startsWith("0.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^127\./.test(hostname)
  ) {
    return true;
  }
  // Octal IP notation: 0177.0.0.1 = 127.0.0.1, etc.
  if (/^0\d{1,3}\.0?\d{1,3}\.0?\d{1,3}\.0?\d{1,3}$/.test(hostname)) {
    return true;
  }
  // Decimal IP notation: 2130706433 = 127.0.0.1, etc.
  if (/^\d+$/.test(hostname)) {
    const num = Number(hostname);
    if (Number.isFinite(num) && num >= 0 && num <= 0xffffffff) {
      return true;
    }
  }
  // IPv4-mapped IPv6 addresses: ::ffff:X.X.X.X
  const v4MappedMatch = hostname.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch) {
    // Recursively check the embedded IPv4 address
    if (isBlockedHostname(v4MappedMatch[1])) {
      return true;
    }
  }
  // IPv6 private ranges: fc00::/7 (unique local), fe80::/10 (link-local)
  if (
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80")
  ) {
    return true;
  }
  // Cloud metadata endpoints
  if (
    hostname === "metadata.google.internal" ||
    hostname === "169.254.169.254" ||
    hostname === "instance-data.ec2.internal"
  ) {
    return true;
  }
  return false;
}
