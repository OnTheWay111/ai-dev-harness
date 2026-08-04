\set ON_ERROR_STOP on

-- AutoDev PostgreSQL instance bootstrap.
--
-- Run this file with psql while connected to a maintenance database as a
-- cluster administrator. CREATE DATABASE cannot run inside a transaction, so
-- do not wrap this script in BEGIN/COMMIT.
--
-- Required environment variables (read by psql; never pass them with -v):
--   AUTODEV_MIGRATOR_PASSWORD
--   AUTODEV_APP_PASSWORD
--
-- Optional psql variables:
--   database_name  (default: autodev_dev)
--   migrator_role  (default: autodev_migrator)
--   app_role       (default: autodev_app)

\if :{?database_name}
\else
  \set database_name autodev_dev
\endif
\if :{?migrator_role}
\else
  \set migrator_role autodev_migrator
\endif
\if :{?app_role}
\else
  \set app_role autodev_app
\endif

\getenv migrator_password AUTODEV_MIGRATOR_PASSWORD
\if :{?migrator_password}
\else
  \warn 'AUTODEV_MIGRATOR_PASSWORD is required'
  SELECT 1 / 0 AS missing_autodev_migrator_password;
\endif

\getenv app_password AUTODEV_APP_PASSWORD
\if :{?app_password}
\else
  \warn 'AUTODEV_APP_PASSWORD is required'
  SELECT 1 / 0 AS missing_autodev_app_password;
\endif

SELECT format('CREATE ROLE %I LOGIN', :'migrator_role')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'migrator_role'
)
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS',
  :'migrator_role',
  :'migrator_password'
)
\gexec

SELECT format('CREATE ROLE %I LOGIN', :'app_role')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'app_role'
)
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS',
  :'app_role',
  :'app_password'
)
\gexec

SELECT format(
  'CREATE DATABASE %I OWNER %I',
  :'database_name',
  :'migrator_role'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_database WHERE datname = :'database_name'
)
\gexec

SELECT format(
  'ALTER DATABASE %I OWNER TO %I',
  :'database_name',
  :'migrator_role'
)
\gexec

\connect :database_name

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'database_name')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database_name', :'migrator_role')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database_name', :'app_role')
\gexec

REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'migrator_role')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_role')
\gexec
SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', :'app_role')
\gexec

-- Re-running bootstrap after a migration repairs grants for existing objects.
SELECT format(
  'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
  :'app_role'
)
\gexec
SELECT format(
  'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I',
  :'app_role'
)
\gexec

-- New Alembic-owned objects inherit the runtime role's least-privilege grants.
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  :'migrator_role',
  :'app_role'
)
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
  :'migrator_role',
  :'app_role'
)
\gexec

\echo 'AutoDev PostgreSQL bootstrap complete for database' :database_name
