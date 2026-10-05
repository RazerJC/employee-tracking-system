const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { validateAreaAccess } = require('../middleware/area-guard');
const { getDb } = require('../db/database');
const { logAction } = require('../services/audit');
const { notifyHR, createNotification } = require('../services/notification');
const { DateTime } = require('luxon');

// GET /incidents (List incident reports)
router.get('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const statusFilter = req.query.status || '';
    const severityFilter = req.query.severity || '';
    const searchQuery = (req.query.q || '').trim();
    const selectedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : (req.query.area_id ? parseInt(req.query.area_id) : null);

    let where = [];
    let params = [];

    if (selectedAreaId) {
        where.push('i.area_id = ?');
        params.push(selectedAreaId);
    }

    if (statusFilter) {
        where.push('i.status = ?');
        params.push(statusFilter);
    }

    if (severityFilter) {
        where.push('i.severity = ?');
        params.push(severityFilter);
    }

    if (searchQuery) {
        where.push('(i.incident_ref LIKE ? OR i.title LIKE ? OR i.description LIKE ? OR e.full_name LIKE ?)');
        const term = `%${searchQuery}%`;
        params.push(term, term, term, term);
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const incidents = (await db.prepare(`
        SELECT i.*, a.name as area_name, u.full_name as reported_by_name,
               e.full_name as employee_name, e.employee_id as emp_code,
               hr.full_name as hr_reviewer_name,
               (SELECT COUNT(*) FROM incident_entries WHERE incident_id = i.id) as reply_count
        FROM incident_reports i
        JOIN areas a ON i.area_id = a.id
        LEFT JOIN users u ON i.reported_by = u.id
        LEFT JOIN employees e ON i.employee_id = e.id
        LEFT JOIN users hr ON i.hr_reviewer_id = hr.id
        ${whereClause}
        ORDER BY i.created_at DESC
    `).all(...params));

    // Calculate quick stats (overall or area-filtered)
    let statsWhere = [];
    let statsParams = [];
    if (selectedAreaId) {
        statsWhere.push('area_id = ?');
        statsParams.push(selectedAreaId);
    }
    const statsWhereClause = statsWhere.length > 0 ? 'WHERE ' + statsWhere.join(' AND ') : '';

    const statsRows = (await db.prepare(`
        SELECT status, severity, COUNT(*) as c
        FROM incident_reports
        ${statsWhereClause}
        GROUP BY status, severity
    `).all(...statsParams));

    const stats = {
        total: 0,
        active: 0,
        critical: 0,
        investigating: 0,
        resolved: 0
    };

    for (const r of statsRows) {
        const count = Number(r.c) || 0;
        stats.total += count;
        if (['reported', 'under_investigation', 'hr_action_taken'].includes(r.status)) {
            stats.active += count;
        }
        if (r.status === 'under_investigation') {
            stats.investigating += count;
        }
        if (['resolved', 'closed'].includes(r.status)) {
            stats.resolved += count;
        }
        if (['critical', 'major'].includes(r.severity) && r.status !== 'closed') {
            stats.critical += count;
        }
    }

    const areas = user.role !== 'COORDINATOR' ? (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all()) : [];

    res.render('incidents/list', {
        title: 'Incident Management - TAASCOR',
        incidents,
        statusFilter,
        severityFilter,
        searchQuery,
        selectedAreaId,
        areas,
        stats
    });
});

// GET /incidents/new (New incident report form)
router.get('/new', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();

    const selectedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : (req.query.area_id ? parseInt(req.query.area_id) : null);
    
    let empWhere = ["status = 'active'"];
    let empParams = [];
    if (selectedAreaId) {
        empWhere.push('area_id = ?');
        empParams.push(selectedAreaId);
    }

    const employees = (await db.prepare(`
        SELECT id, employee_id, full_name, area_id
        FROM employees
        WHERE ${empWhere.join(' AND ')}
        ORDER BY last_name ASC, first_name ASC
    `).all(...empParams));

    const areas = user.role === 'COORDINATOR'
        ? (req.userArea ? [req.userArea] : (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all()))
        : (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all());

    res.render('incidents/form', {
        title: 'Report Incident - TAASCOR',
        employees,
        areas,
        selectedAreaId
    });
});

