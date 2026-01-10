import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL");
  }

  if (!global.__pgPool) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });

    // ✅ Neon pooled-safe: set search_path AFTER connect
    pool.on("connect", (client) => {
      // Fire-and-forget is fine here
      client.query(`set search_path to auth,public;`).catch(() => {});
    });

    global.__pgPool = pool;
  }

  return global.__pgPool;
}
