const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { validateAreaAccess } = require('../middleware/area-guard');
const { getDb } = require('../db/database');
const { validateDecision } = require('../services/employee-status');
const { logAction } = require('../services/audit');
const { createNotification, notifyHR } = require('../services/notification');

// GET /btw (List BTW cases with Pending, Approved, and Summary tabs)
router.get('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const selectedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : (req.query.area_id ? parseInt(req.query.area_id) : null);
    const searchQuery = (req.query.q || '').trim();
    const statusFilter = req.query.status || '';

    // Calculate tab counts
    let countWhere = [];
    let countParams = [];
    if (selectedAreaId) {
        countWhere.push('b.area_id = ?');
        countParams.push(selectedAreaId);
    }
    const countWhereClause = countWhere.length > 0 ? 'WHERE ' + countWhere.join(' AND ') : '';

    const statsRows = (await db.prepare(`
        SELECT b.status,
               COALESCE(b.action_type, ha.action_type, 'none') as action_type,
               COUNT(*) as c
        FROM btw_cases b
        LEFT JOIN btw_hr_actions ha ON ha.id = (
            SELECT id FROM btw_hr_actions WHERE case_id = b.id ORDER BY id DESC LIMIT 1
        )
        ${countWhereClause}
        GROUP BY 1, 2
    `).all(...countParams));

    const counts = {
        pending: 0,
        approved: 0,
        summary: 0,
        suspended: 0
    };

    for (const row of statsRows) {
        const c = Number(row.c) || 0;
        counts.summary += c;
        if (['pending_hr_review', 'for_clarification'].includes(row.status)) {
            counts.pending += c;
        }
        if (row.status === 'approved') {
            counts.approved += c;
        }
        if (row.action_type === 'suspension') {
            counts.suspended += c;
        }
    }

    // Determine active tab: pending, approved, summary
    let currentTab = req.query.tab;
    if (!currentTab || !['pending', 'approved', 'summary'].includes(currentTab)) {
        currentTab = counts.pending > 0 ? 'pending' : (counts.approved > 0 ? 'approved' : 'summary');
    }

    // Build query for current tab
    let where = [];
    let params = [];

    if (selectedAreaId) {
        where.push('b.area_id = ?');
        params.push(selectedAreaId);
    }

    if (currentTab === 'pending') {
        where.push("b.status IN ('pending_hr_review', 'for_clarification')");
    } else if (currentTab === 'approved') {
        where.push("b.status = 'approved'");
    } else if (currentTab === 'summary') {
        // Summary tab shows all, but user can filter by status or suspension
        if (statusFilter === 'suspended') {
            where.push("(b.action_type = 'suspension' OR ha.action_type = 'suspension')");
        } else if (statusFilter) {
            where.push('b.status = ?');
            params.push(statusFilter);
        }
    }

    if (searchQuery) {
        where.push('(e.full_name LIKE ? OR e.employee_id LIKE ? OR b.case_ref LIKE ? OR b.article_violated LIKE ?)');
        params.push(`%${searchQuery}%`, `%${searchQuery}%`, `%${searchQuery}%`, `%${searchQuery}%`);
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const cases = (await db.prepare(`
        SELECT b.*, e.full_name as employee_name, e.employee_id as emp_code, e.status as emp_status,
               a.name as area_name, u.full_name as coordinator_name,
               hr.full_name as hr_reviewer_name,
               COALESCE(b.article_violated, ha.article_violated) as effective_article,
               COALESCE(b.suspension_start, ha.suspension_start) as effective_suspension_start,
               COALESCE(b.suspension_end, ha.suspension_end) as effective_suspension_end,
               COALESCE(b.authorized_return_date, ha.return_date) as effective_return_date,
               COALESCE(b.action_type, ha.action_type, 'none') as effective_action_type,
               COALESCE(b.hr_remarks, ha.summary) as effective_hr_remarks,
               (SELECT COUNT(*) FROM btw_case_entries WHERE case_id = b.id) as reply_count
        FROM btw_cases b
        JOIN employees e ON b.employee_id = e.id
        JOIN areas a ON b.area_id = a.id
        LEFT JOIN users u ON b.coordinator_id = u.id
        LEFT JOIN users hr ON b.hr_reviewer_id = hr.id
        LEFT JOIN btw_hr_actions ha ON ha.id = (
            SELECT id FROM btw_hr_actions WHERE case_id = b.id ORDER BY id DESC LIMIT 1
        )
        ${whereClause}
        ORDER BY b.created_at DESC
    `).all(...params));

    const areas = user.role !== 'COORDINATOR' ? (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all()) : [];

    res.render('btw/list', {
        title: 'Back-to-Work Clearance - TAASCOR',
        cases,
        currentTab,
        counts,
        statusFilter,
        searchQuery,
        selectedAreaId,
        areas
    });
});