// POST /incidents (Submit incident report)
router.post('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const { area_id, employee_id, incident_date, incident_time, category, severity, title, description, location_details, immediate_action_taken } = req.body;

    const assignedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : parseInt(area_id);

    if (!validateAreaAccess(assignedAreaId, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot submit incident reports for other areas.', code: 403 });
    }

    if (!title || !description || !incident_date || !category) {
        req.flash('error', 'Please provide the incident title, category, date, and description.');
        return res.redirect('/incidents/new');
    }

    // Generate Incident Ref: INC-YYYYMM-XXXX
    const manilaNow = DateTime.now().setZone('Asia/Manila');
    const ym = manilaNow.toFormat('yyyyMM');
    const countRow = (await db.prepare("SELECT COUNT(*) as c FROM incident_reports WHERE incident_ref LIKE ?").get(`INC-${ym}-%`));
    const nextSeq = String((countRow ? countRow.c : 0) + 1).padStart(4, '0');
    const incidentRef = `INC-${ym}-${nextSeq}`;

    const empId = employee_id ? parseInt(employee_id) : null;

    const result = (await db.prepare(`
        INSERT INTO incident_reports (
            incident_ref, area_id, reported_by, employee_id,
            incident_date, incident_time, category, severity,
            title, description, location_details, immediate_action_taken,
            status, created_at, updated_at
        ) VALUES (
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            'reported', datetime('now'), datetime('now')
        )
    `).run(
        incidentRef,
        assignedAreaId,
        user.id,
        empId,
        incident_date,
        incident_time ? incident_time.trim() : null,
        category,
        severity || 'minor',
        title.trim(),
        description.trim(),
        location_details ? location_details.trim() : null,
        immediate_action_taken ? immediate_action_taken.trim() : null
    ));

    const incidentId = result.lastInsertRowid;

    // Create initial entry in timeline
    (await db.prepare(`
        INSERT INTO incident_entries (incident_id, author_id, author_role, content, entry_type, created_at)
        VALUES (?, ?, ?, ?, 'system', datetime('now'))
    `).run(
        incidentId,
        user.id,
        user.role,
        `Incident reported by ${user.full_name} (${user.role}). Severity: ${severity.toUpperCase()}. Category: ${category}.`
    ));

    // Notify HR and Admin
    (await notifyHR(
        `🚨 Incident Reported: ${incidentRef}`,
        `[${severity.toUpperCase()}] ${title} at Warehouse area. Reported by ${user.full_name}.`,
        `/incidents/${incidentId}`,
        `inc-new-${incidentId}`
    ));

    // Audit log
    (await logAction(user.id, 'SUBMIT_INCIDENT_REPORT', 'incident_reports', incidentId, {
        incidentRef,
        severity,
        category,
        title
    }));

    req.flash('success', `Incident report ${incidentRef} has been filed. HR and Management have been alerted.`);
    res.redirect(`/incidents/${incidentId}`);
});

// GET /incidents/:id (Detail / Thread View)
router.get('/:id', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);

    const incident = (await db.prepare(`
        SELECT i.*, a.name as area_name, u.full_name as reported_by_name, u.email as reported_by_email,
               e.full_name as employee_name, e.employee_id as emp_code, e.status as emp_status,
               p.title as position_title,
               hr.full_name as hr_reviewer_name
        FROM incident_reports i
        JOIN areas a ON i.area_id = a.id
        LEFT JOIN users u ON i.reported_by = u.id
        LEFT JOIN employees e ON i.employee_id = e.id
        LEFT JOIN positions p ON e.position_id = p.id
        LEFT JOIN users hr ON i.hr_reviewer_id = hr.id
        WHERE i.id = ?
    `).get(id));

    if (!incident) {
        req.flash('error', 'Incident report not found.');
        return res.redirect('/incidents');
    }

    // Access control: Coordinator can only see incidents for their warehouse
    if (user.role === 'COORDINATOR' && !validateAreaAccess(incident.area_id, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have access to this incident report.', code: 403 });
    }

    const entries = (await db.prepare(`
        SELECT ie.*, u.full_name as author_name
        FROM incident_entries ie
        JOIN users u ON ie.author_id = u.id
        WHERE ie.incident_id = ?
        ORDER BY ie.created_at ASC
    `).all(id));

    res.render('incidents/view', {
        title: `${incident.incident_ref} - Incident Report`,
        incident,
        entries
    });
});

