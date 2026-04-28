import { config as loadEnv } from "dotenv";
import path from "node:path";

// Tests use a local Postgres (docker-compose.test.yml). `.env.test` defines
// ADMIN_DATABASE_URL (superuser, for fixtures) and DATABASE_URL (the
// restricted app role). It is NOT the same as the dev `.env`.
loadEnv({ path: path.resolve(__dirname, "..", ".env.test") });

if (!process.env.ADMIN_DATABASE_URL || !process.env.DATABASE_URL) {
  throw new Error(
    "Integration tests require ADMIN_DATABASE_URL and DATABASE_URL. " +
      "Copy .env.test.example to .env.test and start docker-compose.test.yml.",
  );
}
