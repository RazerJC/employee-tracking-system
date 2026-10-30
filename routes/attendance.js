const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireArea, validateAreaAccess } = require('../middleware/area-guard');
const { getDb } = require('../db/database');
const { handleEmployeeAbsence } = require('../services/btw');
const { logAction } = require('../services/audit');
const { DateTime } = require('luxon');

// GET /attendance (Daily Attendance Sheet / Mark Attendance)
router.get('/', requireAuth, requireArea, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const isCoordinator = user.role === 'COORDINATOR';
    const today = DateTime.now().setZone('Asia/Manila').toFormat('yyyy-MM-dd');
    const workDate = isCoordinator ? today : (req.query.date || today);
    const isPastDate = workDate < today;
    const isFutureDate = workDate > today;

    const selectedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : (req.query.area_id ? parseInt(req.query.area_id) : null);
    const filterStatus = req.query.status || '';

    let empWhere = ["e.status = 'active'"];
    let empParams = [];

    if (selectedAreaId) {
        empWhere.push('e.area_id = ?');
        empParams.push(selectedAreaId);
    }

    // Get active employees for this area
    const employees = (await db.prepare(`
        SELECT e.id, e.employee_id, e.first_name, e.last_name, e.full_name,
               e.area_id, a.name as area_name,
               e.department_id, d.name as dept_name,
               e.position_id, p.title as position_title,
               es.id as schedule_id, es.shift_start, es.shift_end, es.is_rest_day,
               ea.id as attendance_id, ea.status as att_status, ea.time_in, ea.time_out, ea.remarks,
               b.id as open_btw_id, b.case_ref as open_btw_ref, b.status as open_btw_status
        FROM employees e
        JOIN areas a ON e.area_id = a.id
        LEFT JOIN departments d ON e.department_id = d.id
        LEFT JOIN positions p ON e.position_id = p.id
        LEFT JOIN employee_schedules es ON es.employee_id = e.id AND es.work_date = ?
        LEFT JOIN employee_attendance ea ON ea.employee_id = e.id AND ea.work_date = ?
        LEFT JOIN btw_cases b ON b.employee_id = e.id AND b.status IN ('pending_hr_review', 'for_clarification')
        WHERE ${empWhere.join(' AND ')}
        ORDER BY d.name ASC, p.title ASC, e.last_name ASC, e.first_name ASC
    `).all(workDate, workDate, ...empParams));

    // Filter by status if selected
    let filteredList = employees;
    if (filterStatus === 'unrecorded') {
        filteredList = employees.filter(e => !e.att_status);
    } else if (filterStatus === 'leave') {
        filteredList = employees.filter(e => e.att_status === 'leave' || e.att_status === 'on_leave');
    } else if (filterStatus) {
        filteredList = employees.filter(e => e.att_status === filterStatus);
    }

    // Summary stats for this date (standardizing leave/on_leave)
    let summary = {
        present: 0,
        absent: 0,
        no_work: 0,
        leave: 0,
        sent_home: 0,
        rest_day: 0,
        late: 0,
        unrecorded: 0
    };

    for (const emp of employees) {
        if (!emp.att_status) {
            summary.unrecorded++;
        } else if (emp.att_status === 'present') {
            summary.present++;
        } else if (emp.att_status === 'absent') {
            summary.absent++;
        } else if (emp.att_status === 'no_work') {
            summary.no_work++;
        } else if (emp.att_status === 'leave' || emp.att_status === 'on_leave') {
            summary.leave++;
        } else if (emp.att_status === 'sent_home') {
            summary.sent_home++;
        } else if (emp.att_status === 'rest_day') {
            summary.rest_day++;
        } else if (emp.att_status === 'late') {
            summary.late++;
        }
    }

    // Departments for this area
    let deptQuery = "SELECT * FROM departments";
    let deptParams = [];
    if (selectedAreaId) {
        deptQuery += " WHERE area_id = ?";
        deptParams.push(selectedAreaId);
    }
    deptQuery += " ORDER BY name ASC";
    const areaDepartments = (await db.prepare(deptQuery).all(...deptParams));

    // Group employees by Department and Position for the folder-style interface
    const deptMap = {};
    for (const d of areaDepartments) {
        deptMap[d.id] = {
            id: d.id,
            name: d.name,
            description: d.description,
            positions: {}
        };
    }
    // Virtual department for unassigned
    deptMap[0] = {
        id: 0,
        name: 'Unassigned Department',
        description: 'Staff without a designated department assignment',
        positions: {}
    };

    for (const emp of filteredList) {
        const dId = emp.department_id || 0;
        if (!deptMap[dId]) {
            deptMap[dId] = {
                id: dId,
                name: emp.dept_name || 'Other Department',
                positions: {}
            };
        }
        const posName = emp.position_title || 'General Staff';
        if (!deptMap[dId].positions[posName]) {
            deptMap[dId].positions[posName] = [];
        }
        deptMap[dId].positions[posName].push(emp);
    }

    // Convert deptMap to sorted array with only departments that have employees or are active
    const groupedDepartments = Object.values(deptMap).filter(d => {
        const hasEmps = Object.values(d.positions).some(arr => arr.length > 0);
        return hasEmps || (d.id !== 0);
    });

    const areas = user.role !== 'COORDINATOR' ? (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all()) : [];

    res.render('attendance/mark', {
        title: 'Daily Attendance - TAASCOR',
        workDate,
        today,
        isPastDate,
        isFutureDate,
        selectedAreaId,
        filterStatus,
        employees: filteredList,
        groupedDepartments,
        areaDepartments,
        summary,
        totalEmployees: employees.length,
        areas,
        isCoordinator
    });
});

