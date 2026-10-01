import "server-only";
import { attachDatabasePool } from "@vercel/functions";
import { createRelay, type Relay } from "@relay/server";

// One engine per server instance. Kept on globalThis so dev-mode reloads do not open a second database.
const holder = globalThis as typeof globalThis & { relay?: Promise<Relay> };

export function getRelay(): Promise<Relay> {
  holder.relay ??= createRelay(process.env, { basePath: "/api", onPool: attachDatabasePool }).catch((err) => {
    holder.relay = undefined;
    throw err;
  });
  return holder.relay;
}
