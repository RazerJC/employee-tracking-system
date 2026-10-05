-- TAASCOR Attendance Monitoring System - Database Schema
-- SQLite with WAL mode, foreign keys enforced

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-----------------------------------------------------
-- CORE TABLES
-----------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('ADMIN','HR','HEAD_HR','COORDINATOR')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended','rejected')),
    email_verified INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT,
    rejection_remarks TEXT,
    approved_by INTEGER REFERENCES users(id),
    approved_at TEXT,
    profile_photo TEXT,
    cover_photo TEXT,
    phone TEXT,
    bio TEXT
);

CREATE TABLE IF NOT EXISTS areas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL UNIQUE,
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS coordinator_area_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    area_id INTEGER NOT NULL REFERENCES areas(id),
    assigned_by INTEGER NOT NULL REFERENCES users(id),
    assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    is_current INTEGER NOT NULL DEFAULT 1,
    remarks TEXT
);
CREATE INDEX IF NOT EXISTS idx_caa_user ON coordinator_area_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_caa_current ON coordinator_area_assignments(user_id, is_current);

CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area_id INTEGER NOT NULL REFERENCES areas(id),
    name TEXT NOT NULL,
    description TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(area_id, name COLLATE NOCASE)
);
CREATE INDEX IF NOT EXISTS idx_dept_area ON departments(area_id);

-----------------------------------------------------
-- EMPLOYEE MANAGEMENT
-----------------------------------------------------

CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL UNIQUE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    area_id INTEGER NOT NULL REFERENCES areas(id),
    coordinator_id INTEGER REFERENCES users(id),
    department_id INTEGER REFERENCES departments(id),
    position_id INTEGER REFERENCES positions(id),
    employment_start_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
    inactivation_date TEXT,
    inactivation_reason TEXT,
    remarks TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_emp_area ON employees(area_id);
CREATE INDEX IF NOT EXISTS idx_emp_dept ON employees(department_id);
CREATE INDEX IF NOT EXISTS idx_emp_coordinator ON employees(coordinator_id);
CREATE INDEX IF NOT EXISTS idx_emp_status ON employees(status);
CREATE INDEX IF NOT EXISTS idx_emp_empid ON employees(employee_id);

-----------------------------------------------------
-- SCHEDULING
-----------------------------------------------------

