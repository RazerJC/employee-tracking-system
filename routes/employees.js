const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireArea, validateAreaAccess } = require('../middleware/area-guard');
const { getDb } = require('../db/database');
const { DateTime } = require('luxon');
const { labels, validDate, absenceCondition } = require('../services/employee-status');
const { logAction } = require('../services/audit');

// GET /employees
router.get('/', requireAuth, requireArea, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const tab = req.query.tab === 'inactive' ? 'inactive' : 'active';
    const search = req.query.search ? req.query.search.trim() : '';
    const positionId = req.query.position_id ? parseInt(req.query.position_id) : null;
    const departmentId = req.query.department_id ? parseInt(req.query.department_id) : null;
    const selectedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : (req.query.area_id ? parseInt(req.query.area_id) : null);

    let where = ['e.status = ?'];
    let params = [tab];

    if (selectedAreaId) {
        where.push('e.area_id = ?');
        params.push(selectedAreaId);
    }

    if (positionId) {
        where.push('e.position_id = ?');
        params.push(positionId);
    }

    if (departmentId) {
        where.push('e.department_id = ?');
        params.push(departmentId);
    }

    if (search) {
        where.push('(e.full_name LIKE ? OR e.employee_id LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
    }

    const whereClause = 'WHERE ' + where.join(' AND ');

    const employees = (await db.prepare(`
        SELECT e.*, a.name as area_name, p.title as position_title, u.full_name as coordinator_name,
               d.name as dept_name,
               (SELECT status FROM btw_cases WHERE employee_id=e.id ORDER BY CASE WHEN status <> 'approved' THEN 0 ELSE 1 END, id DESC LIMIT 1) as open_btw_status
        FROM employees e
        JOIN areas a ON e.area_id = a.id
        LEFT JOIN positions p ON e.position_id = p.id
        LEFT JOIN departments d ON e.department_id = d.id
        LEFT JOIN users u ON e.coordinator_id = u.id
        ${whereClause}
        ORDER BY e.full_name ASC
    `).all(...params));

    // Counts for tabs
    let activeWhere = user.role === 'COORDINATOR' ? "WHERE area_id = ? AND status = 'active'" : "WHERE status = 'active'";
    let inactiveWhere = user.role === 'COORDINATOR' ? "WHERE area_id = ? AND status = 'inactive'" : "WHERE status = 'inactive'";
    const activeParams = user.role === 'COORDINATOR' ? [req.userAreaId] : [];
    const inactiveParams = user.role === 'COORDINATOR' ? [req.userAreaId] : [];

    const activeCount = (await db.prepare(`SELECT COUNT(*) as count FROM employees ${activeWhere}`).get(...activeParams)).count;
    const inactiveCount = (await db.prepare(`SELECT COUNT(*) as count FROM employees ${inactiveWhere}`).get(...inactiveParams)).count;

    const positions = (await db.prepare('SELECT * FROM positions WHERE is_active = 1 ORDER BY title ASC').all());
    const areas = user.role !== 'COORDINATOR' ? (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all()) : [];

    // Departments for filtering
    let deptQuery = "SELECT * FROM departments";
    let deptQueryParams = [];
    if (selectedAreaId) {
        deptQuery += " WHERE area_id = ?";
        deptQueryParams.push(selectedAreaId);
    }
    deptQuery += " ORDER BY name ASC";
    const departments = (await db.prepare(deptQuery).all(...deptQueryParams));

    res.render('employees/list', {
        title: 'Employee Masterfile - TAASCOR',
        employees,
        tab,
        search,
        positionId,
        departmentId,
        selectedAreaId,
        activeCount,
        inactiveCount,
        positions,
        departments,
        areas
    });
});

