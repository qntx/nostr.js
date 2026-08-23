/**
 * True for `ws:` / `http:` URLs that are not `.onion`.
 * Local-network `ws://` is still insecure; allow those via a trusted set.
 */
export function isInsecureRelayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".onion")) return false;
    return parsed.protocol === "ws:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
