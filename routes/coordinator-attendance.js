const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { logAction } = require('../services/audit');
const { notifyHR, createNotification } = require('../services/notification');
const { DateTime } = require('luxon');

// GET /coordinator-attendance (Coordinator's own log or HR/HEAD_HR view)
router.get('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const today = DateTime.now().setZone('Asia/Manila').toFormat('yyyy-MM-dd');

    // HEAD_HR always goes straight to monitor view
    if (user.role === 'HEAD_HR') {
        const filterDate = req.query.date || today;
        if (typeof filterDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(filterDate) || !DateTime.fromISO(filterDate).isValid) {
            return res.status(400).render('error', { title: 'Invalid date', message: 'Choose a valid attendance date.', code: 400 });
        }

        // Active coordinators and their attendance for filterDate
        const records = (await db.prepare(`
            SELECT 
                u.id AS coordinator_id,
                u.full_name,
                u.email AS user_email,
                u.phone AS user_phone,
                u.status AS user_status,
                a.id AS area_id,
                COALESCE(a.name, 'Unassigned Warehouse') AS area_name,
                ca.id AS attendance_id,
                ca.work_date,
                ca.time_in,
                ca.time_out,
                ca.time_in_server,
                ca.time_out_server,
                ca.time_in_photo,
                ca.time_out_photo,
                ca.time_in_lat,
                ca.time_in_lng,
                ca.time_in_accuracy,
                ca.time_in_location,
                ca.time_out_lat,
                ca.time_out_lng,
                ca.time_out_accuracy,
                ca.time_out_location,
                ca.correction_requested,
                ca.correction_reason,
                ca.correction_approved_by,
                ca.correction_note,
                approver.full_name AS approved_by_name
            FROM users u
            LEFT JOIN coordinator_area_assignments caa ON caa.user_id = u.id AND caa.is_current = 1
            LEFT JOIN areas a ON caa.area_id = a.id
            LEFT JOIN coordinator_attendance ca ON ca.user_id = u.id AND ca.work_date = ?
            LEFT JOIN users approver ON ca.correction_approved_by = approver.id
            WHERE u.role = 'COORDINATOR' AND u.status = 'active'
            ORDER BY u.full_name ASC
        `).all(filterDate));

        // Date range: last 60 days for history table
        const history = (await db.prepare(`
            SELECT 
                ca.id AS attendance_id,
                ca.user_id AS coordinator_id,
                ca.work_date,
                ca.time_in,
                ca.time_out,
                ca.time_in_server,
                ca.time_out_server,
                ca.time_in_photo,
                ca.time_out_photo,
                ca.time_in_lat,
                ca.time_in_lng,
                ca.time_in_accuracy,
                ca.time_in_location,
                ca.time_out_lat,
                ca.time_out_lng,
                ca.time_out_accuracy,
                ca.time_out_location,
                ca.correction_requested,
                ca.correction_reason,
                ca.correction_approved_by,
                ca.correction_note,
                u.full_name,
                u.email AS user_email,
                COALESCE(a.name, 'Unassigned Warehouse') AS area_name,
                approver.full_name AS approved_by_name
            FROM coordinator_attendance ca
            JOIN users u ON ca.user_id = u.id
            LEFT JOIN coordinator_area_assignments caa ON caa.user_id = u.id AND caa.is_current = 1
            LEFT JOIN areas a ON caa.area_id = a.id
            LEFT JOIN users approver ON ca.correction_approved_by = approver.id
            WHERE u.role = 'COORDINATOR'
            ORDER BY ca.work_date DESC, ca.time_in DESC, u.full_name ASC
            LIMIT 100
        `).all());

        // Pending corrections from coordinators
        const pendingCorrections = (await db.prepare(`
            SELECT 
                ca.id AS attendance_id,
                ca.user_id AS coordinator_id,
                ca.work_date,
                ca.time_in,
                ca.time_out,
                ca.correction_reason,
                u.full_name,
                u.email AS user_email,
                COALESCE(a.name, 'Unassigned Warehouse') AS area_name
            FROM coordinator_attendance ca
            JOIN users u ON ca.user_id = u.id
            LEFT JOIN coordinator_area_assignments caa ON caa.user_id = u.id AND caa.is_current = 1
            LEFT JOIN areas a ON caa.area_id = a.id
            WHERE u.role = 'COORDINATOR' AND ca.correction_requested = 1 AND ca.correction_approved_by IS NULL
            ORDER BY ca.work_date DESC
        `).all());

        const totalCoordinators = records.length;
        const timedInCount = records.filter(r => r.time_in).length;
        const timedOutCount = records.filter(r => r.time_out).length;
        const onDutyCount = records.filter(r => r.time_in && !r.time_out).length;
        const notInCount = records.filter(r => !r.time_in).length;

        return res.render('attendance/head-hr-monitor', {
            title: 'Coordinator Attendance Monitor - TAASCOR',
            records,
            history,
            pendingCorrections,
            filterDate,
            today,
            stats: {
                total: totalCoordinators,
                timedIn: timedInCount,
                timedOut: timedOutCount,
                onDuty: onDutyCount,
                notIn: notInCount
            }
        });
    }

    if (user.role === 'COORDINATOR' || (user.role === 'HR' && req.query.view !== 'monitor')) {
        const history = (await db.prepare(`
            SELECT id, work_date, time_in, time_out, time_in_photo, time_out_photo,
                   time_in_lat, time_in_lng, time_in_accuracy, time_in_location,
                   time_out_lat, time_out_lng, time_out_accuracy, time_out_location,
                   correction_requested, correction_reason, correction_approved_by, correction_note
            FROM coordinator_attendance 
            WHERE user_id = ? 
            ORDER BY work_date DESC 
            LIMIT 30
        `).all(user.id));

        const todayRecord = (await db.prepare(`
            SELECT id, work_date, time_in, time_out, time_in_photo, time_out_photo,
                   time_in_lat, time_in_lng, time_in_accuracy, time_in_location,
                   time_out_lat, time_out_lng, time_out_accuracy, time_out_location,
                   correction_requested, correction_approved_by, correction_note
            FROM coordinator_attendance 
            WHERE user_id = ? AND work_date = ?
        `).get(user.id, today));

        return res.render('attendance/coordinator', {
            title: 'My Attendance - TAASCOR',
            history,
            todayRecord,
            today,
            isCoordinator: true
        });
    }

    // HR and ADMIN monitoring view
    const filterDate = req.query.date || today;
    if (typeof filterDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(filterDate) || !DateTime.fromISO(filterDate).isValid) return res.status(400).render('error',{title:'Invalid date',message:'Choose a valid attendance date.',code:400});
    const records = (await db.prepare(`
        SELECT ca.*, u.full_name, a.name as area_name, approver.full_name as approved_by_name
        FROM users u
        LEFT JOIN coordinator_area_assignments caa ON caa.user_id = u.id AND caa.is_current = 1
        LEFT JOIN areas a ON caa.area_id = a.id
        LEFT JOIN coordinator_attendance ca ON ca.user_id = u.id AND ca.work_date = ?
        LEFT JOIN users approver ON ca.correction_approved_by = approver.id
        WHERE u.role IN ('COORDINATOR', 'HR') AND u.status = 'active'
        ORDER BY u.full_name ASC
    `).all(filterDate));

    // Pending correction requests
    const pendingCorrections = (await db.prepare(`
        SELECT ca.*, u.full_name, a.name as area_name
        FROM coordinator_attendance ca
        JOIN users u ON ca.user_id = u.id
        LEFT JOIN coordinator_area_assignments caa ON caa.user_id = u.id AND caa.is_current = 1
        LEFT JOIN areas a ON caa.area_id = a.id
        WHERE ca.correction_requested = 1 AND ca.correction_approved_by IS NULL
        ORDER BY ca.work_date DESC
    `).all());

    res.render('attendance/coordinator', {
        title: 'Staff Attendance Monitoring - TAASCOR',
        records,
        pendingCorrections,
        filterDate,
        isCoordinator: false
    });
});

