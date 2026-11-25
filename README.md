# TAASCOR Attendance Monitoring System
**Company**: TAASCOR Management & General Services Corp.

A full-stack, enterprise attendance and workforce management web application built for TAASCOR operations across assigned warehouses and areas.

---

## Key Features

- **Role-based access.** Administrators manage accounts and configuration. HR handles approvals and workforce workflows. Head HR (`HEAD_HR`) can review HR registrations and monitor coordinator attendance. Coordinators manage workforce operations for their assigned warehouse. Employees are managed records without login accounts.
- **Company Email Authentication**: Coordinator registration strictly restricted to verified `@taascor.com` email addresses, requiring HR approval and warehouse assignment before access is granted.
- **Warehouse-Level Data Isolation**: Coordinators are strictly restricted to their assigned area. Area checks in the application scope coordinator access.
- **Employee Masterfile**: Active and Inactive views. Inactivation permanently preserves all historical attendance, schedules, and clearance cases.
- **Dynamic Scheduling**: Individual and group scheduling, overnight shifts crossing midnight, conflict detection, and weekly matrix view.
- **Daily Attendance Marking**: Bulk table marking with status differentiation (Present, Late, Absent, On Leave, Rest Day). Confirmed absences automatically trigger or link Back-to-Work cases.
- **Coordinator self-attendance.** Time-In and Time-Out use server timestamps and require a webcam photo. Browser geolocation adds coordinates when available. Coordinators can submit correction requests for HR review.
- **Forum-Style Requests & Concerns Hub**:
  - **Back-to-Work Clearance**: Absence linking, thread updates, authorized return date, and HR decision highlights.
  - **Employee Concerns**: Categories, HR directives, and resolution tracking.
  - **Manpower Requests**: Position breakdown, HR worker allocation (external or transfer), coordinator arrival confirmation, and automatic masterfile registration.
- **Excel (.xlsx) & CSV Export**: Streamed report generation with area-level permissions enforced.
- **Real-Time Notification Polling**: Unread badges and direct link navigation.
- **Audit logs.** Administrators can review recorded actions, timestamps, and IP addresses.

---

## Technology Stack

- **Backend**: Node.js 22 or 24 / Express.js with asynchronous database access
- **Database**: MySQL 8.0.16+ or MariaDB 10.4+, InnoDB, via mysql2
- **Sessions**: Persistent MySQL session storage via express-mysql-session
- **Security**: bcryptjs password hashing, session cookies, rate-limiting, and CSRF protection
- **Frontend**: Server-rendered EJS with vanilla CSS design system in TAASCOR navy, gold, and red accents
- **Reporting**: ExcelJS for native spreadsheet generation
- **Timezone**: Asia/Manila (luxon)

---

## Quick Start (Local Setup)

1. **Install Dependencies**:
   ```bash
   npm ci
   ```

2. **Configure Environment**:
   ```bash
   cp .env.example .env
   ```

   Create a MySQL database and set DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, a randomly generated `SESSION_SECRET`, `ADMIN_EMAIL`, and a unique `ADMIN_PASSWORD` of at least 12 characters in `.env`. Configure the `SMTP_*` settings and `APP_URL` for email verification and password reset links.

3. **Initialize the Database**:
   ```bash
   npm run db:init
   ```

4. **Start the application**
   ```bash
   npm start
   ```
   Open `http://localhost:3000/login`. Use `/health` to check whether the server is responding. The application connects to MySQL and initializes the schema before it starts listening.

   Allow camera access for coordinator Time-In and Time-Out. Use HTTPS for hosted access.

---

For existing SQLite records, import into an empty MySQL database before initialization: `npm run db:import-sqlite -- /path/to/taascor.db`. Follow [the deployment guide](docs/deployment.md) for Hostinger setup, import precautions, and database integration tests.

## Verification

Run `npm test` for the time-handling tests. MySQL integration tests run when `TEST_DB_HOST` is set and require a test database account with permission to create and drop a temporary database. See the [deployment guide](docs/deployment.md#tests) for configuration.

## System accounts

Initial setup creates the first administrator using `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Change the temporary password on first sign-in. Use **User Management** to create HR, Head HR, and coordinator accounts, assign coordinator warehouses, or reset an individual password. Users can sign in with their full email or their username for accounts on `taascor.com`.

## Optional Development Sample Credentials (Seed Data)

`npm run seed` creates additional demo users for local development only and refuses production execution.

| Role | Email | Password | Assigned Area |
| :--- | :--- | :--- | :--- |
| **ADMIN** | Your `ADMIN_EMAIL` | Your `ADMIN_PASSWORD` | System-Wide |
| **HR** | `hr.santos@taascor.com` | `HrUser123!` | System-Wide |
| **COORDINATOR** | `juan.delacruz@taascor.com` | `Coord123!` | Warehouse A - Pasig |
| **COORDINATOR** | `anna.reyes@taascor.com` | `Coord123!` | Warehouse B - Taguig |
| **PENDING** | `mark.garcia@taascor.com` | `Coord123!` | Awaiting HR Approval |

---

## Documentation Links

- [Deployment-prep branch README](https://github.com/RazerJC/employee-tracking-system/blob/codex/taascor-deployment-prep/README.md) covers the newer manpower workflow, role-specific masterlists, and Windows launcher.

- [User Guide](docs/user-guide.md)
- [Production Deployment & Disaster Recovery](docs/deployment.md)