// GET /employees/new
router.get('/new', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();

    if (user.role === 'COORDINATOR' && !req.userAreaId) {
        req.flash('error', 'You do not have an assigned area.');
        return res.redirect('/employees');
    }

    const positions = (await db.prepare('SELECT * FROM positions WHERE is_active = 1 ORDER BY title ASC').all());
    const areas = user.role === 'COORDINATOR'
        ? [req.userArea]
        : (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all());

    const targetAreaId = user.role === 'COORDINATOR' ? req.userAreaId : areas[0]?.id;
    const departments = (await db.prepare('SELECT * FROM departments WHERE area_id = ? ORDER BY name ASC').all(targetAreaId));

    res.render('employees/form', {
        title: 'Add Employee - TAASCOR',
        employee: null,
        positions,
        departments,
        areas,
        isEdit: false
    });
});

// POST /employees
router.post('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const { employee_id, first_name, last_name, area_id, position_id, position_title, department_id, employment_start_date, remarks } = req.body;
    const db = getDb();

    const firstName = String(first_name || '').trim();
    const lastName = String(last_name || '').trim();
    const employeeId = String(employee_id || '').trim();
    const positionName = String(position_title || '').trim();
    const startDate = String(employment_start_date || '').trim();
    if (!employeeId || !firstName || !lastName || !startDate) {
        req.flash('error', 'Employee ID, first name, last name, and employment start date are required.');
        return res.redirect('/employees/new');
    }

    const assignedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : Number.parseInt(area_id, 10);
    if (!Number.isInteger(assignedAreaId)) {
        req.flash('error', 'Please select a valid warehouse or area.');
        return res.redirect('/employees/new');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !DateTime.fromISO(startDate).isValid) {
        req.flash('error', 'Please enter a valid employment start date.');
        return res.redirect('/employees/new');
    }

    const area = await db.prepare('SELECT id FROM areas WHERE id = ? AND is_active = 1').get(assignedAreaId);
    if (!area) {
        req.flash('error', 'The selected warehouse or area is not available.');
        return res.redirect('/employees/new');
    }

    // Validate area access
    if (!validateAreaAccess(assignedAreaId, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You can only add employees to your assigned area.', code: 403 });
    }

    let resolvedPositionId = position_id ? Number.parseInt(position_id, 10) : null;
    if (positionName) {
        const existingPosition = await db.prepare('SELECT id FROM positions WHERE LOWER(title) = LOWER(?) LIMIT 1').get(positionName);
        if (existingPosition) {
            resolvedPositionId = existingPosition.id;
        } else {
            const createdPosition = await db.prepare(`INSERT INTO positions (title, description, is_active, created_at, created_by)
                VALUES (?, ?, 1, UTC_TIMESTAMP(), ?)`)
                .run(positionName, `Added while creating an employee${user.role === 'COORDINATOR' ? ' by a coordinator' : ''}`, user.id);
            resolvedPositionId = createdPosition.lastInsertRowid;
        }
    }

    if (resolvedPositionId && !Number.isInteger(resolvedPositionId)) {
        req.flash('error', 'Please enter a valid position.');
        return res.redirect('/employees/new');
    }

    const coordinatorId = user.role === 'COORDINATOR' ? user.id : null;
    const fullName = `${firstName} ${lastName}`;

    let result;
    try {
        result = (await db.prepare(`
        INSERT INTO employees (employee_id, first_name, last_name, full_name, area_id, coordinator_id, position_id, department_id, employment_start_date, status, remarks, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)
    `).run(
        employeeId,
        firstName,
        lastName,
        fullName,
        assignedAreaId,
        coordinatorId,
        resolvedPositionId,
        department_id ? parseInt(department_id) : null,
        startDate,
        remarks ? remarks.trim() : null,
        user.id
        ));
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            req.flash('error', `Employee ID ${employeeId} already exists. Use a unique Employee ID.`);
            return res.redirect('/employees/new');
        }
        throw error;
    }

    (await logAction(user.id, 'CREATE_EMPLOYEE', 'employees', result.lastInsertRowid, {
        employee_id: employeeId,
        full_name: fullName,
        area_id: assignedAreaId,
        department_id: department_id ? parseInt(department_id) : null
    }));

    req.flash('success', `Employee ${fullName} (${employeeId}) added successfully.`);
    res.redirect(`/employees/${result.lastInsertRowid}`);
});

