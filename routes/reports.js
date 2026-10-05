const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { requireAuth } = require('../middleware/auth');
const { validateAreaAccess, requireArea } = require('../middleware/area-guard');
const { getDb } = require('../db/database');
const { DateTime } = require('luxon');

// GET /reports  —  Full Coordinator Forum Report (replaces old simple attendance view)
router.get('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db   = getDb();
    const today        = DateTime.now().setZone('Asia/Manila').toFormat('yyyy-MM-dd');
    const startOfMonth = DateTime.now().setZone('Asia/Manila').startOf('month').toFormat('yyyy-MM-dd');

    const dateFrom = req.query.date_from || startOfMonth;
    const dateTo   = req.query.date_to   || today;

    const selectedAreaId = user.role === 'COORDINATOR'
        ? (req.userAreaId || null)
        : (req.query.area_id ? parseInt(req.query.area_id) : null);

    const areaFilter = selectedAreaId ? 'AND e.area_id = ?' : '';
    const areaParams = selectedAreaId ? [selectedAreaId] : [];
    const mpFilter   = selectedAreaId ? 'AND mr.area_id = ?' : '';
    const btwFilter  = selectedAreaId ? 'AND e.area_id = ?' : '';
    const incFilter  = selectedAreaId ? 'AND ir.area_id = ?' : '';

    const areas = user.role !== 'COORDINATOR'
        ? (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all())
        : [];

    const areaRow  = selectedAreaId ? (await db.prepare('SELECT name FROM areas WHERE id = ?').get(selectedAreaId)) : null;
    const areaName = areaRow ? areaRow.name : null;

    // Attendance summary per employee for the period
    const attendanceSummary = await db.prepare(`
        SELECT e.id, e.employee_id as emp_code, e.full_name, p.title as position_title, a.name as area_name,
               SUM(CASE WHEN ea.status = 'present'  THEN 1 ELSE 0 END) as present,
               SUM(CASE WHEN ea.status = 'late'     THEN 1 ELSE 0 END) as late,
               SUM(CASE WHEN ea.status = 'absent'   THEN 1 ELSE 0 END) as absent,
               SUM(CASE WHEN ea.status = 'rest_day' THEN 1 ELSE 0 END) as rest_day
        FROM employees e
        JOIN areas a ON a.id = e.area_id
        LEFT JOIN positions p ON p.id = e.position_id
        LEFT JOIN employee_attendance ea ON ea.employee_id = e.id
            AND ea.work_date >= ? AND ea.work_date <= ?
        WHERE e.status = 'active' ${areaFilter}
        GROUP BY e.id, e.employee_id, e.full_name, p.title, a.name
        ORDER BY a.name, e.full_name
    `).all(dateFrom, dateTo, ...areaParams);

    // Today's attendance detail
    const todayAttendance = await db.prepare(`
        SELECT ea.*, e.employee_id as emp_code, e.full_name as employee_name,
               p.title as position_title
        FROM employee_attendance ea
        JOIN employees e ON ea.employee_id = e.id
        LEFT JOIN positions p ON p.id = e.position_id
        WHERE ea.work_date = ? ${areaFilter}
        ORDER BY e.full_name ASC
    `).all(today, ...areaParams);

    // Manpower requests
    const manpowerRequests = await db.prepare(`
        SELECT mr.*, a.name as area_name, u.full_name as requester_name,
               COALESCE((SELECT SUM(quantity_requested) FROM manpower_request_positions WHERE request_id = mr.id),0) as total_requested,
               COALESCE((SELECT COUNT(*) FROM manpower_allocations WHERE request_id = mr.id AND status = 'confirmed'),0) as confirmed_count
        FROM manpower_requests mr
        JOIN areas a ON a.id = mr.area_id
        LEFT JOIN users u ON u.id = mr.requested_by
        WHERE mr.deployment_date >= ? AND mr.deployment_date <= ? ${mpFilter}
        ORDER BY mr.deployment_date DESC, mr.id DESC
    `).all(dateFrom, dateTo, ...(selectedAreaId ? [selectedAreaId] : []));

    // Position breakdown
    const positionBreakdown = await db.prepare(`
        SELECT p.title as position_title,
               SUM(mrp.quantity_requested) as qty_requested,
               COALESCE(SUM(conf.cnt), 0) as qty_confirmed
        FROM manpower_request_positions mrp
        JOIN positions p ON p.id = mrp.position_id
        JOIN manpower_requests mr ON mr.id = mrp.request_id
        LEFT JOIN (
            SELECT request_position_id, COUNT(*) as cnt
            FROM manpower_allocations WHERE status = 'confirmed'
            GROUP BY request_position_id
        ) conf ON conf.request_position_id = mrp.id
        WHERE mr.deployment_date >= ? AND mr.deployment_date <= ? ${mpFilter}
        GROUP BY p.title
        ORDER BY qty_requested DESC
    `).all(dateFrom, dateTo, ...(selectedAreaId ? [selectedAreaId] : []));

    // BTW cases
    const btwCases = await db.prepare(`
        SELECT bc.*, e.full_name as employee_name, a.name as area_name
        FROM btw_cases bc
        JOIN employees e ON e.id = bc.employee_id
        JOIN areas a ON a.id = e.area_id
        WHERE bc.created_at >= ? ${btwFilter}
        ORDER BY bc.created_at DESC LIMIT 60
    `).all(dateFrom, ...(selectedAreaId ? [selectedAreaId] : []));

    // Incident reports
    const incidents = await db.prepare(`
        SELECT ir.*, u.full_name as reporter_name, a.name as area_name
        FROM incident_reports ir
        LEFT JOIN users u ON u.id = ir.reported_by
        LEFT JOIN areas a ON a.id = ir.area_id
        WHERE ir.created_at >= ? ${incFilter}
        ORDER BY ir.created_at DESC LIMIT 60
    `).all(dateFrom, ...(selectedAreaId ? [selectedAreaId] : []));

    // Active employee masterfile
    const employees = await db.prepare(`
        SELECT e.*, p.title as position_title, a.name as area_name
        FROM employees e
        JOIN areas a ON a.id = e.area_id
        LEFT JOIN positions p ON p.id = e.position_id
        WHERE e.status = 'active' ${areaFilter}
        ORDER BY a.name, e.full_name
    `).all(...areaParams);

    // Coordinator own attendance log
    let coordinatorAttendance = [];
    if (user.role === 'COORDINATOR') {
        coordinatorAttendance = await db.prepare(`
            SELECT * FROM coordinator_attendance
            WHERE user_id = ? AND work_date >= ? AND work_date <= ?
            ORDER BY work_date DESC
        `).all(user.id, dateFrom, dateTo);
    }

    // KPIs
    const kpi = {
        totalEmployees:    employees.length,
        presentToday:      todayAttendance.filter(r => r.status === 'present').length,
        absentToday:       todayAttendance.filter(r => r.status === 'absent').length,
        lateToday:         todayAttendance.filter(r => r.status === 'late').length,
        scheduledToday:    todayAttendance.length,
        latePeriod:        attendanceSummary.reduce((s, e) => s + (e.late || 0), 0),
        manpowerTotal:     manpowerRequests.length,
        manpowerPending:   manpowerRequests.filter(r => !['filled','declined','cancelled'].includes(r.status)).length,
        workersRequested:  manpowerRequests.reduce((s, r) => s + (r.total_requested || 0), 0),
        workersConfirmed:  manpowerRequests.reduce((s, r) => s + (r.confirmed_count || 0), 0),
        openIncidents:     incidents.filter(i => ['open','investigating'].includes(i.status)).length,
        resolvedIncidents: incidents.filter(i => ['resolved','closed'].includes(i.status)).length,
        btwTotal:          btwCases.length,
        btwPending:        btwCases.filter(b => b.status === 'pending').length,
    };

    res.render('reports/coordinator', {
        title: 'Reports - TAASCOR',
        dateFrom, dateTo, today, todayDate: today,
        selectedAreaId, areaName, areas,
        attendanceSummary,
        todayAttendance,
        manpowerRequests,
        positionBreakdown,
        btwCases,
        incidents,
        employees,
        coordinatorAttendance,
        kpi,
    });
});