// GET /coordinator-attendance/breakdown/:id?
router.get('/breakdown/:id?', requireAuth, async (req, res) => {
    const user = req.session.user;
    const coordinatorId = req.params.id ? parseInt(req.params.id, 10) : (user.role === 'COORDINATOR' ? user.id : null);

    const { getCoordinatorTimekeeping } = require('../services/coordinator-timekeeping');

    const dateFrom = req.query.date_from || '2026-09-16';
    const dateTo = req.query.date_to || '2026-09-30';

    try {
        const breakdownData = await getCoordinatorTimekeeping(coordinatorId, dateFrom, dateTo);

        res.render('attendance/coordinator-breakdown', {
            title: `Timekeeping Breakdown - ${breakdownData.coordinator.name} - TAASCOR`,
            ...breakdownData,
            dateFrom,
            dateTo
        });
    } catch (err) {
        console.error('Error generating coordinator breakdown:', err);
        req.flash('error', 'Unable to load coordinator timekeeping breakdown.');
        res.redirect('/coordinator-attendance');
    }
});

// GET /coordinator-attendance/breakdown/:id/export
router.get('/breakdown/:id/export', requireAuth, async (req, res) => {
    const coordinatorId = parseInt(req.params.id, 10);
    const dateFrom = req.query.date_from || '2026-09-16';
    const dateTo = req.query.date_to || '2026-09-30';

    const { getCoordinatorTimekeeping, generateExcelWorkbook } = require('../services/coordinator-timekeeping');

    try {
        const breakdownData = await getCoordinatorTimekeeping(coordinatorId, dateFrom, dateTo);
        const workbook = await generateExcelWorkbook(breakdownData);

        const safeName = breakdownData.coordinator.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `COOR_TIMEKEEPING_${safeName}_${dateFrom}_${dateTo}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('Error exporting breakdown to Excel:', err);
        req.flash('error', 'Unable to export Excel file.');
        res.redirect(`/coordinator-attendance/breakdown/${coordinatorId}`);
    }
});

// GET /coordinator-attendance/time-in — catch stale browser navigation
router.get('/time-in', (req, res) => res.redirect('/coordinator-attendance'));
router.get('/time-out', (req, res) => res.redirect('/coordinator-attendance'));
router.get('/request-correction', (req, res) => res.redirect('/coordinator-attendance'));
router.get('/approve-correction', (req, res) => res.redirect('/coordinator-attendance'));

// POST /coordinator-attendance/time-in (Server timestamp + webcam photo)
router.post('/time-in', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (!['COORDINATOR', 'HR'].includes(user.role)) {
        req.flash('error', 'Only HR and coordinators can record their own time-in.');
        return res.redirect('/coordinator-attendance');
    }

    const db = getDb();
    const manilaNow = DateTime.now().setZone('Asia/Manila');
    const workDate = manilaNow.toFormat('yyyy-MM-dd');
    const timeFormatted = manilaNow.toFormat('HH:mm');
    const serverTimestamp = DateTime.now().toUTC().toISO();

    const fallbackRedirect = req.body.return_to || (req.get('Referrer') && req.get('Referrer').includes('/dashboard') ? '/dashboard' : '/coordinator-attendance');

    // Webcam photo (base64 data URI from camera, no file upload)
    let timeInPhoto = null;
    if (req.body.time_in_photo && typeof req.body.time_in_photo === 'string' && req.body.time_in_photo.startsWith('data:image/')) {
        if (req.body.time_in_photo.length > 4 * 1024 * 1024) { // 4MB limit
            req.flash('error', 'Photo too large. Please try again.');
            return res.redirect(fallbackRedirect);
        }
        timeInPhoto = req.body.time_in_photo;
    } else {
        req.flash('error', 'A webcam photo is required for Time-In. Please allow camera access and capture your photo.');
        return res.redirect(fallbackRedirect);
    }

    const existing = (await db.prepare('SELECT id, time_in FROM coordinator_attendance WHERE user_id = ? AND work_date = ?').get(user.id, workDate));

    if (existing) {
        req.flash('error', `You already recorded Time-In today at ${existing.time_in}. Free editing is not permitted.`);
        return res.redirect(fallbackRedirect);
    }

    // Extract GPS location & coordinates
    const lat = req.body.lat ? String(req.body.lat).slice(0, 32) : null;
    const lng = req.body.lng ? String(req.body.lng).slice(0, 32) : null;
    const accuracy = req.body.accuracy ? String(req.body.accuracy).slice(0, 32) : null;
    const locationAddress = req.body.location_address ? String(req.body.location_address).slice(0, 500) : null;

    (await db.prepare(`
        INSERT INTO coordinator_attendance (
            user_id, work_date, time_in, time_in_server, time_in_photo,
            time_in_lat, time_in_lng, time_in_accuracy, time_in_location
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, workDate, timeFormatted, serverTimestamp, timeInPhoto, lat, lng, accuracy, locationAddress));

    (await logAction(user.id, user.role + '_TIME_IN', 'coordinator_attendance', null, { workDate, timeFormatted }));

    req.flash('success', `Time-In recorded at ${timeFormatted}. Have a productive shift!`);
    res.redirect(fallbackRedirect);
});