CREATE TABLE IF NOT EXISTS employee_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    work_date TEXT NOT NULL,
    shift_start TEXT,          -- HH:MM format, NULL if rest day
    shift_end TEXT,            -- HH:MM format, can be > 24:00 for overnight
    is_rest_day INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_sched_emp_date ON employee_schedules(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_sched_date ON employee_schedules(work_date);

-----------------------------------------------------
-- EMPLOYEE ATTENDANCE
-----------------------------------------------------

CREATE TABLE IF NOT EXISTS employee_attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    schedule_id INTEGER REFERENCES employee_schedules(id),
    work_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('present','late','absent','on_leave','rest_day')),
    time_in TEXT,
    time_out TEXT,
    remarks TEXT,
    recorded_by INTEGER NOT NULL REFERENCES users(id),
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_att_emp_date ON employee_attendance(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_att_date ON employee_attendance(work_date);
CREATE INDEX IF NOT EXISTS idx_att_status ON employee_attendance(status);

-----------------------------------------------------
-- COORDINATOR ATTENDANCE
-----------------------------------------------------

CREATE TABLE IF NOT EXISTS coordinator_attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    work_date TEXT NOT NULL,
    time_in TEXT NOT NULL,
    time_out TEXT,
    time_in_server TEXT NOT NULL,
    time_out_server TEXT,
    correction_requested INTEGER NOT NULL DEFAULT 0,
    correction_reason TEXT,
    correction_approved_by INTEGER REFERENCES users(id),
    correction_approved_at TEXT,
    correction_note TEXT,
    time_in_photo TEXT,
    time_out_photo TEXT,
    remarks TEXT,
    UNIQUE(user_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_coord_att_user ON coordinator_attendance(user_id);
CREATE INDEX IF NOT EXISTS idx_coord_att_date ON coordinator_attendance(work_date);

-----------------------------------------------------
-- BACK-TO-WORK CASES
-----------------------------------------------------

CREATE TABLE IF NOT EXISTS btw_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_ref TEXT NOT NULL UNIQUE,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    area_id INTEGER NOT NULL REFERENCES areas(id),
    coordinator_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'pending_hr_review' CHECK(status IN ('pending_hr_review','for_clarification','approved','not_approved')),
    absence_dates TEXT NOT NULL,           -- JSON array of date strings
    absence_reason TEXT,
    hr_reviewer_id INTEGER REFERENCES users(id),
    hr_decision TEXT,
    action_type TEXT DEFAULT 'none',
    hr_remarks TEXT,
    article_violated TEXT,
    suspension_start TEXT,
    suspension_end TEXT,
    decision_at TEXT,
    authorized_return_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    dedup_key TEXT UNIQUE                   -- Prevents duplicate case creation
);
CREATE INDEX IF NOT EXISTS idx_btw_employee ON btw_cases(employee_id);
CREATE INDEX IF NOT EXISTS idx_btw_status ON btw_cases(status);
CREATE INDEX IF NOT EXISTS idx_btw_coordinator ON btw_cases(coordinator_id);
CREATE INDEX IF NOT EXISTS idx_btw_area ON btw_cases(area_id);

CREATE TABLE IF NOT EXISTS btw_case_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES btw_cases(id),
    author_id INTEGER NOT NULL REFERENCES users(id),
    author_role TEXT NOT NULL,
    content TEXT NOT NULL,
    entry_type TEXT NOT NULL DEFAULT 'comment' CHECK(entry_type IN ('comment','status_change','decision','system')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_btw_entries_case ON btw_case_entries(case_id);

-----------------------------------------------------
-- CONCERN REPORTS
-----------------------------------------------------

CREATE TABLE IF NOT EXISTS concern_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    area_id INTEGER NOT NULL REFERENCES areas(id),
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    reported_by INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','under_review','for_employee_reporting','resolved')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_concern_employee ON concern_reports(employee_id);
CREATE INDEX IF NOT EXISTS idx_concern_status ON concern_reports(status);
CREATE INDEX IF NOT EXISTS idx_concern_area ON concern_reports(area_id);

CREATE TABLE IF NOT EXISTS concern_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concern_id INTEGER NOT NULL REFERENCES concern_reports(id),
    author_id INTEGER NOT NULL REFERENCES users(id),
    author_role TEXT NOT NULL,
    content TEXT NOT NULL,
    entry_type TEXT NOT NULL DEFAULT 'comment' CHECK(entry_type IN ('comment','status_change','instruction','system')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_concern_entries ON concern_entries(concern_id);

-----------------------------------------------------
-- MANPOWER REQUESTS
-----------------------------------------------------

CREATE TABLE IF NOT EXISTS manpower_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area_id INTEGER NOT NULL REFERENCES areas(id),
    requested_by INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','under_review','partially_filled','filled','declined','cancelled')),
    deployment_date TEXT NOT NULL,
    shift_details TEXT,
    reason TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
    remarks TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mp_area ON manpower_requests(area_id);
CREATE INDEX IF NOT EXISTS idx_mp_status ON manpower_requests(status);

CREATE TABLE IF NOT EXISTS manpower_request_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES manpower_requests(id),
    position_id INTEGER NOT NULL REFERENCES positions(id),
    quantity_requested INTEGER NOT NULL CHECK(quantity_requested > 0)
);
CREATE INDEX IF NOT EXISTS idx_mpp_request ON manpower_request_positions(request_id);

CREATE TABLE IF NOT EXISTS manpower_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES manpower_requests(id),
    request_position_id INTEGER NOT NULL REFERENCES manpower_request_positions(id),
    employee_id INTEGER REFERENCES employees(id),
    worker_name TEXT,                       -- For incoming workers not yet in system
    allocated_by INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','did_not_report')),
    confirmed_at TEXT,
    confirmed_by INTEGER REFERENCES users(id),
    actual_position_id INTEGER REFERENCES positions(id),
    position_change_reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alloc_request ON manpower_allocations(request_id);
CREATE INDEX IF NOT EXISTS idx_alloc_employee ON manpower_allocations(employee_id);
CREATE INDEX IF NOT EXISTS idx_alloc_status ON manpower_allocations(status);

CREATE TABLE IF NOT EXISTS manpower_request_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL REFERENCES manpower_requests(id),
    author_id INTEGER NOT NULL REFERENCES users(id),
    author_role TEXT NOT NULL,
    content TEXT NOT NULL,
    entry_type TEXT NOT NULL DEFAULT 'comment' CHECK(entry_type IN ('comment','status_change','allocation','system')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mp_entries ON manpower_request_entries(request_id);

-----------------------------------------------------
-- NOTIFICATIONS
-----------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    link TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    dedup_key TEXT                         -- Optional deduplication
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notif_dedup ON notifications(dedup_key);

-----------------------------------------------------
-- AUDIT LOGS
-----------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    details TEXT,                          -- JSON
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_logs(created_at);

-----------------------------------------------------
-- EMAIL TOKENS
-----------------------------------------------------

CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT
);

CREATE TABLE IF NOT EXISTS manpower_request_handlers (
    request_id INTEGER NOT NULL PRIMARY KEY REFERENCES manpower_requests(id),
    hr_id INTEGER NOT NULL REFERENCES users(id),
    claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS btw_hr_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES btw_cases(id),
    author_id INTEGER NOT NULL REFERENCES users(id),
    decision TEXT NOT NULL,
    action_type TEXT NOT NULL DEFAULT 'none',
    issued_date TEXT,
    suspension_start TEXT,
    suspension_end TEXT,
    return_date TEXT,
    article_violated TEXT,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_btw_action_case ON btw_hr_actions(case_id, id);

-----------------------------------------------------
-- INCIDENT MANAGEMENT
-----------------------------------------------------

CREATE TABLE IF NOT EXISTS incident_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_ref TEXT NOT NULL UNIQUE,
    area_id INTEGER NOT NULL REFERENCES areas(id),
    reported_by INTEGER NOT NULL REFERENCES users(id),
    employee_id INTEGER REFERENCES employees(id),
    incident_date TEXT NOT NULL,
    incident_time TEXT,
    category TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'minor' CHECK(severity IN ('minor','moderate','major','critical')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    location_details TEXT,
    immediate_action_taken TEXT,
    status TEXT NOT NULL DEFAULT 'reported' CHECK(status IN ('reported','under_investigation','hr_action_taken','resolved','closed')),
    hr_reviewer_id INTEGER REFERENCES users(id),
    hr_resolution_notes TEXT,
    hr_action_type TEXT DEFAULT 'none',
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_incident_area ON incident_reports(area_id);
CREATE INDEX IF NOT EXISTS idx_incident_status ON incident_reports(status);
CREATE INDEX IF NOT EXISTS idx_incident_severity ON incident_reports(severity);
CREATE INDEX IF NOT EXISTS idx_incident_emp ON incident_reports(employee_id);

CREATE TABLE IF NOT EXISTS incident_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER NOT NULL REFERENCES incident_reports(id),
    author_id INTEGER NOT NULL REFERENCES users(id),
    author_role TEXT NOT NULL,
    content TEXT NOT NULL,
    entry_type TEXT NOT NULL DEFAULT 'comment' CHECK(entry_type IN ('comment','status_change','investigation','hr_action','system')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_incident_entries ON incident_entries(incident_id);

