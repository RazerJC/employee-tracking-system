const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireArea, validateAreaAccess } = require('../middleware/area-guard');
const { getDb } = require('../db/database');
const { logAction } = require('../services/audit');
const { DateTime } = require('luxon');

// GET /schedules
router.get('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const view = req.query.view === 'calendar' ? 'calendar' : 'table';
    const targetDate = req.query.date || DateTime.now().setZone('Asia/Manila').toFormat('yyyy-MM-dd');
    const selectedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : (req.query.area_id ? parseInt(req.query.area_id) : null);
    const departmentId = req.query.department_id ? parseInt(req.query.department_id) : null;

    // Compute week range (Monday to Sunday)
    const dt = DateTime.fromISO(targetDate, { zone: 'Asia/Manila' });
    const weekStart = dt.startOf('week'); // Monday
    const weekDates = [];
    for (let i = 0; i < 7; i++) {
        weekDates.push(weekStart.plus({ days: i }).toFormat('yyyy-MM-dd'));
    }

    let empWhere = ["e.status = 'active'"];
    let empParams = [];

    if (selectedAreaId) {
        empWhere.push('e.area_id = ?');
        empParams.push(selectedAreaId);
    }

    if (departmentId) {
        empWhere.push('e.department_id = ?');
        empParams.push(departmentId);
    }

    const employees = (await db.prepare(`
        SELECT e.id, e.employee_id, e.full_name, a.name as area_name, p.title as position_title,
               e.department_id, d.name as dept_name
        FROM employees e
        JOIN areas a ON e.area_id = a.id
        LEFT JOIN positions p ON e.position_id = p.id
        LEFT JOIN departments d ON e.department_id = d.id
        WHERE ${empWhere.join(' AND ')}
        ORDER BY d.name ASC, e.full_name ASC
    `).all(...empParams));

    // Fetch schedules for all active employees for this week
    const placeholders = weekDates.map(() => '?').join(',');
    const schedules = (await db.prepare(`
        SELECT es.*, e.area_id 
        FROM employee_schedules es
        JOIN employees e ON es.employee_id = e.id
        WHERE es.work_date IN (${placeholders})
    `).all(...weekDates));

    // Map by employee_id and work_date
    const scheduleMap = {};
    for (const s of schedules) {
        if (!scheduleMap[s.employee_id]) {
            scheduleMap[s.employee_id] = {};
        }
        scheduleMap[s.employee_id][s.work_date] = s;
    }

    const areas = user.role !== 'COORDINATOR' ? (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all()) : [];
    
    let deptQuery = "SELECT * FROM departments";
    let deptParams = [];
    if (selectedAreaId) {
        deptQuery += " WHERE area_id = ?";
        deptParams.push(selectedAreaId);
    }
    deptQuery += " ORDER BY name ASC";
    const departments = (await db.prepare(deptQuery).all(...deptParams));

    res.render('schedules/list', {
        title: 'Work Schedules - TAASCOR',
        view,
        targetDate,
        weekDates,
        employees,
        scheduleMap,
        selectedAreaId,
        departmentId,
        departments,
        areas
    });
});

// GET /schedules/new
router.get('/new', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();

    const selectedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : (req.query.area_id ? parseInt(req.query.area_id) : null);
    
    let empWhere = ["e.status = 'active'"];
    let empParams = [];
    if (selectedAreaId) {
        empWhere.push('e.area_id = ?');
        empParams.push(selectedAreaId);
    }

    const employees = (await db.prepare(`
        SELECT e.id, e.employee_id, e.full_name, e.area_id, d.name as dept_name, p.title as position_title
        FROM employees e
        LEFT JOIN departments d ON e.department_id = d.id
        LEFT JOIN positions p ON e.position_id = p.id
        WHERE ${empWhere.join(' AND ')}
        ORDER BY d.name ASC, e.full_name ASC
    `).all(...empParams));

    const areas = user.role !== 'COORDINATOR' ? (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all()) : [];

    res.render('schedules/form', {
        title: 'Assign Schedule - TAASCOR',
        employees,
        areas,
        selectedAreaId,
        defaultDate: DateTime.now().setZone('Asia/Manila').toFormat('yyyy-MM-dd')
    });
});

// POST /schedules
router.post('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    let { employee_ids, start_date, end_date, shift_start, shift_end, is_rest_day, notes } = req.body;

    if (!employee_ids || !start_date) {
        req.flash('error', 'Please select at least one employee and specify a date.');
        return res.redirect('/schedules/new');
    }

    if (!Array.isArray(employee_ids)) {
        employee_ids = [employee_ids];
    }

    const isRest = is_rest_day === '1' || is_rest_day === 'on' || is_rest_day === true;
    if (!isRest && (!shift_start || !shift_end)) {
        req.flash('error', 'Please specify shift start and end times or mark as Rest Day.');
        return res.redirect('/schedules/new');
    }

    // Determine date list (support single date or date range)
    const dateList = [];
    const fromDt = DateTime.fromISO(start_date, { zone: 'Asia/Manila' });
    const toDt = end_date ? DateTime.fromISO(end_date, { zone: 'Asia/Manila' }) : fromDt;

    let curr = fromDt;
    while (curr <= toDt) {
        dateList.push(curr.toFormat('yyyy-MM-dd'));
        curr = curr.plus({ days: 1 });
        if (dateList.length > 31) break; // Limit to 1 month per batch
    }

    // Verify area access for each employee
    for (const empId of employee_ids) {
        const emp = (await db.prepare('SELECT area_id FROM employees WHERE id = ?').get(parseInt(empId)));
        if (!emp || !validateAreaAccess(emp.area_id, req)) {
            return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot schedule employees outside your assigned area.', code: 403 });
        }
    }

    // Save schedules with conflict upsert
    let savedCount = 0;
    const saveStmt = db.prepare(`
        INSERT INTO employee_schedules (employee_id, work_date, shift_start, shift_end, is_rest_day, notes, created_by, created_at, updated_by, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, UTC_TIMESTAMP(), 1)
        ON DUPLICATE KEY UPDATE
            shift_start = VALUES(shift_start),
            shift_end = VALUES(shift_end),
            is_rest_day = VALUES(is_rest_day),
            notes = VALUES(notes),
            updated_by = VALUES(updated_by),
            updated_at = UTC_TIMESTAMP(),
            version = version + 1
    `);

    for (const empId of employee_ids) {
        for (const date of dateList) {
            (await saveStmt.run(
                parseInt(empId),
                date,
                isRest ? null : shift_start,
                isRest ? null : shift_end,
                isRest ? 1 : 0,
                notes ? notes.trim() : null,
                user.id,
                user.id
            ));
            savedCount++;
        }
    }

    (await logAction(user.id, 'ASSIGN_SCHEDULE', 'employee_schedules', null, {
        employees_count: employee_ids.length,
        dates_count: dateList.length,
        shift: isRest ? 'Rest Day' : `${shift_start} - ${shift_end}`
    }));

    req.flash('success', `Successfully saved ${savedCount} schedule record(s).`);
    res.redirect(`/schedules?date=${start_date}`);
});

module.exports = router;