// POST /coordinator-attendance/time-out (Server timestamp + webcam photo)
router.post('/time-out', requireAuth, async (req, res) => {
    const user = req.session.user;
    const fallbackRedirect = req.body.return_to || (req.get('Referrer') && req.get('Referrer').includes('/dashboard') ? '/dashboard' : '/coordinator-attendance');
    if (!['COORDINATOR', 'HR'].includes(user.role)) {
        return res.redirect(fallbackRedirect);
    }

    const db = getDb();
    const manilaNow = DateTime.now().setZone('Asia/Manila');
    const workDate = manilaNow.toFormat('yyyy-MM-dd');
    const timeFormatted = manilaNow.toFormat('HH:mm');
    const serverTimestamp = DateTime.now().toUTC().toISO();

    // Webcam photo (base64 data URI from camera, no file upload)
    let timeOutPhoto = null;
    if (req.body.time_out_photo && typeof req.body.time_out_photo === 'string' && req.body.time_out_photo.startsWith('data:image/')) {
        if (req.body.time_out_photo.length > 4 * 1024 * 1024) {
            req.flash('error', 'Photo too large. Please try again.');
            return res.redirect(fallbackRedirect);
        }
        timeOutPhoto = req.body.time_out_photo;
    } else {
        req.flash('error', 'A webcam photo is required for Time-Out. Please allow camera access and capture your photo.');
        return res.redirect(fallbackRedirect);
    }

    const existing = (await db.prepare('SELECT id, time_out FROM coordinator_attendance WHERE user_id = ? AND work_date = ?').get(user.id, workDate));

    if (!existing) {
        req.flash('error', 'You have not recorded Time-In for today yet.');
        return res.redirect(fallbackRedirect);
    }

    if (existing.time_out) {
        req.flash('error', `You already recorded Time-Out today at ${existing.time_out}.`);
        return res.redirect(fallbackRedirect);
    }

    // Extract GPS location & coordinates
    const lat = req.body.lat ? String(req.body.lat).slice(0, 32) : null;
    const lng = req.body.lng ? String(req.body.lng).slice(0, 32) : null;
    const accuracy = req.body.accuracy ? String(req.body.accuracy).slice(0, 32) : null;
    const locationAddress = req.body.location_address ? String(req.body.location_address).slice(0, 500) : null;

    (await db.prepare(`
        UPDATE coordinator_attendance 
        SET time_out = ?, time_out_server = ?, time_out_photo = ?,
            time_out_lat = ?, time_out_lng = ?, time_out_accuracy = ?, time_out_location = ?
        WHERE id = ?
    `).run(timeFormatted, serverTimestamp, timeOutPhoto, lat, lng, accuracy, locationAddress, existing.id));

    (await logAction(user.id, user.role + '_TIME_OUT', 'coordinator_attendance', existing.id, { workDate, timeFormatted }));

    req.flash('success', `Time-Out recorded at ${timeFormatted}. Shift completed.`);
    res.redirect(fallbackRedirect);
});

