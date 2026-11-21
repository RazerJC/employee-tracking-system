# Hostinger deployment and MySQL migration

This application uses Node.js, Express, EJS, and MySQL. Login sessions are stored in the same MySQL database. Application restarts do not discard active sessions as long as SESSION_SECRET stays unchanged.

## Requirements

- Hostinger Business Web Hosting or a Cloud plan with Node.js Web Apps enabled, or a VPS.
- Node.js 22 or 24, MySQL 8.0.16+ or MariaDB 10.4+.
- A database and database user created in hPanel. Use the exact database hostname, name, username, and password shown by Hostinger.
- HTTPS for production cookies and an SMTP mailbox for verification and password-reset emails.

Official deployment instructions: https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/

## Prepare a new database

Copy .env.example to .env for local commands, or set the values in the hosting panel:

- DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
- DB_CONNECTION_LIMIT (default 5; respect your hosting account limits)
- DB_SSL=true only when the database endpoint supports/requires TLS. DB_SSL_CA can point to the provider CA file. Certificate validation remains enabled.
- SESSION_SECRET: generate a random value with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- ADMIN_EMAIL and a unique ADMIN_PASSWORD of at least 12 characters. These are used only when no administrator exists.
- NODE_ENV=production, APP_URL=https://your-domain, TZ=Asia/Manila
- SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM

Never commit .env or database backups. Keep SESSION_SECRET unchanged across deployments to preserve logins.

For a fresh installation:

```sh
npm ci
npm run db:init
npm start
```

Startup also creates missing tables and the first administrator. It fails before listening if the database is unavailable. The database user needs CREATE, ALTER (for schema upgrades), and normal SELECT/INSERT/UPDATE/DELETE permissions for automatic initialization. Tables use InnoDB, foreign keys, unique constraints, UTF-8, and UTC timestamps.

Create HR, Head HR, and Coordinator accounts through **User Management**. Assign each coordinator to their warehouse. For existing installations that previously used the shared account passwords, change those passwords individually before opening the deployment to users.

## Import the existing SQLite database

Perform the import before starting the web application or running db:init (which creates an administrator). Stop writes in the old application, retain a backup, and point the environment to a NEW EMPTY MySQL database.

```sh
npm ci
npm run db:import-sqlite -- "/absolute/path/to/taascor.db"
npm start
```

Run the importer from a machine allowed to connect to the destination database. If Hostinger restricts remote MySQL access, use its supported remote access setup or import on a machine with permitted connectivity.

The importer opens SQLite read-only, reads a consistent snapshot, checks source foreign keys, preserves IDs/password hashes, converts ISO timestamps to UTC, checks row counts, and commits the data in one transaction. It refuses nonempty targets, unknown source columns, and invalid calendar dates. Dates must use YYYY-MM-DD with a year of at least 1000; ambiguous legacy dates are never guessed. Errors identify the table/record and roll back imported rows; newly created empty tables may remain. Do not run the web application during import. The importer does not create sessions; users log in again after migrating from SQLite.

Keep the original SQLite file locally until the migrated records have been checked. It is excluded from uploads and Docker builds. Newly uploaded profile photos (up to 2MB) are stored in MySQL. Existing photos referenced by local paths must be re-uploaded through the profile page or copied with the corresponding static files before retiring the old application.

## Deploy from GitHub

1. In Hostinger, add a Node.js Web App and connect the employee-tracking-system repository.
2. Choose the branch containing this MySQL application and the Express framework.
3. Select Node.js 22 or 24. Set entry file to server.js and start command to npm start.
4. Install dependencies with npm ci --omit=dev. EJS and static assets need no frontend compilation or dist directory.
5. Set the environment variables above. Hostinger may supply PORT; let the application use it.
6. Deploy, connect the domain, and enable HTTPS.
7. Check /health, log in, verify attendance and reports, and test an email verification or password-reset message.
8. Redeploy once and verify the same login still works and attendance remains present.

Do not use npm run seed on production. It creates demo records and accounts and is disabled under NODE_ENV=production.

## Tests

`npm test` runs the time-handling tests. Database integration tests run when TEST_DB_HOST and TEST_DB_USER are supplied; TEST_DB_PORT and TEST_DB_PASSWORD are optional.

```powershell
$env:TEST_DB_HOST = '127.0.0.1'
$env:TEST_DB_PORT = '3306'
$env:TEST_DB_USER = 'test_user'
npm test
```

The test user needs CREATE/DROP DATABASE permission. Tests create and remove only a unique taascor_test_* database. They cover schema constraints, SQLite import, rollback, the eight business verification scenarios, simultaneous absence submissions, role access, report rendering, and session persistence across restarts. Never point tests at production credentials.

## Backups and recovery

Use Hostinger database backups or phpMyAdmin export. On a machine with a MySQL dump client, npm run backup creates a consistent SQL dump under db/backups. MYSQLDUMP_PATH can point to mysqldump or mariadb-dump. Database passwords are passed via the subprocess environment, not command-line arguments. For TLS endpoints use a dump client configured with verified TLS or the provider backup tools.

Restore a backup into a separate empty database and check its records before changing DB_NAME. Backups contain private workforce data and must be stored securely.

## Legacy utilities

Old one-off SQLite maintenance tools are archived locally under db/legacy-sqlite and excluded from uploads. db/schema.sqlite.sql is retained for import tests. All application routes, services, authentication, and session storage use db/database.js (MySQL); SQLite is used only by the explicit migration command and its tests.
