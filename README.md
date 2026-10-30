# TAASCOR Attendance Monitoring System
**Company**: TAASCOR Management & General Services Corp.

A full-stack, enterprise attendance and workforce management web application built for TAASCOR operations across assigned warehouses and areas.

---

## Key Features

- **Strict Three-Role Architecture**: `ADMIN`, `HR`, and `COORDINATOR`. Employees are managed records without login accounts.
- **Company Email Authentication**: Coordinator registration strictly restricted to verified `@taascor.com` email addresses, requiring HR approval and warehouse assignment before access is granted.
- **Warehouse-Level Data Isolation**: Coordinators are strictly restricted to their assigned area. Cross-area access is blocked at the database and middleware layers.
- **Employee Masterfile**: Active and Inactive views. Inactivation permanently preserves all historical attendance, schedules, and clearance cases.
- **Dynamic Scheduling**: Individual and group scheduling, overnight shifts crossing midnight, conflict detection, and weekly matrix view.
- **Daily Attendance Marking**: Bulk table marking with status differentiation (Present, Late, Absent, On Leave, Rest Day). Confirmed absences automatically trigger or link Back-to-Work cases.
- **Coordinator Self-Attendance**: Server-timestamped Time-In and Time-Out with HR correction request workflow.
- **Forum-Style Requests & Concerns Hub**:
  - **Back-to-Work Clearance**: Absence linking, thread updates, authorized return date, and HR decision highlights.
  - **Employee Concerns**: Categories, HR directives, and resolution tracking.
  - **Manpower Requests**: Position breakdown, HR worker allocation (external or transfer), coordinator arrival confirmation, and automatic masterfile registration.
- **Excel (.xlsx) & CSV Export**: Streamed report generation with area-level permissions enforced.
- **Real-Time Notification Polling**: Unread badges and direct link navigation.
- **Full Audit Trail**: Immutable logging of system actions with IP tracking.

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

   Create a MySQL database and set DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, a random SESSION_SECRET, ADMIN_EMAIL, and a unique ADMIN_PASSWORD in .env.

3. **Initialize the Database**:
   ```bash
   npm run db:init
   ```

4. **Run Verification Test Suite**:
   ```bash
   npm test
   ```

5. **Start Application**:
   ```bash
   npm start
   ```
   Open `http://localhost:3000` in your web browser.

---

For existing SQLite records, import into an empty MySQL database before initialization: `npm run db:import-sqlite -- /path/to/taascor.db`. Follow [the deployment guide](docs/deployment.md) for Hostinger setup, import precautions, and database integration tests.

## System Account Credentials

After running `node scripts/fix-and-verify-all-accounts.js`, these are the active accounts:

| Role | Email / Username | Password | Notes |
| :--- | :--- | :--- | :--- |
| **ADMIN** | `admin@taascor.com` or `admin` | `admin@2026` | System-Wide Access |
| **HEAD HR** | `headhr@taascor.com` or `headhr` | `headhr@2026` | System-Wide Access |
| **HR** | `hr@taascor.com` or `hr` | `hr@2026` | System-Wide Access |
| **COORDINATOR** | `mark.pasa@taascor.com` | `Taascor@2026` | Assigned Warehouse |
| **COORDINATOR** | *(all other coordinators)* | `Taascor@2026` | Assigned Warehouse |

> **Login Tip:** You can log in using just the username prefix (e.g., `admin`, `hr`, `headhr`) - the system auto-appends `@taascor.com`.

---

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

- [User Guide (ADMIN, HR, COORDINATOR)](docs/user-guide.md)
- [Production Deployment & Disaster Recovery](docs/deployment.md)
