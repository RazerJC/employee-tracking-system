const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { getUnreadCount, getNotifications, getMenuGlow } = require('../services/notification');
const { validateAreaAccess } = require('../middleware/area-guard');
const { handleEmployeeAbsence } = require('../services/btw');
const { logAction } = require('../services/audit');
const { DateTime } = require('luxon');

// GET /api/notifications/unread-count
router.get('/notifications/unread-count', async (req, res) => {
    if (!req.session.user) return res.json({ count: 0, glow: {} });
    const count = (await getUnreadCount(req.session.user.id));
    const glow = (await getMenuGlow(req.session.user));
    res.json({ count, glow });
});

// GET /api/notifications/latest
router.get('/notifications/latest', async (req, res) => {
    if (!req.session.user) return res.json({ notifications: [] });
    const notifications = (await getNotifications(req.session.user.id, 6, 0));
    res.json({ notifications });
});

// GET /api/schedules/check-conflict
router.get('/schedules/check-conflict', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const { employee_id, work_date } = req.query;
    if (!employee_id || !work_date) return res.json({ conflict: false });

    const db = getDb();
    const existing = (await db.prepare(`
        SELECT es.*, e.full_name 
        FROM employee_schedules es
        JOIN employees e ON es.employee_id = e.id
        WHERE es.employee_id = ? AND es.work_date = ?
    `).get(parseInt(employee_id), work_date));

    if (existing) {
        return res.json({
            conflict: true,
            message: `${existing.full_name} already has a schedule on ${work_date} (${existing.is_rest_day ? 'Rest Day' : existing.shift_start + ' - ' + existing.shift_end}). Saving will overwrite this schedule.`
        });
    }

    res.json({ conflict: false });
});

// ==========================================
// DEPARTMENTS API
// ==========================================

// POST /api/departments/add
router.post('/departments/add', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const user = req.session.user;
    const db = getDb();
    const name = (req.body.name || '').trim();
    const areaId = user.role === 'COORDINATOR' ? req.userAreaId : parseInt(req.body.area_id);

    if (!name) return res.status(400).json({ success: false, error: 'Department name is required.' });
    if (!areaId || !validateAreaAccess(areaId, req)) {
        return res.status(403).json({ success: false, error: 'Unauthorized area.' });
    }

    const existing = (await db.prepare('SELECT id FROM departments WHERE area_id = ? AND name = ?').get(areaId, name));
    if (existing) {
        return res.status(400).json({ success: false, error: `Department "${name}" already exists.` });
    }

    const result = (await db.prepare(`
        INSERT INTO departments (area_id, name, created_by, created_at, updated_at)
        VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
    `).run(areaId, name, user.id));

    (await logAction(user.id, 'CREATE_DEPARTMENT', 'departments', result.lastInsertRowid, { name, area_id: areaId }));
    res.json({ success: true, id: result.lastInsertRowid, name, area_id: areaId });
});

// POST /api/departments/update
router.post('/departments/update', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.body.id);
    const name = (req.body.name || '').trim();

    if (!id || !name) return res.status(400).json({ success: false, error: 'ID and Name are required.' });

    const dept = (await db.prepare('SELECT * FROM departments WHERE id = ?').get(id));
    if (!dept) return res.status(404).json({ success: false, error: 'Department not found.' });
    if (!validateAreaAccess(dept.area_id, req)) return res.status(403).json({ success: false, error: 'Access denied.' });

    const duplicate = (await db.prepare('SELECT id FROM departments WHERE area_id = ? AND name = ? AND id != ?')
        .get(dept.area_id, name, id));
    if (duplicate) return res.status(400).json({ success: false, error: `Department "${name}" already exists.` });

    (await db.prepare("UPDATE departments SET name = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?").run(name, id));
    (await logAction(user.id, 'UPDATE_DEPARTMENT', 'departments', id, { old_name: dept.name, new_name: name }));
    res.json({ success: true, id, name });
});

