const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireArea } = require('../middleware/area-guard');
const { getDb } = require('../db/database');
const { pendingCategories, getPendingCounts, getPendingRecords } = require('../services/pending-work');
const { getManpowerDashboard } = require('../services/manpower');
const { DateTime } = require('luxon');

// GET /dashboard
router.get('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const today = DateTime.now().setZone('Asia/Manila').toFormat('yyyy-MM-dd');

    if (user.role === 'COORDINATOR') {
        const areaId = req.userAreaId;
        if (!areaId) {
            return res.render('dashboard/coordinator', {
                title: 'Coordinator Dashboard - TAASCOR',
                noArea: true
            });
        }

        // Active & inactive counts
        const empStats = (await db.prepare(`
            SELECT 
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
                SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) as inactive_count
            FROM employees 
            WHERE area_id = ?
        `).get(areaId));

        // Today's attendance stats for assigned area
        const attStats = (await db.prepare(`
            SELECT 
                SUM(CASE WHEN ea.status = 'present' THEN 1 ELSE 0 END) as present_count,
                SUM(CASE WHEN ea.status = 'late' THEN 1 ELSE 0 END) as late_count,
                SUM(CASE WHEN ea.status = 'absent' THEN 1 ELSE 0 END) as absent_count,
                SUM(CASE WHEN ea.status = 'on_leave' THEN 1 ELSE 0 END) as leave_count,
                SUM(CASE WHEN ea.status = 'rest_day' THEN 1 ELSE 0 END) as rest_count
            FROM employee_attendance ea
            JOIN employees e ON ea.employee_id = e.id
            WHERE e.area_id = ? AND ea.work_date = ?
        `).get(areaId, today));

        // Employees scheduled today
        const scheduledTodayCount = (await db.prepare(`
            SELECT COUNT(*) as count 
            FROM employee_schedules es
            JOIN employees e ON es.employee_id = e.id
            WHERE e.area_id = ? AND es.work_date = ? AND es.is_rest_day = 0 AND e.status = 'active'
        `).get(areaId, today)).count;

        // Employees absent today
        const absentToday = (await db.prepare(`
            SELECT e.id, e.employee_id, e.full_name, p.title as position_title, ea.remarks, b.id as btw_id, b.status as btw_status
            FROM employee_attendance ea
            JOIN employees e ON ea.employee_id = e.id
            LEFT JOIN positions p ON e.position_id = p.id
            LEFT JOIN btw_cases b ON b.employee_id = e.id AND b.status IN ('pending_hr_review', 'for_clarification')
            WHERE e.area_id = ? AND ea.work_date = ? AND ea.status = 'absent'
        `).all(areaId, today));

        // Pending BTW cases
        const pendingBtw = (await db.prepare(`
            SELECT b.*, e.full_name, e.employee_id as emp_code
            FROM btw_cases b
            JOIN employees e ON b.employee_id = e.id
            WHERE b.area_id = ? AND b.status IN ('pending_hr_review', 'for_clarification')
            ORDER BY b.created_at DESC
        `).all(areaId));

        // Open employee concerns
        const openConcerns = (await db.prepare(`
            SELECT c.*, e.full_name, e.employee_id as emp_code
            FROM concern_reports c
            JOIN employees e ON c.employee_id = e.id
            WHERE c.area_id = ? AND c.status != 'resolved'
            ORDER BY c.created_at DESC
        `).all(areaId));

        // Manpower requests in progress
        const manpowerRequests = (await db.prepare(`
            SELECT mr.*, 
                   COALESCE((SELECT SUM(quantity_requested) FROM manpower_request_positions WHERE request_id = mr.id), 0) as total_requested,
                   COALESCE((SELECT COUNT(*) FROM manpower_allocations WHERE request_id = mr.id AND status = 'confirmed'), 0) as confirmed_count,
                   COALESCE((SELECT COUNT(*) FROM manpower_allocations WHERE request_id = mr.id AND status = 'proposed'), 0) as proposed_count
            FROM manpower_requests mr
            WHERE mr.area_id = ? AND mr.status NOT IN ('filled', 'declined', 'cancelled')
            ORDER BY mr.created_at DESC
        `).all(areaId));

        // Incoming workers awaiting coordinator confirmation
        const incomingWorkers = (await db.prepare(`
            SELECT ma.*, mr.deployment_date, p.title as requested_position, e.full_name as emp_name
            FROM manpower_allocations ma
            JOIN manpower_requests mr ON ma.request_id = mr.id
            LEFT JOIN manpower_request_positions mrp ON ma.request_position_id = mrp.id
            LEFT JOIN positions p ON mrp.position_id = p.id
            LEFT JOIN employees e ON ma.employee_id = e.id
            WHERE mr.area_id = ? AND ma.status = 'proposed'
            ORDER BY mr.deployment_date ASC
        `).all(areaId));

        // Coordinator's own attendance today
        const ownAttendance = (await db.prepare(`
            SELECT * FROM coordinator_attendance 
            WHERE user_id = ? AND work_date = ?
        `).get(user.id, today));

        return res.render('dashboard/coordinator', {
            title: 'Coordinator Dashboard - TAASCOR',
            today,
            activeCount: empStats?.active_count || 0,
            inactiveCount: empStats?.inactive_count || 0,
            presentCount: attStats?.present_count || 0,
            lateCount: attStats?.late_count || 0,
            absentCount: attStats?.absent_count || 0,
            leaveCount: attStats?.leave_count || 0,
            restCount: attStats?.rest_count || 0,
            scheduledTodayCount,
            absentToday,
            pendingBtw,
            openConcerns,
            manpowerRequests,
            incomingWorkers,
            ownAttendance,
            noArea: false
        });
    }

    if (user.role === 'HR') return require('../services/hr-dashboard')(req, res);

    if (user.role === 'HEAD_HR') return res.redirect('/coordinator-attendance');

    if (user.role === 'ADMIN') {
        const areas = await db.prepare('SELECT id, name FROM areas ORDER BY name, id').all();
        const areaId = areas.find(area => String(area.id) === req.query.area_id)?.id;
        const mode = req.query.by === 'coordinator' ? 'coordinator' : 'department';
        const pendingCategory = pendingCategories.find(category => category.key === req.query.pending);
        const [departments, coordinators, pendingCounts, pendingRecords, manpowerDashboard] = await Promise.all([
            db.prepare(`
                SELECT a.id AS area_id, a.name AS area_name, d.id AS department_id, d.name AS department_name,
                       u.id AS coordinator_id, u.full_name AS coordinator_name,
                       COUNT(e.id) AS worker_count
                FROM departments d
                JOIN areas a ON a.id = d.area_id
                LEFT JOIN employees e ON e.department_id = d.id AND e.area_id = a.id AND e.status = 'active'
                LEFT JOIN users u ON u.id = e.coordinator_id AND u.role = 'COORDINATOR'
                GROUP BY a.id, a.name, d.id, d.name, u.id, u.full_name

                UNION ALL

                SELECT a.id, a.name, NULL, NULL, u.id, u.full_name, COUNT(e.id)
                FROM employees e
                JOIN areas a ON a.id = e.area_id
                LEFT JOIN departments d ON d.id = e.department_id AND d.area_id = a.id
                LEFT JOIN users u ON u.id = e.coordinator_id AND u.role = 'COORDINATOR'
                WHERE e.status = 'active' AND d.id IS NULL
                GROUP BY a.id, a.name, u.id, u.full_name
                ORDER BY area_name, department_name, coordinator_name
            `).all(),
            db.prepare(`
                SELECT u.id, u.full_name, u.status, a.id AS assigned_area_id, a.name AS assigned_area
                FROM users u
                LEFT JOIN coordinator_area_assignments ca ON ca.id = (
                    SELECT assignment.id FROM coordinator_area_assignments assignment
                    WHERE assignment.user_id = u.id AND assignment.is_current = 1
                    ORDER BY assignment.assigned_at DESC, assignment.id DESC LIMIT 1
                )
                LEFT JOIN areas a ON a.id = ca.area_id
                WHERE u.role = 'COORDINATOR'
                ORDER BY u.full_name, u.id
            `).all(),
            areaId ? getPendingCounts(db, areaId) : res.locals.menuGlow,
            pendingCategory ? getPendingRecords(db, pendingCategory, areaId) : [],
            !pendingCategory && !req.query.group ? getManpowerDashboard(db, areaId) : null
        ]);
        const rows = departments.filter(row => !areaId || row.area_id === areaId);
        const groups = new Map();
        if (mode === 'coordinator') {
            for (const coordinator of coordinators) {
                if (!areaId || coordinator.assigned_area_id === areaId || rows.some(row => row.coordinator_id === coordinator.id)) {
                    groups.set(String(coordinator.id), {
                        key: String(coordinator.id), label: coordinator.full_name, area: coordinator.assigned_area,
                        assignedAreaId: coordinator.assigned_area_id, href: '/admin/staff/' + coordinator.id, count: 0, rows: []
                    });
                }
            }
        }
        if (mode === 'department') {
            for (const area of areas.filter(area => !areaId || area.id === areaId)) {
                const key = String(area.id);
                groups.set(key, { key, label: area.name, count: 0, rows: [] });
            }
        }
        for (const row of rows) {
            if (mode === 'coordinator' && !row.worker_count) continue;
            const key = mode === 'coordinator' ? String(row.coordinator_id ?? 'unassigned') : String(row.area_id);
            if (!groups.has(key)) groups.set(key, { key, label: 'Unassigned Coordinator', count: 0, rows: [] });
            const group = groups.get(key);
            group.count += Number(row.worker_count);
            group.rows.push(row);
        }
        const workforce = [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
        const selectedGroup = pendingCategory ? null : groups.get(req.query.group);
        const warehouseGroups = new Map();
        if (selectedGroup) {
            for (const row of selectedGroup.rows) {
                const key = String(row.area_id);
                if (!warehouseGroups.has(key)) warehouseGroups.set(key, { key, label: row.area_name, count: 0, rows: [] });
                const warehouse = warehouseGroups.get(key);
                warehouse.count += Number(row.worker_count);
                warehouse.rows.push(row);
            }
            if (mode === 'department' && !warehouseGroups.size) {
                warehouseGroups.set(selectedGroup.key, { key: selectedGroup.key, label: selectedGroup.label, count: 0, rows: [] });
            }
            if (mode === 'coordinator' && selectedGroup.assignedAreaId && (!areaId || selectedGroup.assignedAreaId === areaId)) {
                const key = String(selectedGroup.assignedAreaId);
                if (!warehouseGroups.has(key)) warehouseGroups.set(key, { key, label: selectedGroup.area, count: 0, rows: [] });
            }
        }
        const warehouses = [...warehouseGroups.values()];
        const selectedWarehouse = warehouses.length === 1 ? warehouses[0] : warehouseGroups.get(req.query.warehouse);
        const departmentGroups = new Map();
        if (mode === 'coordinator' && selectedWarehouse) {
            for (const row of rows) {
                if (String(row.area_id) !== selectedWarehouse.key || !row.department_id) continue;
                const key = String(row.department_id);
                departmentGroups.set(key, { key, label: row.department_name, count: 0 });
            }
        }
        for (const row of selectedWarehouse?.rows || []) {
            const key = String(row.department_id ?? 'unassigned');
            if (!departmentGroups.has(key)) departmentGroups.set(key, { key, label: row.department_name || 'No Department', count: 0 });
            departmentGroups.get(key).count += Number(row.worker_count);
        }
        const selectedDepartment = departmentGroups.get(req.query.department);
        let assignedWorkers = [];
        if (selectedDepartment) {
            const params = [Number(selectedWarehouse.key), selectedDepartment.key === 'unassigned' ? null : Number(selectedDepartment.key)];
            if (mode === 'coordinator') params.push(selectedGroup.key === 'unassigned' ? null : Number(selectedGroup.key));
            assignedWorkers = await db.prepare(`
                SELECT e.id, e.full_name, u.full_name AS coordinator_name
                FROM employees e
                LEFT JOIN departments d ON d.id = e.department_id AND d.area_id = e.area_id
                LEFT JOIN users u ON u.id = e.coordinator_id AND u.role = 'COORDINATOR'
                WHERE e.status = 'active' AND e.area_id = ? AND d.id <=> ?
                ${mode === 'coordinator' ? 'AND u.id <=> ?' : ''}
                ORDER BY e.full_name, e.id
            `).all(...params);
        }

        return res.render('dashboard/admin', {
            title: 'Admin Dashboard - TAASCOR',
            areas, areaId, mode, workforce,
            selectedGroup, warehouses, selectedWarehouse, departmentGroups: [...departmentGroups.values()], selectedDepartment, assignedWorkers,
            pendingCategories, pendingCounts, pendingCategory, pendingRecords,
            manpowerDashboard: !pendingCategory && !selectedGroup ? (manpowerDashboard || await getManpowerDashboard(db, areaId)) : null
        });
    }

    res.redirect('/login');
});

module.exports = router;
