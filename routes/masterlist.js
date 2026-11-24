const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validDate } = require('../services/employee-status');

const router = express.Router();

const columns = [
    ['Employee Ident', 'employee_ident'], ['Old Employee Ident', 'old_employee_ident'],
    ['Payroll Employee ID', 'payroll_employee_id'], ['Full Name', 'full_name'],
    ['Last Name', 'last_name'], ['First Name', 'first_name'], ['Middle Name', 'middle_name'],
    ['Hire Date', 'hire_date', 'date'], ['Separation Date', 'separation_date', 'date'],
    ['Present Address', 'present_address'], ['Permanent Address', 'permanent_address'],
    ['Contact Number', 'phone', 'tel'], ['Email Address', 'email', 'email'],
    ['Birthday', 'birthday', 'date'], ['Birth Place', 'birth_place'], ['Gender', 'gender'],
    ['Civil Status', 'civil_status'], ['Nationality', 'nationality'],
    ['Emergency Person', 'emergency_person'], ['Emergency Contact Number', 'emergency_contact_number', 'tel'],
    ['Client Date', 'client_date', 'date'], ['Position', 'position'], ['Client', 'client'],
    ['Branch', 'branch'], ['Client Location', 'client_location'], ['Department', 'department'],
    ['TIN', 'tin'], ['SSS', 'sss'], ['PHILHEALTH', 'philhealth'], ['PAG-IBIG', 'pag_ibig'],
    ['Bank Account Number', 'bank_account_number'], ['Daily Salary', 'daily_salary', 'number'],
    ['Bank Name', 'bank_name'], ['Insurance', 'insurance'], ['Annual Leaves', 'annual_leaves', 'number'],
    ['Employee Type', 'employee_type'], ['Pay Type', 'pay_type']
];

const employeeSql = `
    SELECT e.id, e.employee_id AS employee_ident, e.full_name, e.last_name, e.first_name,
           e.employment_start_date AS hire_date, p.title AS position,
           a.name AS branch, d.name AS department, m.details
    FROM employees e
    JOIN areas a ON a.id = e.area_id
    LEFT JOIN positions p ON p.id = e.position_id
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN masterlist_details m ON m.employee_id = e.id
    WHERE e.coordinator_id = ? AND e.area_id = ?
`;

const coordinatorSql = `
    SELECT u.id, u.full_name, u.email, u.phone, 'Coordinator' AS position, a.name AS branch, m.details
    FROM users u
    LEFT JOIN coordinator_area_assignments assignment ON assignment.id = (
        SELECT ca.id FROM coordinator_area_assignments ca
        WHERE ca.user_id = u.id AND ca.is_current = 1 ORDER BY ca.id DESC LIMIT 1
    )
    LEFT JOIN areas a ON a.id = assignment.area_id
    LEFT JOIN masterlist_details m ON m.coordinator_id = u.id
    WHERE u.role = 'COORDINATOR' AND u.status IN ('active', 'suspended')
`;

function roster(req) {
    const employees = req.session.user.role === 'COORDINATOR';
    return {
        employees,
        title: employees ? 'Employee Masterlist' : 'Coordinator Masterlist',
        sql: employees ? employeeSql : coordinatorSql,
        params: employees ? [req.session.user.id, req.userAreaId] : [],
        idColumn: employees ? 'e.id' : 'u.id'
    };
}

function fieldValues(record) {
    const stored = typeof record.details === 'string' ? JSON.parse(record.details) : record.details;
    const values = { ...record, ...stored };
    if (record.department) values.department = record.department;
    return values;
}

router.use(requireAuth, requireRole('HR', 'HEAD_HR', 'COORDINATOR'));
router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
});

router.get('/', async (req, res) => {
    const { title, sql, params, idColumn } = roster(req);
    const records = await getDb().prepare(`${sql} ORDER BY full_name, ${idColumn}`).all(...params);
    res.render('masterlist/index', { title, columns, rows: records.map(fieldValues) });
});

router.route('/:id/edit')
    .all(async (req, res, next) => {
        const scope = roster(req);
        const id = Number(req.params.id);
        const record = Number.isSafeInteger(id) && id > 0
            ? await getDb().prepare(`${scope.sql} AND ${scope.idColumn} = ?`).get(...scope.params, id)
            : null;
        if (!record) {
            return res.status(404).render('error', {
                title: 'Record Not Found', message: 'This person is not in your masterlist.', code: 404
            });
        }
        req.masterlistRecord = record;
        next();
    })
    .get((req, res) => {
        res.render('masterlist/edit', {
            title: 'Edit Masterlist Details', columns, record: fieldValues(req.masterlistRecord), error: null,
            assignedDepartment: req.masterlistRecord.department
        });
    })
    .post(async (req, res) => {
        const source = req.masterlistRecord;
        const { employees, params } = roster(req);
        const submitted = {};
        let error = null;
        for (const [label, key, type] of columns) {
            if (key === 'department' && source.department) continue;
            const value = req.body[key];
            if (typeof value !== 'string') {
                error ??= `Please provide a value or leave ${label} blank.`;
                continue;
            }
            submitted[key] = value.trim();
            if (submitted[key].length > 500) error ??= `${label} must be 500 characters or fewer.`;
            if (type === 'date' && submitted[key] && !validDate(submitted[key])) {
                error ??= `Enter a valid date for ${label}.`;
            }
            if (type === 'number' && submitted[key] && !/^\d+(?:\.\d+)?$/.test(submitted[key])) {
                error ??= `Enter a nonnegative number for ${label}.`;
            }
        }
        if (error) {
            return res.status(400).render('masterlist/edit', {
                title: 'Edit Masterlist Details', columns, record: { ...fieldValues(source), ...submitted }, error,
                assignedDepartment: source.department
            });
        }

        const details = JSON.stringify(Object.fromEntries(
            Object.entries(submitted).filter(([key, value]) => value !== (source[key] ?? ''))
        ));
        const db = getDb();
        if (employees) {
            await db.prepare(`
                INSERT INTO masterlist_details (employee_id, details)
                SELECT id, ? FROM employees WHERE id = ? AND coordinator_id = ? AND area_id = ?
                ON DUPLICATE KEY UPDATE details = VALUES(details)
            `).run(details, source.id, ...params);
        } else {
            await db.prepare(`
                INSERT INTO masterlist_details (coordinator_id, details)
                SELECT id, ? FROM users WHERE id = ? AND role = 'COORDINATOR' AND status IN ('active', 'suspended')
                ON DUPLICATE KEY UPDATE details = VALUES(details)
            `).run(details, source.id);
        }
        req.flash('success', 'Masterlist details saved.');
        res.redirect('/masterlist');
    });

module.exports = router;
