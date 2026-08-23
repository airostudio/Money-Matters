import { config } from "dotenv";

config();

// Route every test at the isolated test database (mm_app for the RLS-scoped
// app connection, the superuser for migrations/truncation), never at dev
// data. See .env.example and docs/security.md §2.
if (!process.env.TEST_DATABASE_URL || !process.env.TEST_DIRECT_DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL and TEST_DIRECT_DATABASE_URL must be set (see .env.example) to run the test suite.",
  );
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DIRECT_DATABASE_URL = process.env.TEST_DIRECT_DATABASE_URL;
