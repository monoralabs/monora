-- Runs once, as the superuser/owner (monora_owner), when the data directory is
-- first created. Creates the low-privilege role the APP connects as, so RLS is
-- actually enforced (the owner bypasses RLS; app_user does not).
--
-- The password here is the local dev default and must match DATABASE_URL in
-- mise.local.toml (app_user:app_password). For prod, create the role out of
-- band with a real secret; this file is dev-only convenience.
--
-- After this, migrations run as monora_owner (drizzle-kit migrate) and create
-- the tables; ALTER DEFAULT PRIVILEGES below keeps app_user's grants in sync.

CREATE ROLE app_user LOGIN PASSWORD 'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE monora TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Tables/sequences created later (by migrations, owned by monora_owner) inherit
-- these grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- Even if app_user ever owned a table, FORCE RLS keeps policies applying to it.
ALTER DATABASE monora SET row_security = on;