// POST /api/departments/delete
router.post('/departments/delete', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.body.id);

    if (!id) return res.status(400).json({ success: false, error: 'Missing department ID.' });
    const dept = (await db.prepare('SELECT * FROM departments WHERE id = ?').get(id));
    if (!dept) return res.status(404).json({ success: false, error: 'Department not found.' });
    if (!validateAreaAccess(dept.area_id, req)) return res.status(403).json({ success: false, error: 'Access denied.' });

    const count = (await db.prepare('SELECT COUNT(*) as count FROM employees WHERE department_id = ?').get(id)).count;
    if (count > 0) return res.status(400).json({ success: false, error: `Cannot delete department. It has ${count} employee(s) assigned.` });

    (await db.prepare('DELETE FROM departments WHERE id = ?').run(id));
    (await logAction(user.id, 'DELETE_DEPARTMENT', 'departments', id, { name: dept.name }));
    res.json({ success: true });
});

// ==========================================
// EMPLOYEES QUICK ACTIONS API
// ==========================================

// POST /api/employees/update-department
router.post('/employees/update-department', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const user = req.session.user;
    const db = getDb();
    const employeeId = parseInt(req.body.employee_id);
    const departmentId = req.body.department_id ? parseInt(req.body.department_id) : null;

    if (!employeeId) return res.status(400).json({ success: false, error: 'Missing employee ID.' });
    const employee = (await db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId));
    if (!employee) return res.status(404).json({ success: false, error: 'Employee not found.' });
    if (!validateAreaAccess(employee.area_id, req)) return res.status(403).json({ success: false, error: 'Access denied.' });

    let deptName = 'Unassigned';
    if (departmentId) {
        const dept = (await db.prepare('SELECT * FROM departments WHERE id = ?').get(departmentId));
        if (!dept) return res.status(404).json({ success: false, error: 'Department not found.' });
        deptName = dept.name;
    }

    (await db.prepare("UPDATE employees SET department_id = ?, updated_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?")
        .run(departmentId, user.id, employeeId));

    (await logAction(user.id, 'ASSIGN_EMPLOYEE_DEPARTMENT', 'employees', employeeId, { department_id: departmentId, department_name: deptName }));
    res.json({ success: true, employee_id: employeeId, department_id: departmentId, department_name: deptName });
});

// POST /api/employees/quick-update (Update name, position, department)
router.post('/employees/quick-update', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.body.id);
    const firstName = (req.body.first_name || '').trim();
    const lastName = (req.body.last_name || '').trim();
    const positionTitle = (req.body.position || '').trim();
    const departmentId = req.body.department_id ? parseInt(req.body.department_id) : null;

    if (!id || !firstName || !lastName) {
        return res.status(400).json({ success: false, error: 'First and last name are required.' });
    }

    const employee = (await db.prepare('SELECT * FROM employees WHERE id = ?').get(id));
    if (!employee) return res.status(404).json({ success: false, error: 'Employee not found.' });
    if (!validateAreaAccess(employee.area_id, req)) return res.status(403).json({ success: false, error: 'Access denied.' });

    // Position handling
    let positionId = employee.position_id;
    if (positionTitle) {
        let pos = (await db.prepare('SELECT id FROM positions WHERE title = ?').get(positionTitle));
        if (!pos) {
            const pRes = (await db.prepare("INSERT INTO positions (title, is_active, created_by) VALUES (?, 1, ?)").run(positionTitle, user.id));
            positionId = pRes.lastInsertRowid;
        } else {
            positionId = pos.id;
        }
    }

    const fullName = `${firstName} ${lastName}`;
    (await db.prepare(`
        UPDATE employees 
        SET first_name = ?, last_name = ?, full_name = ?, position_id = ?, 
            department_id = COALESCE(?, department_id), updated_at = UTC_TIMESTAMP(), updated_by = ?
        WHERE id = ?
    `).run(firstName, lastName, fullName, positionId, departmentId, user.id, id));

    (await logAction(user.id, 'QUICK_UPDATE_EMPLOYEE', 'employees', id, { full_name: fullName, position: positionTitle, department_id: departmentId }));
    res.json({ success: true, id, first_name: firstName, last_name: lastName, full_name: fullName, position: positionTitle, department_id: departmentId });
});

