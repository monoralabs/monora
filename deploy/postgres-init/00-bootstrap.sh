#!/bin/sh
# Runs ONCE, on first Postgres init (empty data dir), as the owner role.
# Creates the low-privilege app_user the running app connects as, so RLS is
# actually enforced (the owner bypasses RLS; app_user does not).
#
# The password is taken from $APP_USER_PASSWORD (set in compose from ./.env), so
# no secret is hard-coded here. Tables are created later by drizzle-kit migrate
# (owned by monora_owner); the ALTER DEFAULT PRIVILEGES below keep app_user's
# grants in sync as new tables appear.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
	    CREATE ROLE app_user LOGIN PASSWORD '${APP_USER_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
	  END IF;
	END
	\$\$;

	GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO app_user;
	GRANT USAGE ON SCHEMA public TO app_user;
	GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
	GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

	ALTER DEFAULT PRIVILEGES IN SCHEMA public
	  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
	ALTER DEFAULT PRIVILEGES IN SCHEMA public
	  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

	-- Keep RLS applying even if app_user ever owned a table.
	ALTER DATABASE ${POSTGRES_DB} SET row_security = on;
EOSQL

echo "bootstrap: app_user role ensured."