// POST /incidents/:id/comment (Add comment/investigation update)
router.post('/:id/comment', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);
    const { content } = req.body;

    if (!content || !content.trim()) {
        req.flash('error', 'Comment cannot be empty.');
        return res.redirect(`/incidents/${id}`);
    }

    const incident = (await db.prepare('SELECT * FROM incident_reports WHERE id = ?').get(id));
    if (!incident) {
        req.flash('error', 'Incident report not found.');
        return res.redirect('/incidents');
    }

    if (user.role === 'COORDINATOR' && !validateAreaAccess(incident.area_id, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'Access denied.', code: 403 });
    }

    const entryType = (user.role === 'HR' || user.role === 'HEAD_HR') ? 'investigation' : 'comment';

    (await db.prepare(`
        INSERT INTO incident_entries (incident_id, author_id, author_role, content, entry_type, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(id, user.id, user.role, content.trim(), entryType));

    // Update incident timestamp
    (await db.prepare("UPDATE incident_reports SET updated_at = datetime('now') WHERE id = ?").run(id));

    // Notify involved parties
    if (user.role === 'COORDINATOR') {
        (await notifyHR(
            `Update on Incident ${incident.incident_ref}`,
            `${user.full_name} added an update to incident "${incident.title}".`,
            `/incidents/${id}`,
            `inc-update-${id}-${Date.now()}`
        ));
    } else {
        // HR / Admin replied -> notify reporting coordinator
        (await createNotification(
            incident.reported_by,
            `HR Update on Incident ${incident.incident_ref}`,
            `${user.full_name} (${user.role}) added an update to your incident report.`,
            `/incidents/${id}`
        ));
    }

    req.flash('success', 'Update posted to incident log.');
    res.redirect(`/incidents/${id}`);
});

// POST /incidents/:id/action (HR and Admin take action / update status / resolve)
router.post('/:id/action', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);
    const { status, hr_action_type, hr_resolution_notes, remarks } = req.body;

    // Only HR, HEAD_HR, and ADMIN can update official incident findings/actions
    if (!['HR', 'HEAD_HR', 'ADMIN'].includes(user.role)) {
        req.flash('error', 'Only HR and Administrators can take official actions on incident reports.');
        return res.redirect(`/incidents/${id}`);
    }

    const incident = (await db.prepare('SELECT * FROM incident_reports WHERE id = ?').get(id));
    if (!incident) {
        req.flash('error', 'Incident not found.');
        return res.redirect('/incidents');
    }

    const newStatus = status || incident.status;
    const actionType = hr_action_type || incident.hr_action_type || 'none';
    const isResolving = ['resolved', 'closed'].includes(newStatus);
    const resolvedAt = isResolving ? DateTime.now().toUTC().toISO() : incident.resolved_at;

    (await db.prepare(`
        UPDATE incident_reports
        SET status = ?,
            hr_reviewer_id = ?,
            hr_action_type = ?,
            hr_resolution_notes = COALESCE(?, hr_resolution_notes),
            resolved_at = ?,
            updated_at = datetime('now')
        WHERE id = ?
    `).run(
        newStatus,
        user.id,
        actionType,
        hr_resolution_notes ? hr_resolution_notes.trim() : null,
        resolvedAt,
        id
    ));

    // Add entry in timeline
    const actionDesc = `Status updated to [${newStatus.toUpperCase()}]. Action Taken: [${actionType.toUpperCase()}]. ${remarks ? 'Notes: ' + remarks.trim() : ''}`;
    (await db.prepare(`
        INSERT INTO incident_entries (incident_id, author_id, author_role, content, entry_type, created_at)
        VALUES (?, ?, ?, ?, 'hr_action', datetime('now'))
    `).run(id, user.id, user.role, actionDesc));

    // Notify coordinator
    (await createNotification(
        incident.reported_by,
        `Incident Decision: ${incident.incident_ref}`,
        `${user.full_name} (${user.role}) marked incident as "${newStatus}". Action: ${actionType}.`,
        `/incidents/${id}`
    ));

    (await logAction(user.id, 'INCIDENT_ACTION', 'incident_reports', id, {
        status: newStatus,
        actionType,
        incidentRef: incident.incident_ref
    }));

    req.flash('success', `Incident status updated to ${newStatus.replace(/_/g, ' ')}.`);
    res.redirect(`/incidents/${id}`);
});

module.exports = router;
