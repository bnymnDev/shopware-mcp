import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A random value for tokens and ids: 32 bytes, URL-safe. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** Tokens are stored as their SHA-256 only: a leaked data file hands out no access. */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("base64url");

/**
 * The key that seals shop credentials, from SHOPWARE_MCP_SECRET_KEY: 32 bytes as hex (64
 * characters) or base64. Without it the hosted mode refuses to start.
 */
export function parseSecretKey(value: string | undefined): Buffer {
  const text = value?.trim() ?? "";
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  if (key.length !== 32) {
    throw new Error(
      "SHOPWARE_MCP_SECRET_KEY must be 32 bytes, as 64 hex characters or base64 " +
        "(e.g. `openssl rand -hex 32`)",
    );
  }
  return key;
}

/** AES-256-GCM: iv, tag and ciphertext in one string. */
export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}

export function open(key: Buffer, sealed: string): string {
  const [iv, tag, data] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !data) throw new Error("Malformed sealed value");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** An OAuth client: registered dynamically, or known by its metadata document URL. */
export interface ClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

/** One shop connected by one person: the Integration keys, sealed. */
export interface ConnectionRecord {
  id: string;
  shopUrl: string;
  /** `seal(JSON.stringify({ clientId, clientSecret }))` */
  credentials: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface TokenRecord {
  connectionId: string;
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

interface Data {
  clients: Record<string, ClientRecord>;
  connections: Record<string, ConnectionRecord>;
  /** By token hash. */
  accessTokens: Record<string, TokenRecord>;
  /** By token hash. */
  refreshTokens: Record<string, TokenRecord>;
}

const EMPTY: Data = { clients: {}, connections: {}, accessTokens: {}, refreshTokens: {} };

/**
 * Everything the hosted mode keeps, in one JSON file written atomically. One process serves
 * all requests, so a file is enough; it holds no plain secret and no plain token.
 */
export class Store {
  private data: Data;
  private readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "hosted.json");
    try {
      this.data = { ...EMPTY, ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<Data>) };
    } catch {
      this.data = structuredClone(EMPTY);
    }
  }

  private save(): void {
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  client(id: string): ClientRecord | undefined {
    return this.data.clients[id];
  }

  putClient(record: ClientRecord): void {
    this.data.clients[record.clientId] = record;
    this.save();
  }

  connection(id: string): ConnectionRecord | undefined {
    return this.data.connections[id];
  }

  putConnection(record: ConnectionRecord): void {
    this.data.connections[record.id] = record;
    this.save();
  }

  /** Marks a connection as used, at most once an hour so reads do not rewrite the file. */
  touch(id: string, now = Date.now()): void {
    const connection = this.data.connections[id];
    if (!connection) return;
    if (now - Date.parse(connection.lastUsedAt) < 3_600_000) return;
    connection.lastUsedAt = new Date(now).toISOString();
    this.save();
  }

  issue(kind: "accessTokens" | "refreshTokens", token: string, record: TokenRecord): void {
    this.data[kind][hashToken(token)] = record;
    this.save();
  }

  find(kind: "accessTokens" | "refreshTokens", token: string, now = Date.now()) {
    const record = this.data[kind][hashToken(token)];
    return record && record.expiresAt > now ? record : undefined;
  }

  revoke(kind: "accessTokens" | "refreshTokens", token: string): boolean {
    const hash = hashToken(token);
    if (!this.data[kind][hash]) return false;
    delete this.data[kind][hash];
    this.save();
    return true;
  }

  /** Drop expired tokens and connections no token points to any more. */
  sweep(now = Date.now()): void {
    let changed = false;
    for (const kind of ["accessTokens", "refreshTokens"] as const) {
      for (const [hash, record] of Object.entries(this.data[kind])) {
        if (record.expiresAt <= now) {
          delete this.data[kind][hash];
          changed = true;
        }
      }
    }
    const live = new Set(
      [...Object.values(this.data.accessTokens), ...Object.values(this.data.refreshTokens)].map(
        (record) => record.connectionId,
      ),
    );
    for (const [id, connection] of Object.entries(this.data.connections)) {
      // A connection whose code has not been exchanged yet has no token; give it time.
      const young = now - Date.parse(connection.createdAt) < 30 * 60_000;
      if (!live.has(id) && !young) {
        delete this.data.connections[id];
        changed = true;
      }
    }
    if (changed) this.save();
  }
}