// GET /btw/:id (Forum/Thread View)
router.get('/:id', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);

    const btwCase = (await db.prepare(`
        SELECT b.*, e.full_name as employee_name, e.employee_id as emp_code, e.status as emp_status,
               p.title as position_title, a.name as area_name, u.full_name as coordinator_name,
               hr.full_name as hr_reviewer_name,
               COALESCE(b.article_violated, ha.article_violated) as effective_article,
               COALESCE(b.suspension_start, ha.suspension_start) as effective_suspension_start,
               COALESCE(b.suspension_end, ha.suspension_end) as effective_suspension_end,
               COALESCE(b.authorized_return_date, ha.return_date) as effective_return_date,
               COALESCE(b.action_type, ha.action_type, 'none') as effective_action_type,
               COALESCE(b.hr_remarks, ha.summary) as effective_hr_remarks
        FROM btw_cases b
        JOIN employees e ON b.employee_id = e.id
        JOIN areas a ON b.area_id = a.id
        LEFT JOIN positions p ON e.position_id = p.id
        LEFT JOIN users u ON b.coordinator_id = u.id
        LEFT JOIN users hr ON b.hr_reviewer_id = hr.id
        LEFT JOIN btw_hr_actions ha ON ha.id = (
            SELECT id FROM btw_hr_actions WHERE case_id = b.id ORDER BY id DESC LIMIT 1
        )
        WHERE b.id = ?
    `).get(id));

    if (!btwCase) {
        req.flash('error', 'Back-to-Work case not found.');
        return res.redirect('/btw');
    }

    if (!validateAreaAccess(btwCase.area_id, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot access cases outside your assigned area.', code: 403 });
    }

    let dates = [];
    try {
        dates = JSON.parse(btwCase.absence_dates);
    } catch (e) {
        dates = [btwCase.absence_dates];
    }

    const entries = (await db.prepare(`
        SELECT be.*, u.full_name as author_name
        FROM btw_case_entries be
        JOIN users u ON be.author_id = u.id
        WHERE be.case_id = ?
        ORDER BY be.created_at ASC
    `).all(id));

    res.render('btw/view', {
        title: `Case ${btwCase.case_ref} - Back-to-Work`,
        btwCase,
        dates,
        entries
    });
});

// POST /btw/:id/reply (Coordinator or HR adds remarks/explanation)
router.post('/:id/reply', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);
    const { content } = req.body;

    if (!content || !content.trim()) {
        req.flash('error', 'Message cannot be empty.');
        return res.redirect(`/btw/${id}`);
    }

    const btwCase = (await db.prepare('SELECT * FROM btw_cases WHERE id = ?').get(id));
    if (!btwCase) {
        req.flash('error', 'Case not found.');
        return res.redirect('/btw');
    }

    if (!validateAreaAccess(btwCase.area_id, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'Access denied.', code: 403 });
    }

    (await db.prepare(`
        INSERT INTO btw_case_entries (case_id, author_id, author_role, content, entry_type, created_at)
        VALUES (?, ?, ?, ?, 'comment', UTC_TIMESTAMP())
    `).run(id, user.id, user.role, content.trim()));

    (await db.prepare("UPDATE btw_cases SET updated_at = UTC_TIMESTAMP() WHERE id = ?").run(id));

    if (user.role === 'COORDINATOR') {
        (await notifyHR(
            `BTW Update: ${btwCase.case_ref}`,
            `Coordinator added remarks/explanation for Case ${btwCase.case_ref}.`,
            `/btw/${id}`,
            `btw-reply-${id}-${Date.now()}`
        ));
    } else {
        (await createNotification(
            btwCase.coordinator_id,
            `HR Remark: ${btwCase.case_ref}`,
            `HR posted remarks on Case ${btwCase.case_ref}.`,
            `/btw/${id}`,
            `btw-hr-reply-${id}-${Date.now()}`
        ));
    }

    req.flash('success', 'Update added to case thread.');
    res.redirect(`/btw/${id}`);
});