// GET /reports/export (CSV or Excel)
router.get('/export', requireAuth, requireArea, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const format = req.query.format === 'csv' ? 'csv' : 'xlsx';

    const dateFrom = req.query.date_from || DateTime.now().setZone('Asia/Manila').startOf('month').toFormat('yyyy-MM-dd');
    const dateTo = req.query.date_to || DateTime.now().setZone('Asia/Manila').toFormat('yyyy-MM-dd');
    const selectedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : (req.query.area_id ? parseInt(req.query.area_id) : null);
    const selectedStatus = req.query.status || '';

    let where = ['ea.work_date >= ?', 'ea.work_date <= ?'];
    let params = [dateFrom, dateTo];

    if (selectedAreaId) {
        where.push('e.area_id = ?');
        params.push(selectedAreaId);
    }

    if (selectedStatus) {
        where.push('ea.status = ?');
        params.push(selectedStatus);
    }

    const records = (await db.prepare(`
        SELECT ea.work_date, e.employee_id, e.full_name, a.name as area_name,
               p.title as position_title, ea.status, ea.time_in, ea.time_out,
               ea.remarks, u.full_name as recorded_by_name
        FROM employee_attendance ea
        JOIN employees e ON ea.employee_id = e.id
        JOIN areas a ON e.area_id = a.id
        LEFT JOIN positions p ON e.position_id = p.id
        LEFT JOIN users u ON ea.recorded_by = u.id
        WHERE ${where.join(' AND ')}
        ORDER BY ea.work_date DESC, e.full_name ASC
    `).all(...params));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TAASCOR Attendance System';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Attendance Report');

    worksheet.columns = [
        { header: 'Work Date', key: 'work_date', width: 14 },
        { header: 'Employee ID', key: 'employee_id', width: 16 },
        { header: 'Employee Name', key: 'full_name', width: 25 },
        { header: 'Area / Warehouse', key: 'area_name', width: 22 },
        { header: 'Position', key: 'position_title', width: 20 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Time In', key: 'time_in', width: 12 },
        { header: 'Time Out', key: 'time_out', width: 12 },
        { header: 'Remarks', key: 'remarks', width: 25 },
        { header: 'Recorded By', key: 'recorded_by_name', width: 20 }
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1B2A4A' } // Navy primary
    };

    records.forEach(r => {
        worksheet.addRow({
            work_date: r.work_date,
            employee_id: r.employee_id,
            full_name: r.full_name,
            area_name: r.area_name,
            position_title: r.position_title || '—',
            status: r.status.toUpperCase(),
            time_in: r.time_in || '—',
            time_out: r.time_out || '—',
            remarks: r.remarks || '—',
            recorded_by_name: r.recorded_by_name || 'System'
        });
    });

    const filename = `TAASCOR_Attendance_${dateFrom}_to_${dateTo}`;

    if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
        await workbook.csv.write(res);
    } else {
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
        await workbook.xlsx.write(res);
    }
    res.end();
});

