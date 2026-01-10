import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

function setSearchPath(client: any) {
  // Neon pooled-safe: set after connect / when acquired.
  // We intentionally swallow errors so a transient failure doesn't crash requests.
  client.query(`set search_path to auth,public;`).catch(() => {});
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

    // Runs for brand new connections
    pool.on("connect", (client) => {
      setSearchPath(client);
    });

    // Runs every time a client is checked out of the pool (important for reused conns)
    pool.on("acquire", (client) => {
      setSearchPath(client);
    });

    global.__pgPool = pool;
  }

  return global.__pgPool;
}