// POST /btw/:id/decision (HR / ADMIN Decision)
router.post('/:id/decision', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'HR' && user.role !== 'ADMIN') {
        return res.status(403).render('error', { title: 'Access Denied', message: 'Only HR or Administrator can record Back-to-Work clearance decisions.', code: 403 });
    }

    const db = getDb();
    const id = parseInt(req.params.id);
    const { decision, authorized_return_date, hr_remarks, article_violated, suspension_start, suspension_end, issued_date } = req.body;
    const error = validateDecision(req.body);
    if (error) { req.flash('error', error); return res.redirect(`/btw/${id}`); }
    const actionType = req.body.action_type || 'none';

    if (!decision || !['approved', 'not_approved', 'for_clarification'].includes(decision)) {
        req.flash('error', 'Invalid decision status.');
        return res.redirect(`/btw/${id}`);
    }

    if (decision === 'approved' && !authorized_return_date) {
        req.flash('error', 'Please provide an authorized return date when approving clearance.');
        return res.redirect(`/btw/${id}`);
    }

    const btwCase = (await db.prepare('SELECT * FROM btw_cases WHERE id = ?').get(id));
    if (!btwCase) {
        req.flash('error', 'Case not found.');
        return res.redirect('/btw');
    }

    const trimmedArticle = article_violated ? article_violated.trim() : null;
    const finalReturnDate = authorized_return_date || null;
    const startSuspension = actionType === 'suspension' ? suspension_start : null;
    const endSuspension = actionType === 'suspension' ? suspension_end : null;

    await db.transaction(async () => {
        (await db.prepare(`
            UPDATE btw_cases 
            SET status = ?, hr_reviewer_id = ?, hr_decision = ?, hr_remarks = ?, 
                action_type = ?, article_violated = ?, suspension_start = ?, suspension_end = ?,
                decision_at = UTC_TIMESTAMP(), authorized_return_date = ?, updated_at = UTC_TIMESTAMP()
            WHERE id = ?
        `).run(
            decision,
            user.id,
            decision.toUpperCase(),
            hr_remarks ? hr_remarks.trim() : null,
            actionType,
            trimmedArticle,
            startSuspension,
            endSuspension,
            finalReturnDate,
            id
        ));

        // Add decision entry into thread
        let decisionText = `Official HR Decision: ${decision.replace(/_/g, ' ').toUpperCase()}`;
        if (actionType === 'suspension') {
            decisionText += ` | Status: SUSPENDED`;
            if (trimmedArticle) decisionText += ` | Article Violated: ${trimmedArticle}`;
            decisionText += ` | Suspension Dates: ${startSuspension} to ${endSuspension}`;
            if (finalReturnDate) decisionText += ` | Authorized Return: ${finalReturnDate}`;
        } else if (decision === 'approved') {
            decisionText += ` | Authorized Return Date: ${finalReturnDate}`;
            if (trimmedArticle) decisionText += ` | Policy Note: ${trimmedArticle}`;
        }
        if (hr_remarks) {
            decisionText += `\nGrounds / Reason: ${hr_remarks.trim()}`;
        }

        (await db.prepare(`
            INSERT INTO btw_case_entries (case_id, author_id, author_role, content, entry_type, created_at)
            VALUES (?, ?, 'HR', ?, 'decision', UTC_TIMESTAMP())
        `).run(id, user.id, decisionText));

        await db.prepare(`
            INSERT INTO btw_hr_actions (case_id, author_id, decision, action_type, issued_date, suspension_start, suspension_end, return_date, article_violated, summary)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            user.id,
            decision,
            actionType,
            actionType === 'none' ? null : (issued_date || null),
            startSuspension,
            endSuspension,
            finalReturnDate,
            trimmedArticle,
            hr_remarks.trim()
        );
    });

    // Notify coordinator immediately
    (await createNotification(
        btwCase.coordinator_id,
        `BTW Decision: ${btwCase.case_ref} - ${decision.toUpperCase()}${actionType === 'suspension' ? ' (SUSPENDED)' : ''}`,
        `HR decision for ${btwCase.case_ref}: ${decision.replace(/_/g, ' ').toUpperCase()}${actionType === 'suspension' ? ' with suspension' : ''}.`,
        `/btw/${id}`,
        `btw-decision-${id}-${Date.now()}`
    ));

    (await logAction(user.id, 'RECORD_BTW_DECISION', 'btw_cases', id, {
        decision,
        actionType,
        article_violated: trimmedArticle,
        suspension_start: startSuspension,
        suspension_end: endSuspension,
        authorized_return_date: finalReturnDate,
        hr_remarks
    }));

    req.flash('success', `Decision recorded: ${decision.replace(/_/g, ' ').toUpperCase()}${actionType === 'suspension' ? ' with suspension' : ''}`);
    res.redirect(`/btw/${id}`);
});

module.exports = router;
