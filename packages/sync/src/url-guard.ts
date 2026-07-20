/**
 * Client-side SSRF guard for user-supplied sync backend URLs.
 *
 * The extension constructs WebDAV / Worker backends from a URL the user types
 * into the options page (or that arrives via an imported settings snapshot).
 * Without validation a mistyped or attacker-authored value could point the
 * browser's `fetch` at an internal address — cloud metadata endpoints, router
 * admin panels, or loopback services — turning the extension into an SSRF
 * proxy. We therefore reject non-http(s) schemes and any host that is a literal
 * private / loopback / link-local IP or a localhost alias before any request is
 * issued. DNS names are not resolved here (impossible synchronously in the
 * browser); this guard blocks the literal-IP and localhost cases only.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost"]);

/**
 * Returns an error string if the URL must not be contacted, or `null` when the
 * URL is an acceptable remote http(s) endpoint.
 */
export function validateRemoteUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `Invalid URL: ${raw}`;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Only http(s) URLs are allowed (got "${url.protocol}")`;
  }

  // URL.hostname keeps IPv6 literals wrapped in brackets; strip them.
  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

  if (LOOPBACK_HOSTNAMES.has(host) || host.endsWith(".localhost")) {
    return `Refusing to sync to a loopback host: ${host}`;
  }

  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    return `Refusing to sync to a private/loopback address: ${host}`;
  }

  return null;
}

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 ("this" network)
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

function isPrivateIpv6(host: string): boolean {
  if (!host.includes(":")) return false;
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified

  // IPv4-mapped (::ffff:192.168.0.1) — evaluate the embedded v4 address.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mapped) return isPrivateIpv4(mapped[1]);

  const firstGroup = h.split(":")[0];
  // fc00::/7 unique-local (fc.. / fd..)
  if (firstGroup.startsWith("fc") || firstGroup.startsWith("fd")) return true;
  // fe80::/10 link-local (fe8.. / fe9.. / fea.. / feb..)
  if (/^fe[89ab]/.test(firstGroup)) return true;
  return false;
}
