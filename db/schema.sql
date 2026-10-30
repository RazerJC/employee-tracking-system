-- TAASCOR: MySQL 8.0+ / MariaDB 10.4+, InnoDB, UTF-8. Timestamps are UTC.

CREATE TABLE IF NOT EXISTS users (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash VARCHAR(191) NOT NULL,
    full_name VARCHAR(191) NOT NULL,
    role VARCHAR(191) NOT NULL CHECK(role IN ('ADMIN','HR','HEAD_HR','COORDINATOR')),
    status VARCHAR(191) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','suspended','rejected')),
    email_verified INT NOT NULL DEFAULT 0,
    must_change_password INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME,
    rejection_remarks TEXT,
    approved_by INT,
    approved_at DATETIME,
    profile_photo LONGTEXT,
    cover_photo LONGTEXT,
    phone VARCHAR(191),
    bio TEXT,
    FOREIGN KEY (approved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS areas (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(191) NOT NULL UNIQUE,
    description TEXT,
    is_active INT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by INT,
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS positions (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(191) NOT NULL UNIQUE,
    description TEXT,
    is_active INT NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by INT,
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS coordinator_area_assignments (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    area_id INT NOT NULL,
    assigned_by INT NOT NULL,
    assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    is_current INT NOT NULL DEFAULT 1,
    remarks TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (area_id) REFERENCES areas(id),
    FOREIGN KEY (assigned_by) REFERENCES users(id),
    INDEX idx_caa_user (user_id),
    INDEX idx_caa_current (user_id, is_current)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS departments (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    area_id INT NOT NULL,
    name VARCHAR(191) NOT NULL,
    description TEXT,
    created_by INT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(area_id, name),
    FOREIGN KEY (area_id) REFERENCES areas(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    INDEX idx_dept_area (area_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employees (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    employee_id VARCHAR(191) NOT NULL UNIQUE,
    first_name VARCHAR(191) NOT NULL,
    last_name VARCHAR(191) NOT NULL,
    full_name VARCHAR(191) NOT NULL,
    area_id INT NOT NULL,
    coordinator_id INT,
    department_id INT,
    position_id INT,
    employment_start_date DATE NOT NULL,
    status VARCHAR(191) NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
    inactivation_date DATE,
    inactivation_reason TEXT,
    remarks TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by INT,
    updated_by INT,
    FOREIGN KEY (area_id) REFERENCES areas(id),
    FOREIGN KEY (coordinator_id) REFERENCES users(id),
    FOREIGN KEY (department_id) REFERENCES departments(id),
    FOREIGN KEY (position_id) REFERENCES positions(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (updated_by) REFERENCES users(id),
    INDEX idx_emp_area (area_id),
    INDEX idx_emp_dept (department_id),
    INDEX idx_emp_coordinator (coordinator_id),
    INDEX idx_emp_status (status),
    INDEX idx_emp_empid (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_schedules (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    employee_id INT NOT NULL,
    work_date DATE NOT NULL,
    shift_start VARCHAR(64),
    shift_end VARCHAR(64),
    is_rest_day INT NOT NULL DEFAULT 0,
    notes TEXT,
    created_by INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT,
    updated_at DATETIME,
    version INT NOT NULL DEFAULT 1,
    UNIQUE(employee_id, work_date),
    FOREIGN KEY (employee_id) REFERENCES employees(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (updated_by) REFERENCES users(id),
    INDEX idx_sched_emp_date (employee_id, work_date),
    INDEX idx_sched_date (work_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_attendance (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    employee_id INT NOT NULL,
    schedule_id INT,
    work_date DATE NOT NULL,
    status VARCHAR(191) NOT NULL CHECK(status IN ('present','late','absent','on_leave','rest_day','no_work','leave','sent_home')),
    time_in VARCHAR(64),
    time_out VARCHAR(64),
    remarks TEXT,
    recorded_by INT NOT NULL,
    recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INT,
    updated_at DATETIME,
    version INT NOT NULL DEFAULT 1,
    UNIQUE(employee_id, work_date),
    FOREIGN KEY (employee_id) REFERENCES employees(id),
    FOREIGN KEY (schedule_id) REFERENCES employee_schedules(id),
    FOREIGN KEY (recorded_by) REFERENCES users(id),
    FOREIGN KEY (updated_by) REFERENCES users(id),
    INDEX idx_att_emp_date (employee_id, work_date),
    INDEX idx_att_date (work_date),
    INDEX idx_att_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS coordinator_attendance (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    work_date DATE NOT NULL,
    time_in VARCHAR(64) NOT NULL,
    time_out VARCHAR(64),
    time_in_server VARCHAR(64) NOT NULL,
    time_out_server VARCHAR(64),
    correction_requested INT NOT NULL DEFAULT 0,
    correction_reason TEXT,
    correction_approved_by INT,
    correction_approved_at DATETIME,
    correction_note TEXT,
    remarks TEXT,
    UNIQUE(user_id, work_date),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (correction_approved_by) REFERENCES users(id),
    INDEX idx_coord_att_user (user_id),
    INDEX idx_coord_att_date (work_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE coordinator_attendance ADD COLUMN IF NOT EXISTS time_in_photo LONGTEXT;
ALTER TABLE coordinator_attendance ADD COLUMN IF NOT EXISTS time_out_photo LONGTEXT;
ALTER TABLE coordinator_attendance ADD COLUMN IF NOT EXISTS time_in_lat VARCHAR(32);
ALTER TABLE coordinator_attendance ADD COLUMN IF NOT EXISTS time_in_lng VARCHAR(32);
ALTER TABLE coordinator_attendance ADD COLUMN IF NOT EXISTS time_in_accuracy VARCHAR(32);
ALTER TABLE coordinator_attendance ADD COLUMN IF NOT EXISTS time_in_location TEXT;
ALTER TABLE coordinator_attendance ADD COLUMN IF NOT EXISTS time_out_lat VARCHAR(32);
ALTER TABLE coordinator_attendance ADD COLUMN IF NOT EXISTS time_out_lng VARCHAR(32);
ALTER TABLE coordinator_attendance ADD COLUMN IF NOT EXISTS time_out_accuracy VARCHAR(32);
ALTER TABLE coordinator_attendance ADD COLUMN IF NOT EXISTS time_out_location TEXT;

CREATE TABLE IF NOT EXISTS btw_cases (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    case_ref VARCHAR(191) NOT NULL UNIQUE,
    employee_id INT NOT NULL,
    area_id INT NOT NULL,
    coordinator_id INT NOT NULL,
    status VARCHAR(191) NOT NULL DEFAULT 'pending_hr_review' CHECK(status IN ('pending_hr_review','for_clarification','approved','not_approved')),
    absence_dates TEXT NOT NULL,
    absence_reason TEXT,
    hr_reviewer_id INT,
    hr_decision TEXT,
    action_type VARCHAR(32) DEFAULT 'none',
    hr_remarks TEXT,
    article_violated TEXT,
    suspension_start DATE,
    suspension_end DATE,
    decision_at DATETIME,
    authorized_return_date DATE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    dedup_key VARCHAR(191) UNIQUE,
    FOREIGN KEY (employee_id) REFERENCES employees(id),
    FOREIGN KEY (area_id) REFERENCES areas(id),
    FOREIGN KEY (coordinator_id) REFERENCES users(id),
    FOREIGN KEY (hr_reviewer_id) REFERENCES users(id),
    INDEX idx_btw_employee (employee_id),
    INDEX idx_btw_status (status),
    INDEX idx_btw_coordinator (coordinator_id),
    INDEX idx_btw_area (area_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS btw_case_entries (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    case_id INT NOT NULL,
    author_id INT NOT NULL,
    author_role VARCHAR(191) NOT NULL,
    content TEXT NOT NULL,
    entry_type VARCHAR(191) NOT NULL DEFAULT 'comment' CHECK(entry_type IN ('comment','status_change','decision','system')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (case_id) REFERENCES btw_cases(id),
    FOREIGN KEY (author_id) REFERENCES users(id),
    INDEX idx_btw_entries_case (case_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS concern_reports (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    employee_id INT NOT NULL,
    area_id INT NOT NULL,
    category VARCHAR(191) NOT NULL,
    description TEXT NOT NULL,
    reported_by INT NOT NULL,
    status VARCHAR(191) NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','under_review','for_employee_reporting','resolved')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id),
    FOREIGN KEY (area_id) REFERENCES areas(id),
    FOREIGN KEY (reported_by) REFERENCES users(id),
    INDEX idx_concern_employee (employee_id),
    INDEX idx_concern_status (status),
    INDEX idx_concern_area (area_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS concern_entries (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    concern_id INT NOT NULL,
    author_id INT NOT NULL,
    author_role VARCHAR(191) NOT NULL,
    content TEXT NOT NULL,
    entry_type VARCHAR(191) NOT NULL DEFAULT 'comment' CHECK(entry_type IN ('comment','status_change','instruction','system')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (concern_id) REFERENCES concern_reports(id),
    FOREIGN KEY (author_id) REFERENCES users(id),
    INDEX idx_concern_entries (concern_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS manpower_requests (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    area_id INT NOT NULL,
    requested_by INT NOT NULL,
    status VARCHAR(191) NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','under_review','partially_filled','filled','declined','cancelled')),
    deployment_date DATE NOT NULL,
    shift_details VARCHAR(64),
    reason TEXT NOT NULL,
    priority VARCHAR(191) NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
    remarks TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (area_id) REFERENCES areas(id),
    FOREIGN KEY (requested_by) REFERENCES users(id),
    INDEX idx_mp_area (area_id),
    INDEX idx_mp_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS manpower_request_positions (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    request_id INT NOT NULL,
    position_id INT NOT NULL,
    quantity_requested INT NOT NULL CHECK(quantity_requested > 0),
    FOREIGN KEY (request_id) REFERENCES manpower_requests(id),
    FOREIGN KEY (position_id) REFERENCES positions(id),
    INDEX idx_mpp_request (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS manpower_allocations (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    request_id INT NOT NULL,
    request_position_id INT NOT NULL,
    employee_id INT,
    worker_name VARCHAR(191),
    allocated_by INT NOT NULL,
    status VARCHAR(191) NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','confirmed','did_not_report')),
    confirmed_at DATETIME,
    confirmed_by INT,
    actual_position_id INT,
    position_change_reason TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (request_id) REFERENCES manpower_requests(id),
    FOREIGN KEY (request_position_id) REFERENCES manpower_request_positions(id),
    FOREIGN KEY (employee_id) REFERENCES employees(id),
    FOREIGN KEY (allocated_by) REFERENCES users(id),
    FOREIGN KEY (confirmed_by) REFERENCES users(id),
    FOREIGN KEY (actual_position_id) REFERENCES positions(id),
    INDEX idx_alloc_request (request_id),
    INDEX idx_alloc_employee (employee_id),
    INDEX idx_alloc_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS manpower_request_entries (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    request_id INT NOT NULL,
    author_id INT NOT NULL,
    author_role VARCHAR(191) NOT NULL,
    content TEXT NOT NULL,
    entry_type VARCHAR(191) NOT NULL DEFAULT 'comment' CHECK(entry_type IN ('comment','status_change','allocation','system')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (request_id) REFERENCES manpower_requests(id),
    FOREIGN KEY (author_id) REFERENCES users(id),
    INDEX idx_mp_entries (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(191) NOT NULL,
    message TEXT NOT NULL,
    link VARCHAR(191),
    is_read INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    dedup_key VARCHAR(191),
    FOREIGN KEY (user_id) REFERENCES users(id),
    INDEX idx_notif_user (user_id, is_read),
    INDEX idx_notif_dedup (dedup_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    action VARCHAR(191) NOT NULL,
    entity_type VARCHAR(191),
    entity_id INT,
    details TEXT,
    ip_address VARCHAR(191),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    INDEX idx_audit_user (user_id),
    INDEX idx_audit_entity (entity_type, entity_id),
    INDEX idx_audit_date (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_verification_tokens (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(191) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_reset_tokens (

    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(191) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    used_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    expires INT UNSIGNED NOT NULL,
    data MEDIUMTEXT COLLATE utf8mb4_bin,
    INDEX idx_sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS manpower_request_handlers (
 request_id INT NOT NULL PRIMARY KEY,
 hr_id INT NOT NULL,
 claimed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY (request_id) REFERENCES manpower_requests(id),
 FOREIGN KEY (hr_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS btw_hr_actions (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    case_id INT NOT NULL,
    author_id INT NOT NULL,
    decision VARCHAR(32) NOT NULL,
    action_type VARCHAR(32) NOT NULL DEFAULT 'none',
    issued_date DATE,
    suspension_start DATE,
    suspension_end DATE,
    return_date DATE,
    article_violated TEXT,
    summary TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (case_id) REFERENCES btw_cases(id),
    FOREIGN KEY (author_id) REFERENCES users(id),
    INDEX idx_btw_action_case (case_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS incident_reports (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    incident_ref VARCHAR(191) NOT NULL UNIQUE,
    area_id INT NOT NULL,
    reported_by INT NOT NULL,
    employee_id INT,
    incident_date DATE NOT NULL,
    incident_time VARCHAR(32),
    category VARCHAR(191) NOT NULL,
    severity VARCHAR(32) NOT NULL DEFAULT 'minor',
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    location_details TEXT,
    immediate_action_taken TEXT,
    status VARCHAR(64) NOT NULL DEFAULT 'reported',
    hr_reviewer_id INT,
    hr_resolution_notes TEXT,
    hr_action_type VARCHAR(64) DEFAULT 'none',
    resolved_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (area_id) REFERENCES areas(id),
    FOREIGN KEY (reported_by) REFERENCES users(id),
    FOREIGN KEY (employee_id) REFERENCES employees(id),
    FOREIGN KEY (hr_reviewer_id) REFERENCES users(id),
    INDEX idx_incident_area (area_id),
    INDEX idx_incident_status (status),
    INDEX idx_incident_severity (severity),
    INDEX idx_incident_emp (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS incident_entries (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    incident_id INT NOT NULL,
    author_id INT NOT NULL,
    author_role VARCHAR(64) NOT NULL,
    content TEXT NOT NULL,
    entry_type VARCHAR(64) NOT NULL DEFAULT 'comment',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (incident_id) REFERENCES incident_reports(id),
    FOREIGN KEY (author_id) REFERENCES users(id),
    INDEX idx_incident_entries (incident_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

