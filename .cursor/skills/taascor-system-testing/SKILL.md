---
name: taascor-system-testing
description: Tests the TAASCOR Attendance Monitoring System on localhost. Use for TAASCOR QA, CRUD testing, regression checks, role and warehouse permissions, database migration, attendance, or webcam and GPS verification.
---

# TAASCOR system testing

## Run the system tests

1. Work from the TAASCOR project root. Inspect `package.json`, `tests/mysql.test.js`, and the Tests section of `docs/deployment.md` for the current commands and coverage.
2. Smoke-test the running app with GET `http://localhost:3000/health` and `http://localhost:3000/login`. Confirm HTTP 200, `status: ok` for health, and TAASCOR content on the login page. Use the port configured for the local server if different. If startup fails, read the app logs and check the configured MariaDB connection without printing credentials.
3. Run `npm.cmd test` on Windows, or `npm test` elsewhere, with `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER`, and optional `TEST_DB_PASSWORD` set to a dedicated test MariaDB instance. The test user needs create and drop privileges for the generated `taascor_test_*` database. An unset `TEST_DB_HOST` skips the database suite. Check the final skipped and failure counts.
4. If no dedicated server is running on Windows, provision a new temporary XAMPP MariaDB data directory with `mysql_install_db.exe`. Start `mysqld.exe` with `--no-defaults`, the XAMPP base directory, that temporary data directory, loopback binding, and an unused port. Wait for the test database to accept connections and stop only that process after the tests. Keep test writes, fixture seeding, and destructive checks inside the disposable database.
5. Reproduce requested workflows through local browser actions or authenticated HTTP requests against the test instance. Use each form's CSRF token and a separate session per role. Confirm redirects and displayed results, then verify that the database state matches the expected action.

## Exercise core workflows

- Employees and departments. Create, list or open, edit, assign, and remove test records. Employee deletion marks the employee inactive. Verify that deleting a department with an assigned employee is rejected, then detach the employee and retry.
- Accounts. Exercise Admin, Head HR, HR, and Coordinator permissions. Check provisioning, password reset, suspension of an active session, reactivation, coordinator approval, and warehouse restrictions.
- Attendance and schedules. Create and edit a schedule, save attendance, reload, and check reports and exports. Exercise Time-In and Time-Out and verify the saved photo, GPS coordinates, accuracy, and server timestamps.
- Workflows. Submit and resolve incidents and concerns, create and process manpower requests, record a Back-to-Work decision, and check notification and audit records.
- Database. Verify schema initialization, SQLite import, transaction rollback, and session persistence through restart. Use the disposable target for all migration and restart tests.

## Check camera and GPS

Use localhost or HTTPS. With a simulated or physical device, check that Capture remains disabled until the first video frame. Exercise a preview timeout and retry, a successful nonblack capture, and camera release after closing or submitting. Confirm that Time-In and Time-Out stamp the capture time, recent GPS coordinates, and accuracy on the photo and send the same coordinates with the form. Test denied GPS, a retake, and reopening the modal to check that old coordinates do not carry over. Identify physical devices and real email delivery that were outside the test run.

## Report results

Report the environment, actual pass/fail/skip counts, and the specific actions verified. For a failure, give the role, action, expected and observed behavior, and the relevant route or log. Fix and rerun when the user requested a fix. Distinguish live health checks, simulated-device checks, and physical-device verification.