// POST /coordinator-attendance/request-correction (Coordinator requests correction)
router.post('/request-correction', requireAuth, async (req, res) => {
    const user = req.session.user;
    const { attendance_id, correction_reason } = req.body;
    const db = getDb();

    if (!attendance_id || !correction_reason) {
        req.flash('error', 'Please provide a reason for the correction request.');
        return res.redirect('/coordinator-attendance');
    }

    const row = (await db.prepare('SELECT * FROM coordinator_attendance WHERE id = ? AND user_id = ?').get(parseInt(attendance_id), user.id));
    if (!row) {
        req.flash('error', 'Attendance record not found.');
        return res.redirect('/coordinator-attendance');
    }

    (await db.prepare(`
        UPDATE coordinator_attendance 
        SET correction_requested = 1, correction_reason = ? 
        WHERE id = ?
    `).run(correction_reason.trim(), row.id));

    (await notifyHR(
        'Attendance Correction Request',
        `Coordinator ${user.full_name} requested attendance correction for ${row.work_date}: "${correction_reason.trim()}"`,
        '/coordinator-attendance',
        `att-corr-${row.id}`
    ));

    (await logAction(user.id, 'REQUEST_ATTENDANCE_CORRECTION', 'coordinator_attendance', row.id, { reason: correction_reason }));

    req.flash('success', 'Correction request submitted to HR for review.');
    res.redirect('/coordinator-attendance');
});