router.get('/:id/status', requireAuth, async (req, res) => {
    const db = getDb();
    const employee = await db.prepare('SELECT e.*, d.name AS dept_name FROM employees e LEFT JOIN departments d ON d.id=e.department_id WHERE e.id=?').get(req.params.id);
    if (!employee) return res.status(404).json({ error: 'Employee not found.' });
    if (!validateAreaAccess(employee.area_id, req)) return res.status(403).json({ error: 'Access denied.' });
    const now = DateTime.now().setZone('Asia/Manila');
    const all = req.query.all === '1';
    const from = req.query.from || now.startOf('month').toISODate();
    const to = req.query.to || now.toISODate();
    if (!all && (!validDate(from) || !validDate(to) || from > to)) return res.status(400).json({ error: 'Enter a valid date range.' });
    const absences = await db.prepare(`SELECT ea.work_date, ea.remarks FROM employee_attendance ea WHERE ea.employee_id=? AND ${absenceCondition} ${all ? '' : 'AND ea.work_date BETWEEN ? AND ?'} ORDER BY ea.work_date DESC`).all(employee.id, ...(all ? [] : [from,to]));
    const cases = await db.prepare('SELECT id, case_ref, status, absence_dates, hr_remarks, decision_at, authorized_return_date FROM btw_cases WHERE employee_id=? ORDER BY id DESC').all(employee.id);
    const actions = await db.prepare('SELECT h.*, u.full_name AS author_name FROM btw_hr_actions h JOIN btw_cases b ON b.id=h.case_id JOIN users u ON u.id=h.author_id WHERE b.employee_id=? ORDER BY h.id DESC').all(employee.id);
    res.json({ employee: { full_name: employee.full_name, dept_name: employee.dept_name, status: employee.status }, from, to, all, absences, cases, actions, labels });
});

// GET /employees/:id
router.get('/:id', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);

    const employee = (await db.prepare(`
        SELECT e.*, a.name as area_name, p.title as position_title, u.full_name as coordinator_name,
               d.name as dept_name
        FROM employees e
        JOIN areas a ON e.area_id = a.id
        LEFT JOIN positions p ON e.position_id = p.id
        LEFT JOIN departments d ON e.department_id = d.id
        LEFT JOIN users u ON e.coordinator_id = u.id
        WHERE e.id = ?
    `).get(id));

    if (!employee) {
        req.flash('error', 'Employee not found.');
        return res.redirect('/employees');
    }

    if (!validateAreaAccess(employee.area_id, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You can only access employees within your assigned area.', code: 403 });
    }

    // Historical attendance summary
    const attendanceStats = (await db.prepare(`
        SELECT 
            COUNT(*) as total_records,
            SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as present_count,
            SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) as late_count,
            SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) as absent_count,
            SUM(CASE WHEN status IN ('leave', 'on_leave') THEN 1 ELSE 0 END) as leave_count,
            SUM(CASE WHEN status = 'no_work' THEN 1 ELSE 0 END) as nowork_count,
            SUM(CASE WHEN status = 'sent_home' THEN 1 ELSE 0 END) as senthome_count,
            SUM(CASE WHEN status = 'rest_day' THEN 1 ELSE 0 END) as restday_count
        FROM employee_attendance
        WHERE employee_id = ?
    `).get(id));

    // Recent attendance
    const recentAttendance = (await db.prepare(`
        SELECT ea.*, u.full_name as recorded_by_name
        FROM employee_attendance ea
        LEFT JOIN users u ON ea.recorded_by = u.id
        WHERE ea.employee_id = ?
        ORDER BY ea.work_date DESC
        LIMIT 10
    `).all(id));

    // BTW cases
    const btwCases = (await db.prepare(`
        SELECT * FROM btw_cases WHERE employee_id = ? ORDER BY created_at DESC
    `).all(id));

    // Concerns
    const concerns = (await db.prepare(`
        SELECT * FROM concern_reports WHERE employee_id = ? ORDER BY created_at DESC
    `).all(id));

    // Departments in this area for quick reassignment
    const departments = (await db.prepare('SELECT * FROM departments WHERE area_id = ? ORDER BY name ASC').all(employee.area_id));

    res.render('employees/view', {
        title: `${employee.full_name} - Employee Details`,
        employee,
        attendanceStats,
        recentAttendance,
        btwCases,
        concerns,
        departments
    });
});