// POST /api/employees/delete
router.post('/employees/delete', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.body.employee_id || req.body.id);

    if (!id) return res.status(400).json({ success: false, error: 'Missing employee ID.' });
    const employee = (await db.prepare('SELECT * FROM employees WHERE id = ?').get(id));
    if (!employee) return res.status(404).json({ success: false, error: 'Employee not found.' });
    if (!validateAreaAccess(employee.area_id, req)) return res.status(403).json({ success: false, error: 'Access denied.' });

    // Soft delete or set inactive, or hard delete if no critical foreign keys
    (await db.prepare("UPDATE employees SET status = 'inactive', inactivation_date = UTC_DATE(), inactivation_reason = 'Deleted by coordinator/HR', updated_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?")
        .run(user.id, id));

    (await logAction(user.id, 'DELETE_EMPLOYEE', 'employees', id, { full_name: employee.full_name }));
    res.json({ success: true, message: `Employee ${employee.full_name} marked inactive.` });
});

// ==========================================
// BATCH ATTENDANCE SAVE API
// ==========================================

// POST /api/attendance/save
router.post('/attendance/save', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const user = req.session.user;
    const db = getDb();
    const { work_date, attendance } = req.body;

    if (!work_date || !attendance || typeof attendance !== 'object') {
        return res.status(400).json({ success: false, error: 'Missing date or attendance data.' });
    }

    const validStatuses = ['present', 'absent', 'no_work', 'leave', 'sent_home', 'rest_day', 'late', 'on_leave'];
    let saved = 0;
    let absentTriggered = 0;

    const upsertStmt = db.prepare(`
        INSERT INTO employee_attendance (employee_id, schedule_id, work_date, status, time_in, time_out, remarks, recorded_by, recorded_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), 1)
        ON DUPLICATE KEY UPDATE
            schedule_id = VALUES(schedule_id),
            status = VALUES(status),
            time_in = VALUES(time_in),
            time_out = VALUES(time_out),
            remarks = VALUES(remarks),
            updated_by = VALUES(recorded_by),
            updated_at = UTC_TIMESTAMP(),
            version = version + 1
    `);

    for (const [empIdStr, data] of Object.entries(attendance)) {
        const empId = parseInt(empIdStr);
        if (!empId) continue;
        const status = (typeof data === 'string' ? data : (data.status || '')).toLowerCase();
        if (!validStatuses.includes(status)) continue;

        const emp = (await db.prepare('SELECT area_id FROM employees WHERE id = ?').get(empId));
        if (!emp || !validateAreaAccess(emp.area_id, req)) continue;

        const scheduleId = (typeof data === 'object' && data.schedule_id) ? parseInt(data.schedule_id) : null;
        const timeIn = (typeof data === 'object' && data.time_in) ? data.time_in.trim() : null;
        const timeOut = (typeof data === 'object' && data.time_out) ? data.time_out.trim() : null;
        const remarks = (typeof data === 'object' && data.remarks) ? data.remarks.trim() : null;

        (await upsertStmt.run(empId, scheduleId, work_date, status, timeIn, timeOut, remarks, user.id));
        saved++;

        if (status === 'absent') {
            try {
                (await handleEmployeeAbsence(empId, work_date, user.id));
                absentTriggered++;
            } catch (e) {
                console.error('Error triggering BTW case:', e);
            }
        }
    }

    (await logAction(user.id, 'SAVE_ATTENDANCE_API', 'employee_attendance', null, { work_date, saved_count: saved, absent_cases_created: absentTriggered }));
    res.json({ success: true, saved, absent_cases_created: absentTriggered, work_date });
});

module.exports = router;
