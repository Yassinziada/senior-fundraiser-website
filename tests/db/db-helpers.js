// Test harness: builds a throw-away database from the REAL migration files and
// lets tests run SQL "as" a given signed-in user, exactly like Supabase's API
// does (SET ROLE authenticated + JWT claims), so RLS and grants are exercised.
import pg from 'pg';

// return bigint (int8) as JS numbers, like PostgREST/supabase-js does
pg.types.setTypeParser(20, (v) => Number(v));
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const DB_NAME = 'pos_test';

export const TEST_URL = process.env.TEST_DATABASE_URL;

function withDb(url, db) {
  const u = new URL(url);
  u.pathname = '/' + db;
  return u.toString();
}

export async function createTestDatabase(dbName = DB_NAME, { through } = {}) {
  if (!/^pos_[a-z_]+test$/.test(dbName) && dbName !== DB_NAME) throw new Error('Use a disposable pos_*test database');
  const admin = new pg.Client({ connectionString: TEST_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: withDb(TEST_URL, dbName), max: 10 });
  const files = [
    join(here, 'supabase-stub.sql'),
    ...readdirSync(join(root, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql') && (!through || f <= through)).sort().map((f) => join(root, 'supabase', 'migrations', f)),
    join(root, 'supabase', 'seed.sql'),
    join(root, 'supabase', 'data', 'bazaar_catalog_from_original_pos.sql'),
    join(root, 'supabase', 'data', 'sample_snacks.sql'),
  ];
  const c = await pool.connect();
  try {
    await c.query('set client_min_messages = error');
    for (const f of files) await c.query(readFileSync(f, 'utf8'));
  } finally {
    c.release();
  }
  return pool;
}

/** Simulates the admin-users Edge Function (service role sets app_metadata).
 *  Pass { oneStep: true } to insert the metadata directly (older Auth versions). */
export async function createUser(pool, { email, role, section, username, fullName, rawMeta, oneStep = false }) {
  const meta = rawMeta ?? {
    provider: 'email',
    pos_role: role,
    pos_section: section ?? null,
    pos_username: username,
    pos_full_name: fullName ?? username,
  };
  if (oneStep) {
    const r = await pool.query('insert into auth.users (email, raw_app_meta_data) values ($1, $2) returning id', [email, meta]);
    return r.rows[0].id;
  }
  // Mimic Supabase Auth's admin createUser: INSERT with provider info only,
  // then UPDATE raw_app_meta_data with the app_metadata we passed.
  const { rows } = await pool.query('insert into auth.users (email, raw_app_meta_data) values ($1, $2) returning id', [
    email,
    { provider: 'email', providers: ['email'] },
  ]);
  if (meta.pos_role) {
    await pool.query(`update auth.users set raw_app_meta_data = raw_app_meta_data || $2 where id = $1`, [rows[0].id, meta]);
  }
  return rows[0].id;
}

/**
 * Run one or more statements as a signed-in user (uid) or as anon (uid = null),
 * inside a transaction, the way PostgREST does. Returns the LAST result's rows.
 */
export async function as(pool, uid, sql, params = [], client = null) {
  const c = client ?? (await pool.connect());
  try {
    await c.query('begin');
    await c.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(uid ? { sub: uid, role: 'authenticated' } : { role: 'anon' }),
    ]);
    const res = await c.query(sql, params);
    await c.query('commit');
    return res.rows;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    if (!client) c.release();
  }
}

/** Convenience: call an RPC function returning a single jsonb/scalar value. */
export async function rpc(pool, uid, fn, args = []) {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await as(pool, uid, `select public.${fn}(${ph}) as r`, args);
  return rows[0].r;
}

export const num = (v) => Number(v);
