// Recreates the scratch database named in DIRECT_DATABASE_URL (drops it first). Scratch DBs only.
const { Pool } = require("pg");
const u = new URL(process.env.DIRECT_DATABASE_URL);
const name = u.pathname.slice(1);
if (!/^mm_p8_/.test(name)) throw new Error("refusing to drop a non-scratch database: " + name);
u.pathname = "/postgres";
u.search = "";
(async () => {
  const p = new Pool({ connectionString: u.toString() });
  await p.query(`drop database if exists ${name} with (force)`);
  await p.query(`create database ${name}`);
  console.log("recreated", name);
  await p.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
