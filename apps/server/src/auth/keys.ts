// Generación y hashing de API keys (formato pb_<random>, hash SHA-256; spec §5).

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `pb_${Buffer.from(bytes).toString("base64url")}`;
}

export function hashApiKey(key: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(key);
  return hasher.digest("hex");
}
