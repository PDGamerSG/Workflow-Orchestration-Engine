import { randomUUID } from "node:crypto";
import type { Db } from "../engine/db";
import { ConflictError, NotFoundError, ValidationError } from "../engine/errors";
import { seal, unseal } from "./crypto";
import { ConnectionSchema, providerFromConnection, type ConnectionConfig, type ProviderFactory } from "./providers";

export type PublicConnection = Omit<ConnectionConfig, "apiKey"> & { id: string; createdAt: number };
type Row = { id: string; owner_id: string; config_json: string; credential: string; created_at: string | number };

export class Connections {
  private constructor(private readonly db: Db, private readonly secret: string, private readonly factory: ProviderFactory) {}

  static async open(db: Db, secret: string, factory: ProviderFactory = providerFromConnection): Promise<Connections> {
    if (secret.length < 32) throw new Error("RELAY_SECRET must contain at least 32 characters");
    await db.exec(`CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, config_json TEXT NOT NULL,
      credential TEXT NOT NULL, created_at BIGINT NOT NULL
    ); CREATE INDEX IF NOT EXISTS connections_owner ON connections(owner_id);`);
    return new Connections(db, secret, factory);
  }

  async list(ownerId: string): Promise<PublicConnection[]> {
    const { rows } = await this.db.query<Row>("SELECT id, config_json, created_at FROM connections WHERE owner_id = $1 ORDER BY created_at DESC", [ownerId]);
    return rows.map(publicOf);
  }

  async create(ownerId: string, input: unknown): Promise<PublicConnection> {
    const parsed = ConnectionSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    if ((await this.list(ownerId)).length >= 10) throw new ConflictError("Remove a connection before adding more than 10.");
    const config = parsed.data;
    try {
      await this.factory(config).generate({ prompt: "Reply with the word connected.", signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new ValidationError(["Check the API key, exact model ID, provider permissions and available quota."], "Could not validate this connection. No key was saved.");
    }
    const { apiKey, ...publicConfig } = config;
    const id = randomUUID();
    const createdAt = Date.now();
    await this.db.query("INSERT INTO connections (id, owner_id, config_json, credential, created_at) VALUES ($1,$2,$3,$4,$5)", [id, ownerId, JSON.stringify(publicConfig), seal(apiKey, this.secret, `${ownerId}:${id}`), createdAt]);
    return { ...publicConfig, id, createdAt };
  }

  private async row(id: string, ownerId: string): Promise<Row> {
    const { rows } = await this.db.query<Row>("SELECT * FROM connections WHERE id = $1 AND owner_id = $2", [id, ownerId]);
    if (!rows[0]) throw new NotFoundError("Connection not found. Add a connection in this browser workspace.");
    return rows[0];
  }

  async get(id: string, ownerId: string): Promise<PublicConnection> { return publicOf(await this.row(id, ownerId)); }

  async runtimeFor(id: string, ownerId: string) {
    const row = await this.row(id, ownerId);
    const config = { ...JSON.parse(row.config_json), apiKey: unseal(row.credential, this.secret, `${ownerId}:${id}`) } as ConnectionConfig;
    return { provider: this.factory(config), config };
  }

  async delete(id: string, ownerId: string): Promise<void> {
    await this.row(id, ownerId);
    await this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM connections WHERE id = $1 FOR UPDATE", [id]);
      const { rows } = await tx.query("SELECT id FROM runs WHERE connection_id = $1 AND status IN ('running','planning') LIMIT 1", [id]);
      if (rows.length) throw new ConflictError("Cancel active runs using this connection before removing its key.");
      await tx.query("DELETE FROM connections WHERE id = $1 AND owner_id = $2", [id, ownerId]);
    });
  }
}

function publicOf(row: Row): PublicConnection {
  return { ...JSON.parse(row.config_json), id: row.id, createdAt: Number(row.created_at) };
}