// GET /employees/:id/edit
router.get('/:id/edit', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);

    const employee = (await db.prepare(`SELECT e.*, p.title AS position_title
        FROM employees e LEFT JOIN positions p ON p.id = e.position_id WHERE e.id = ?`).get(id));
    if (!employee) {
        req.flash('error', 'Employee not found.');
        return res.redirect('/employees');
    }

    if (!validateAreaAccess(employee.area_id, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You can only edit employees within your assigned area.', code: 403 });
    }

    const positions = (await db.prepare('SELECT * FROM positions WHERE is_active = 1 ORDER BY title ASC').all());
    const areas = user.role === 'COORDINATOR'
        ? [req.userArea]
        : (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all());

    const departments = (await db.prepare('SELECT * FROM departments WHERE area_id = ? ORDER BY name ASC').all(employee.area_id));

    res.render('employees/form', {
        title: `Edit ${employee.full_name} - TAASCOR`,
        employee,
        positions,
        departments,
        areas,
        isEdit: true
    });
});

// POST /employees/:id/edit
router.post('/:id/edit', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);

    const employee = (await db.prepare('SELECT * FROM employees WHERE id = ?').get(id));
    if (!employee) {
        req.flash('error', 'Employee not found.');
        return res.redirect('/employees');
    }

    if (!validateAreaAccess(employee.area_id, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You can only edit employees within your assigned area.', code: 403 });
    }

    const { first_name, last_name, position_id, position_title, department_id, employment_start_date, remarks, area_id } = req.body;
    const firstName = String(first_name || '').trim();
    const lastName = String(last_name || '').trim();
    const startDate = String(employment_start_date || '').trim();
    if (!firstName || !lastName || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !DateTime.fromISO(startDate).isValid) {
        req.flash('error', 'First name, last name, and a valid employment start date are required.');
        return res.redirect(`/employees/${id}/edit`);
    }
    const targetAreaId = user.role === 'COORDINATOR' ? req.userAreaId : (area_id ? parseInt(area_id) : employee.area_id);
    const departmentId = department_id ? Number(department_id) : null;
    if (department_id && !await db.prepare('SELECT id FROM departments WHERE id = ? AND area_id = ?').get(departmentId || 0, targetAreaId)) {
        req.flash('error', 'Select a department in the employee’s warehouse.');
        return res.redirect(`/employees/${id}/edit`);
    }
    const positionName = String(position_title || '').trim();
    let resolvedPositionId = position_id ? Number.parseInt(position_id, 10) : null;
    if (positionName) {
        const existingPosition = await db.prepare('SELECT id FROM positions WHERE LOWER(title) = LOWER(?) LIMIT 1').get(positionName);
        if (existingPosition) resolvedPositionId = existingPosition.id;
        else {
            const created = await db.prepare(`INSERT INTO positions (title, description, is_active, created_at, created_by)
                VALUES (?, ?, 1, UTC_TIMESTAMP(), ?)`).run(positionName, 'Added while editing an employee', user.id);
            resolvedPositionId = created.lastInsertRowid;
        }
    }
    const fullName = `${firstName} ${lastName}`;

    (await db.prepare(`
        UPDATE employees 
        SET first_name = ?, last_name = ?, full_name = ?, position_id = ?, department_id = ?,
            area_id = ?, employment_start_date = ?, remarks = ?, updated_at = UTC_TIMESTAMP(), updated_by = ?
        WHERE id = ?
    `).run(
        firstName,
        lastName,
        fullName,
        resolvedPositionId,
        departmentId,
        targetAreaId,
        startDate,
        remarks ? remarks.trim() : null,
        user.id,
        id
    ));

    (await logAction(user.id, 'UPDATE_EMPLOYEE', 'employees', id, { full_name: fullName, department_id: departmentId }));

    req.flash('success', 'Employee updated successfully.');
    res.redirect(`/employees/${id}`);
});