// ================================================================
// GET /reports/coordinator  — Coordinator Forum Summary Report
// ================================================================
router.get('/coordinator', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db   = getDb();
    const today       = DateTime.now().setZone('Asia/Manila').toFormat('yyyy-MM-dd');
    const startOfMonth = DateTime.now().setZone('Asia/Manila').startOf('month').toFormat('yyyy-MM-dd');

    const dateFrom = req.query.date_from || startOfMonth;
    const dateTo   = req.query.date_to   || today;

    // Coordinators see their own area only
    const selectedAreaId = user.role === 'COORDINATOR'
        ? (req.userAreaId || null)
        : (req.query.area_id ? parseInt(req.query.area_id) : null);

    const areaFilter       = selectedAreaId ? 'AND e.area_id = ?' : '';
    const areaFilterNoAlias = selectedAreaId ? 'AND area_id = ?'   : '';
    const areaParams       = selectedAreaId ? [selectedAreaId]      : [];

    const areas = user.role !== 'COORDINATOR'
        ? (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all())
        : [];

    const areaRow = selectedAreaId
        ? (await db.prepare('SELECT name FROM areas WHERE id = ?').get(selectedAreaId))
        : null;
    const areaName = areaRow ? areaRow.name : null;

    // ── Attendance summary per employee ──────────────────────────
    const attRows = await db.prepare(`
        SELECT e.id, e.employee_id as emp_code, e.full_name, p.title as position_title, a.name as area_name,
               SUM(CASE WHEN ea.status = 'present'  THEN 1 ELSE 0 END) as present,
               SUM(CASE WHEN ea.status = 'late'     THEN 1 ELSE 0 END) as late,
               SUM(CASE WHEN ea.status = 'absent'   THEN 1 ELSE 0 END) as absent,
               SUM(CASE WHEN ea.status = 'rest_day' THEN 1 ELSE 0 END) as rest_day
        FROM employees e
        JOIN areas a ON a.id = e.area_id
        LEFT JOIN positions p ON p.id = e.position_id
        LEFT JOIN employee_attendance ea ON ea.employee_id = e.id
            AND ea.work_date >= ? AND ea.work_date <= ?
        WHERE e.status = 'active' ${areaFilter}
        GROUP BY e.id, e.employee_id, e.full_name, p.title, a.name
        ORDER BY a.name, e.full_name
    `).all(dateFrom, dateTo, ...areaParams);

    // ── Today's attendance detail ─────────────────────────────────
    const todayAttendance = await db.prepare(`
        SELECT ea.*, e.employee_id as emp_code, e.full_name as employee_name,
               p.title as position_title
        FROM employee_attendance ea
        JOIN employees e ON ea.employee_id = e.id
        LEFT JOIN positions p ON p.id = e.position_id
        WHERE ea.work_date = ? ${areaFilter.replace(/e\.area_id/, 'e.area_id')}
        ORDER BY e.full_name ASC
    `).all(today, ...areaParams);

    // ── Manpower requests ─────────────────────────────────────────
    const mpFilter = selectedAreaId ? 'AND mr.area_id = ?' : '';
    const manpowerRequests = await db.prepare(`
        SELECT mr.*, a.name as area_name, u.full_name as requester_name,
               COALESCE((SELECT SUM(quantity_requested) FROM manpower_request_positions WHERE request_id = mr.id),0) as total_requested,
               COALESCE((SELECT COUNT(*) FROM manpower_allocations WHERE request_id = mr.id AND status = 'confirmed'),0) as confirmed_count
        FROM manpower_requests mr
        JOIN areas a ON a.id = mr.area_id
        LEFT JOIN users u ON u.id = mr.requested_by
        WHERE mr.deployment_date >= ? AND mr.deployment_date <= ? ${mpFilter}
        ORDER BY mr.deployment_date DESC, mr.id DESC
    `).all(dateFrom, dateTo, ...(selectedAreaId ? [selectedAreaId] : []));

    // ── Position breakdown aggregated ─────────────────────────────
    const positionBreakdown = await db.prepare(`
        SELECT p.title as position_title,
               SUM(mrp.quantity_requested) as qty_requested,
               COALESCE(SUM(conf.cnt),0) as qty_confirmed
        FROM manpower_request_positions mrp
        JOIN positions p ON p.id = mrp.position_id
        JOIN manpower_requests mr ON mr.id = mrp.request_id
        LEFT JOIN (
            SELECT request_position_id, COUNT(*) as cnt
            FROM manpower_allocations
            WHERE status = 'confirmed'
            GROUP BY request_position_id
        ) conf ON conf.request_position_id = mrp.id
        WHERE mr.deployment_date >= ? AND mr.deployment_date <= ? ${mpFilter}
        GROUP BY p.title
        ORDER BY qty_requested DESC
    `).all(dateFrom, dateTo, ...(selectedAreaId ? [selectedAreaId] : []));

    // ── BTW cases ─────────────────────────────────────────────────
    const btwFilter = selectedAreaId ? 'AND e.area_id = ?' : '';
    const btwCases = await db.prepare(`
        SELECT bc.*, e.full_name as employee_name, a.name as area_name
        FROM btw_cases bc
        JOIN employees e ON e.id = bc.employee_id
        JOIN areas a ON a.id = e.area_id
        WHERE bc.created_at >= ? ${btwFilter}
        ORDER BY bc.created_at DESC
        LIMIT 50
    `).all(dateFrom, ...(selectedAreaId ? [selectedAreaId] : []));

    // ── Incident reports ──────────────────────────────────────────
    const incFilter = selectedAreaId ? 'AND ir.area_id = ?' : '';
    const incidents = await db.prepare(`
        SELECT ir.*, u.full_name as reporter_name, a.name as area_name
        FROM incident_reports ir
        LEFT JOIN users u ON u.id = ir.reported_by
        LEFT JOIN areas a ON a.id = ir.area_id
        WHERE ir.created_at >= ? ${incFilter}
        ORDER BY ir.created_at DESC
        LIMIT 50
    `).all(dateFrom, ...(selectedAreaId ? [selectedAreaId] : []));

    // ── Active employees masterfile ───────────────────────────────
    const employees = await db.prepare(`
        SELECT e.*, p.title as position_title, a.name as area_name
        FROM employees e
        JOIN areas a ON a.id = e.area_id
        LEFT JOIN positions p ON p.id = e.position_id
        WHERE e.status = 'active' ${areaFilter}
        ORDER BY a.name, e.full_name
    `).all(...areaParams);

    // ── Coordinator own attendance ────────────────────────────────
    let coordinatorAttendance = [];
    if (user.role === 'COORDINATOR') {
        coordinatorAttendance = await db.prepare(`
            SELECT * FROM coordinator_attendance
            WHERE user_id = ? AND work_date >= ? AND work_date <= ?
            ORDER BY work_date DESC
        `).all(user.id, dateFrom, dateTo);
    }

    // ── KPIs ──────────────────────────────────────────────────────
    const todayPresentRows = todayAttendance.filter(r => ['present','late'].includes(r.status));
    const kpi = {
        totalEmployees:   employees.length,
        presentToday:     todayAttendance.filter(r => r.status === 'present').length,
        absentToday:      todayAttendance.filter(r => r.status === 'absent').length,
        lateToday:        todayAttendance.filter(r => r.status === 'late').length,
        scheduledToday:   todayAttendance.length,
        latePeriod:       attRows.reduce((s,e) => s + (e.late||0), 0),
        manpowerTotal:    manpowerRequests.length,
        manpowerPending:  manpowerRequests.filter(r => !['filled','declined','cancelled'].includes(r.status)).length,
        workersRequested: manpowerRequests.reduce((s,r) => s + (r.total_requested||0), 0),
        workersConfirmed: manpowerRequests.reduce((s,r) => s + (r.confirmed_count||0), 0),
        openIncidents:    incidents.filter(i => ['open','investigating'].includes(i.status)).length,
        resolvedIncidents:incidents.filter(i => ['resolved','closed'].includes(i.status)).length,
        btwTotal:         btwCases.length,
        btwPending:       btwCases.filter(b => b.status === 'pending').length,
    };

    res.render('reports/coordinator', {
        title: 'Coordinator Forum Report - TAASCOR',
        dateFrom, dateTo, today, todayDate: today,
        selectedAreaId, areaName, areas,
        attendanceSummary: attRows,
        todayAttendance,
        manpowerRequests,
        positionBreakdown,
        btwCases,
        incidents,
        employees,
        coordinatorAttendance,
        kpi,
    });
});