// POST /coordinator-attendance/approve-correction (HR, HEAD_HR, ADMIN)
router.post('/approve-correction', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'HR' && user.role !== 'ADMIN' && user.role !== 'HEAD_HR') {
        return res.status(403).render('error', { title: 'Access Denied', message: 'Only HR can approve attendance corrections.', code: 403 });
    }

    const { attendance_id, new_time_in, new_time_out, hr_notes } = req.body;
    const db = getDb();

    const row = (await db.prepare('SELECT * FROM coordinator_attendance WHERE id = ?').get(parseInt(attendance_id)));
    if (row && user.role !== 'ADMIN') {
        const owner = await db.prepare('SELECT role FROM users WHERE id = ?').get(row.user_id);
        if (owner.role !== 'COORDINATOR') return res.status(403).render('error', {title: 'Access Denied', message: 'Only the administrator can approve HR attendance corrections.', code: 403});
    }
    if (!row) {
        req.flash('error', 'Attendance record not found.');
        return res.redirect('/coordinator-attendance');
    }

    (await db.prepare(`
        UPDATE coordinator_attendance 
        SET time_in = COALESCE(?, time_in),
            time_out = COALESCE(?, time_out),
            correction_requested = 0,
            correction_approved_by = ?,
            correction_approved_at = UTC_TIMESTAMP(),
            correction_note = ?
        WHERE id = ?
    `).run(
        new_time_in || null,
        new_time_out || null,
        user.id,
        hr_notes ? hr_notes.trim() : 'Approved by HR',
        row.id
    ));

    (await createNotification(
        row.user_id,
        'Attendance Correction Approved',
        `HR approved your attendance correction for date ${row.work_date}.`,
        '/coordinator-attendance',
        `att-corr-approved-${row.id}`
    ));

    (await logAction(user.id, 'APPROVE_ATTENDANCE_CORRECTION', 'coordinator_attendance', row.id, {
        original_in: row.time_in,
        original_out: row.time_out,
        new_time_in,
        new_time_out,
        hr_notes
    }));

    req.flash('success', 'Attendance correction applied and logged.');
    res.redirect('/coordinator-attendance');
});

module.exports = router;