// POST /employees/:id/assign-department
router.post('/:id/assign-department', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);
    const departmentId = req.body.department_id ? parseInt(req.body.department_id) : null;

    const employee = (await db.prepare('SELECT * FROM employees WHERE id = ?').get(id));
    if (!employee) {
        req.flash('error', 'Employee not found.');
        return res.redirect('back');
    }

    if (!validateAreaAccess(employee.area_id, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot alter employees outside your assigned area.', code: 403 });
    }

    let deptName = 'Unassigned';
    if (req.body.department_id) {
        const dept = await db.prepare('SELECT name FROM departments WHERE id = ? AND area_id = ?').get(departmentId || 0, employee.area_id);
        if (!dept) {
            req.flash('error', 'Select a department in the employee’s warehouse.');
            return res.redirect(`/employees/${id}`);
        }
        deptName = dept.name;
    }

    (await db.prepare("UPDATE employees SET department_id = ?, updated_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?")
        .run(departmentId, user.id, id));

    (await logAction(user.id, 'ASSIGN_EMPLOYEE_DEPARTMENT', 'employees', id, { full_name: employee.full_name, department_id: departmentId, department_name: deptName }));
    req.flash('success', `${employee.full_name} assigned to "${deptName}".`);
    res.redirect('back');
});

// POST /employees/:id/toggle-status (Deactivate or Reactivate - preserves all historical records!)
router.post('/:id/toggle-status', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);

    const employee = (await db.prepare('SELECT * FROM employees WHERE id = ?').get(id));
    if (!employee) {
        req.flash('error', 'Employee not found.');
        return res.redirect('/employees');
    }

    if (!validateAreaAccess(employee.area_id, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot alter employee status outside your assigned area.', code: 403 });
    }

    if (employee.status === 'active') {
        const { inactivation_reason } = req.body;
        if (!inactivation_reason) {
            req.flash('error', 'Please provide a reason for deactivation.');
            return res.redirect(`/employees/${id}`);
        }

        const now = new Date().toISOString().split('T')[0];
        (await db.prepare(`
            UPDATE employees 
            SET status = 'inactive', inactivation_date = ?, inactivation_reason = ?, updated_at = UTC_TIMESTAMP(), updated_by = ?
            WHERE id = ?
        `).run(now, inactivation_reason.trim(), user.id, id));

        (await logAction(user.id, 'DEACTIVATE_EMPLOYEE', 'employees', id, { reason: inactivation_reason }));
        req.flash('success', `${employee.full_name} has been marked inactive. All historical records have been preserved.`);
    } else {
        (await db.prepare(`
            UPDATE employees 
            SET status = 'active', inactivation_date = NULL, inactivation_reason = NULL, updated_at = UTC_TIMESTAMP(), updated_by = ?
            WHERE id = ?
        `).run(user.id, id));

        (await logAction(user.id, 'REACTIVATE_EMPLOYEE', 'employees', id));
        req.flash('success', `${employee.full_name} has been reactivated.`);
    }

    res.redirect(`/employees/${id}`);
});

module.exports = router;
