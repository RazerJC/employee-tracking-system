const { getDb } = require('../db/database');
const { validDate, absenceCondition } = require('./employee-status');
const { DateTime } = require('luxon');
module.exports = async function hrDashboard(req, res) {
    const db = getDb();
    const today = DateTime.now().setZone('Asia/Manila').toISODate();
    const date = req.query.date || today;
    if (!validDate(date)) return res.status(400).render('error', { title: 'Invalid date', message: 'Select a valid date.', code: 400 });
    const monthStart = date.slice(0, 7) + '-01';
    const monthEnd = DateTime.fromISO(date).endOf('month').toISODate();
    const employees = await db.prepare(`SELECT e.id,e.full_name,e.department_id,d.name AS dept_name,a.name AS area_name,
        es.shift_start,es.shift_end,es.is_rest_day,es.id AS schedule_id, ea.status AS att_status,
        (SELECT COUNT(*) FROM employee_attendance ea WHERE ea.employee_id=e.id AND ${absenceCondition} AND ea.work_date BETWEEN ? AND ?) AS absence_count,
        (SELECT status FROM btw_cases b WHERE b.employee_id=e.id ORDER BY CASE WHEN b.status <> 'approved' THEN 0 ELSE 1 END, b.id DESC LIMIT 1) AS btw_status
        FROM employees e JOIN areas a ON a.id=e.area_id LEFT JOIN departments d ON d.id=e.department_id
        LEFT JOIN employee_schedules es ON es.employee_id=e.id AND es.work_date=?
        LEFT JOIN employee_attendance ea ON ea.employee_id=e.id AND ea.work_date=?
        WHERE e.status='active' ORDER BY a.name,d.name,e.full_name`).all(monthStart,monthEnd,date,date);
    const departments = new Map();
    for (const e of employees) {
        e.actual = e.att_status || (e.is_rest_day ? 'rest_day' : 'unmarked');
        if (e.is_rest_day && e.actual === 'absent') e.actual = 'rest_day';
        const key = `${e.area_name}/${e.department_id || 0}`;
        if (!departments.has(key)) departments.set(key, { key, name: e.dept_name || 'Unassigned', area: e.area_name, present: 0, absent: 0, rest: 0, unmarked: 0, total: 0 });
        e.department_key = key;
        const d = departments.get(key); d.total++;
        if (['present','late'].includes(e.actual)) d.present++;
        if (e.actual === 'absent') d.absent++;
        if (e.actual === 'rest_day') d.rest++;
        if (e.actual === 'unmarked') d.unmarked++;
    }
    const alerts = await db.prepare(`SELECT e.id,e.full_name,d.name AS dept_name, COUNT(DISTINCT ea.work_date) AS absence_count
        FROM employees e JOIN employee_attendance ea ON ea.employee_id=e.id
        LEFT JOIN departments d ON d.id=e.department_id
        WHERE ${absenceCondition} AND NOT EXISTS (
            SELECT 1 FROM btw_cases b WHERE b.employee_id=e.id AND b.status='approved'
            AND (b.absence_dates IS NULL OR INSTR(b.absence_dates, ea.work_date) = 0))
        GROUP BY e.id,e.full_name,d.name ORDER BY e.full_name`).all();
    const coordinators = await db.prepare(`SELECT u.full_name,a.name AS area_name,ca.time_in,ca.time_out
        FROM users u LEFT JOIN coordinator_area_assignments x ON x.user_id=u.id AND x.is_current=1
        LEFT JOIN areas a ON a.id=x.area_id LEFT JOIN coordinator_attendance ca ON ca.user_id=u.id AND ca.work_date=?
        WHERE u.role='COORDINATOR' AND u.status='active' ORDER BY u.full_name`).all(date);
    const manpower = await db.prepare(`SELECT mr.id,mr.status,a.name AS area_name,mr.deployment_date,
        (SELECT COALESCE(SUM(quantity_requested),0) FROM manpower_request_positions WHERE request_id=mr.id) AS total_requested
        FROM manpower_requests mr JOIN areas a ON a.id=mr.area_id
        WHERE mr.status NOT IN ('filled','declined','cancelled') ORDER BY mr.deployment_date,mr.id LIMIT 5`).all();
    res.render('dashboard/hr', { title: 'HR Dashboard - TAASCOR', date, monthStart, monthEnd, employees, departments: [...departments.values()], alerts, coordinators, manpower });
};