// ================================================================
// GET /reports/coordinator/export  — Excel Export
// ================================================================
router.get('/coordinator/export', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db   = getDb();
    const today        = DateTime.now().setZone('Asia/Manila').toFormat('yyyy-MM-dd');
    const startOfMonth = DateTime.now().setZone('Asia/Manila').startOf('month').toFormat('yyyy-MM-dd');
    const dateFrom = req.query.date_from || startOfMonth;
    const dateTo   = req.query.date_to   || today;
    const selectedAreaId = user.role === 'COORDINATOR'
        ? (req.userAreaId || null)
        : (req.query.area_id ? parseInt(req.query.area_id) : null);
    const areaFilter = selectedAreaId ? 'AND e.area_id = ?' : '';
    const areaParams = selectedAreaId ? [selectedAreaId] : [];
    const mpFilter   = selectedAreaId ? 'AND mr.area_id = ?' : '';

    const attRows = await db.prepare(`
        SELECT e.employee_id as emp_code, e.full_name, p.title as position_title, a.name as area_name,
               SUM(CASE WHEN ea.status='present' THEN 1 ELSE 0 END) as present,
               SUM(CASE WHEN ea.status='late' THEN 1 ELSE 0 END) as late,
               SUM(CASE WHEN ea.status='absent' THEN 1 ELSE 0 END) as absent,
               SUM(CASE WHEN ea.status='rest_day' THEN 1 ELSE 0 END) as rest_day
        FROM employees e JOIN areas a ON a.id=e.area_id LEFT JOIN positions p ON p.id=e.position_id
        LEFT JOIN employee_attendance ea ON ea.employee_id=e.id AND ea.work_date>=? AND ea.work_date<=?
        WHERE e.status='active' ${areaFilter}
        GROUP BY e.id, e.employee_id, e.full_name, p.title, a.name ORDER BY a.name, e.full_name
    `).all(dateFrom, dateTo, ...areaParams);

    const manpowerRequests = await db.prepare(`
        SELECT mr.id, a.name as area_name, mr.deployment_date, u.full_name as requester_name,
               mr.priority, mr.status, mr.reason,
               COALESCE((SELECT SUM(quantity_requested) FROM manpower_request_positions WHERE request_id=mr.id),0) as total_requested,
               COALESCE((SELECT COUNT(*) FROM manpower_allocations WHERE request_id=mr.id AND status='confirmed'),0) as confirmed_count
        FROM manpower_requests mr JOIN areas a ON a.id=mr.area_id LEFT JOIN users u ON u.id=mr.requested_by
        WHERE mr.deployment_date>=? AND mr.deployment_date<=? ${mpFilter}
        ORDER BY mr.deployment_date DESC
    `).all(dateFrom, dateTo, ...(selectedAreaId ? [selectedAreaId] : []));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TAASCOR ETS';

    // Sheet 1: Attendance Summary
    const ws1 = workbook.addWorksheet('Attendance Summary');
    ws1.columns = [
        {header:'Employee ID',key:'emp_code',width:18},
        {header:'Full Name',key:'full_name',width:28},
        {header:'Position',key:'position_title',width:22},
        {header:'Area',key:'area_name',width:20},
        {header:'Present',key:'present',width:12},
        {header:'Late',key:'late',width:10},
        {header:'Absent',key:'absent',width:10},
        {header:'Rest Day',key:'rest_day',width:12},
        {header:'Att. Rate %',key:'rate',width:14},
    ];
    ws1.getRow(1).font = {bold:true,color:{argb:'FFFFFFFF'}};
    ws1.getRow(1).fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1B2A4A'}};
    attRows.forEach(r => {
        const wd = r.present + r.late + r.absent;
        ws1.addRow({...r, rate: wd>0 ? Math.round(((r.present+r.late)/wd)*100)+'%' : 'N/A'});
    });

    // Sheet 2: Manpower Requests
    const ws2 = workbook.addWorksheet('Manpower Requests');
    ws2.columns = [
        {header:'Request #',key:'id',width:12},
        {header:'Area',key:'area_name',width:20},
        {header:'Term Deployment',key:'deployment_date',width:18},
        {header:'Submitted By',key:'requester_name',width:22},
        {header:'Priority',key:'priority',width:12},
        {header:'Status',key:'status',width:16},
        {header:'Workers Requested',key:'total_requested',width:20},
        {header:'Workers Deployed',key:'confirmed_count',width:20},
        {header:'Remaining',key:'remaining',width:14},
        {header:'Reason',key:'reason',width:30},
    ];
    ws2.getRow(1).font = {bold:true,color:{argb:'FFFFFFFF'}};
    ws2.getRow(1).fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF1B2A4A'}};
    manpowerRequests.forEach(r => {
        ws2.addRow({...r, remaining: Math.max(0,(r.total_requested||0)-(r.confirmed_count||0))});
    });

    const filename = `TAASCOR_CoordinatorReport_${dateFrom}_to_${dateTo}`;
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="${filename}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
});

module.exports = router;

