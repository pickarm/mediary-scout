import { Pool } from "pg";

let pool: Pool | null = null;

/** Shared, lazy library/authentication pool; importing this module opens no connection. */
export function getLibraryDatabasePool(): Pool {
  if (!pool) {
    const connectionString = process.env.MEDIA_TRACK_POSTGRES_URL?.trim();
    if (!connectionString) {
      throw new Error("MEDIA_TRACK_POSTGRES_URL is required (the SQLite dev DB has been retired)");
    }
    pool = new Pool({ connectionString, max: 4, application_name: "mediary-library-api" });
  }
  return pool;
}
