import { createHash, timingSafeEqual } from 'node:crypto';

export type AccessKey = { id: string; token: string };
// Preserve legacy single-space device paths while separating all configured spaces.
export const spaceDeviceId = (space: string, device: string) =>
  space === 'default' ? device : `${space}.${device}`;
const digest = (value: string) => createHash('sha256').update(value).digest();

// IDs are administrator assigned and survive credential rotation. Neither tokens nor device IDs are owners.
export class AccessSpaces {
  private keys: { id: string; hash: Buffer }[];
  readonly ids: Set<string>;
  constructor(token: string, keys: AccessKey[] = []) {
    if (!Array.isArray(keys)) throw new Error('Access keys must be a JSON array.');
    const entries = [...(token ? [{ id: 'default', token }] : []), ...keys];
    if (!entries.length) throw new Error('Configure PROXY_TOKEN or PROXY_ACCESS_KEYS_FILE.');
    this.keys = [];
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.id) ||
        typeof entry.token !== 'string' ||
        entry.token.length < 24 ||
        entry.token.trim() !== entry.token
      )
        throw new Error(
          'Access keys require a stable space ID and a token of at least 24 characters.',
        );
      const hash = digest(entry.token);
      if (this.keys.some((key) => timingSafeEqual(key.hash, hash)))
        throw new Error('Access key credentials must be unique.');
      this.keys.push({ id: entry.id, hash });
    }
    this.ids = new Set(this.keys.map((key) => key.id));
  }
  authenticate(token: string): string | undefined {
    const hash = digest(token);
    // Compare every configured credential, regardless of the matching position.
    let id: string | undefined;
    for (const key of this.keys) if (timingSafeEqual(key.hash, hash)) id = key.id;
    return id;
  }
  spaceForFingerprint(hash: string): string | undefined {
    return this.keys.find((key) => key.hash.toString('hex') === hash)?.id;
  }
}