// POST /attendance (Bulk save attendance)
router.post('/', requireAuth, requireArea, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const isCoordinator = user.role === 'COORDINATOR';
    const today = DateTime.now().setZone('Asia/Manila').toFormat('yyyy-MM-dd');
    let { work_date, attendance } = req.body;
    if (isCoordinator) {
        work_date = today;
    }

    if (!work_date || !attendance || typeof attendance !== 'object' || Array.isArray(attendance)) {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(400).json({ success: false, error: 'No attendance data submitted.' });
        }
        req.flash('error', 'No attendance data submitted.');
        return res.redirect(`/attendance?date=${work_date || ''}`);
    }

    let savedCount = 0;
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

    // Valid statuses from PHP system + existing
    const validStatuses = ['present', 'absent', 'no_work', 'leave', 'sent_home', 'rest_day', 'late', 'on_leave'];

    // Iterate through submitted rows
    for (const [empIdStr, val] of Object.entries(attendance)) {
        // Non-numeric form keys prevent URL-encoded parsers compacting employee IDs into array indexes.
        const idText = empIdStr.replace(/^e_/, '');
        if (!/^[1-9]\d*$/.test(idText)) continue;
        const empId = Number(idText);
        if (!empId) continue;

        let status = '';
        let scheduleId = null;
        let timeIn = null;
        let timeOut = null;
        let remarks = null;

        if (typeof val === 'string') {
            status = val.trim().toLowerCase();
        } else if (typeof val === 'object' && val !== null) {
            status = (val.status || '').trim().toLowerCase();
            scheduleId = val.schedule_id ? parseInt(val.schedule_id) : null;
            timeIn = val.time_in ? val.time_in.trim() : null;
            timeOut = val.time_out ? val.time_out.trim() : null;
            remarks = val.remarks ? val.remarks.trim() : null;
        }

        if (!status || !validStatuses.includes(status)) continue;

        // Verify area permission
        const emp = (await db.prepare('SELECT area_id FROM employees WHERE id = ?').get(empId));
        if (!emp || !validateAreaAccess(emp.area_id, req)) {
            continue; // Skip unauthorized
        }

        (await upsertStmt.run(
            empId,
            scheduleId,
            work_date,
            status,
            timeIn,
            timeOut,
            remarks,
            user.id
        ));
        savedCount++;

        // If marked absent, trigger or link back-to-work clearance workflow
        if (status === 'absent') {
            try {
                (await handleEmployeeAbsence(empId, work_date, user.id, remarks));
                absentTriggered++;
            } catch (err) {
                console.error('Error in handleEmployeeAbsence:', err);
            }
        }
    }

    if (savedCount === 0) {
        const message = 'No attendance was saved. Choose a status for at least one employee in your assigned area, then save again.';
        if (req.xhr || req.headers.accept?.includes('application/json')) return res.status(400).json({ success: false, error: message, savedCount: 0 });
        req.flash('error', message);
        return res.redirect(`/attendance?date=${work_date}`);
    }

    (await logAction(user.id, 'RECORD_ATTENDANCE', 'employee_attendance', null, {
        work_date,
        savedCount,
        absentTriggered
    }));

    if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.json({ success: true, savedCount, absentTriggered, work_date });
    }

    let msg = `Saved attendance for ${savedCount} employee(s).`;
    if (absentTriggered > 0) {
        msg += ` ${absentTriggered} absence(s) recorded and linked to Back-to-Work clearance cases.`;
    }
    req.flash('success', msg);
    res.redirect(`/attendance?date=${work_date}`);
});

module.exports = router;
