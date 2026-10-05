const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { validateAreaAccess } = require('../middleware/area-guard');
const { getDb } = require('../db/database');
const { logAction } = require('../services/audit');
const { notifyHR, createNotification } = require('../services/notification');
const { getManpowerSummary, syncRequestStatus } = require('../services/manpower');

// GET /manpower (List requests)
router.get('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const statusFilter = req.query.status || '';
    const selectedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : (req.query.area_id ? parseInt(req.query.area_id) : null);

    let where = [];
    let params = [];

    if (selectedAreaId) {
        where.push('mr.area_id = ?');
        params.push(selectedAreaId);
    }

    if (statusFilter) {
        where.push('mr.status = ?');
        params.push(statusFilter);
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const requests = (await db.prepare(`
        SELECT mr.*, a.name as area_name, u.full_name as requester_name, (SELECT hu.full_name FROM manpower_request_handlers mh JOIN users hu ON hu.id=mh.hr_id WHERE mh.request_id=mr.id) as handler_name,
               COALESCE((SELECT SUM(quantity_requested) FROM manpower_request_positions WHERE request_id = mr.id), 0) as total_requested,
               COALESCE((SELECT COUNT(*) FROM manpower_allocations WHERE request_id = mr.id AND status = 'confirmed'), 0) as confirmed_count,
               COALESCE((SELECT COUNT(*) FROM manpower_allocations WHERE request_id = mr.id AND status = 'proposed'), 0) as proposed_count,
               (SELECT COUNT(*) FROM manpower_request_entries WHERE request_id = mr.id) as reply_count
        FROM manpower_requests mr
        JOIN areas a ON mr.area_id = a.id
        LEFT JOIN users u ON mr.requested_by = u.id
        ${whereClause}
        ORDER BY mr.created_at DESC
    `).all(...params));

    const areas = user.role !== 'COORDINATOR' ? (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all()) : [];

    res.render('manpower/list', {
        title: 'Manpower Requests - TAASCOR',
        requests,
        statusFilter,
        selectedAreaId,
        areas
    });
});

// GET /manpower/new
router.get('/new', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();

    const positions = (await db.prepare('SELECT * FROM positions WHERE is_active = 1 ORDER BY title ASC').all());
    const areas = user.role === 'COORDINATOR'
        ? [req.userArea]
        : (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all());

    res.render('manpower/form', {
        title: 'New Manpower Request - TAASCOR',
        positions,
        areas
    });
});

// POST /manpower
router.post('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const { area_id, deployment_date, shift_details, reason, priority, remarks, positions } = req.body;

    const assignedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : parseInt(area_id);

    if (!validateAreaAccess(assignedAreaId, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot submit requests for other areas.', code: 403 });
    }

    if (!deployment_date || !reason) {
        req.flash('error', 'Please provide deployment date and reason.');
        return res.redirect('/manpower/new');
    }

    // Insert manpower request
    const result = (await db.prepare(`
        INSERT INTO manpower_requests (area_id, requested_by, status, deployment_date, shift_details, reason, priority, remarks, created_at, updated_at)
        VALUES (?, ?, 'submitted', ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
    `).run(
        assignedAreaId,
        user.id,
        deployment_date,
        shift_details ? shift_details.trim() : null,
        reason.trim(),
        priority || 'normal',
        remarks ? remarks.trim() : null
    ));

    const requestId = result.lastInsertRowid;

    // Insert position breakdown
    // Note: form sends positions[p_<id>] to avoid qs re-indexing numeric keys as arrays
    if (positions && typeof positions === 'object' && !Array.isArray(positions)) {
        const posInsert = db.prepare(`
            INSERT INTO manpower_request_positions (request_id, position_id, quantity_requested)
            VALUES (?, ?, ?)
        `);

        for (const [rawKey, qtyStr] of Object.entries(positions)) {
            // Strip optional p_ prefix so both p_1 and 1 work
            const cleanKey = String(rawKey).replace(/^p_/, '');
            const qty = parseInt(qtyStr);
            const posId = parseInt(cleanKey);
            if (qty > 0 && posId) {
                const posExists = (await db.prepare('SELECT id FROM positions WHERE id = ?').get(posId));
                if (posExists) {
                    (await posInsert.run(requestId, posId, qty));
                }
            }
        }
    }

    // Initial thread entry
    (await db.prepare(`
        INSERT INTO manpower_request_entries (request_id, author_id, author_role, content, entry_type, created_at)
        VALUES (?, ?, ?, ?, 'comment', UTC_TIMESTAMP())
    `).run(requestId, user.id, user.role, `Manpower request submitted for ${deployment_date}. Reason: ${reason}`));

    // Notify HR
    (await notifyHR(
        'New Manpower Request',
        `Coordinator ${user.full_name} submitted a manpower request for deployment on ${deployment_date}.`,
        `/manpower/${requestId}`,
        `mp-new-${requestId}`
    ));

    (await logAction(user.id, 'SUBMIT_MANPOWER_REQUEST', 'manpower_requests', requestId, {
        deployment_date,
        reason
    }));

    req.flash('success', 'Manpower request submitted to HR.');
    res.redirect(`/manpower/${requestId}`);
});

// GET /manpower/:id (Thread + allocation view)
router.get('/:id', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);

    const request = (await db.prepare(`
        SELECT mr.*, a.name as area_name, u.full_name as requester_name, (SELECT hu.full_name FROM manpower_request_handlers mh JOIN users hu ON hu.id=mh.hr_id WHERE mh.request_id=mr.id) as handler_name
        FROM manpower_requests mr
        JOIN areas a ON mr.area_id = a.id
        LEFT JOIN users u ON mr.requested_by = u.id
        WHERE mr.id = ?
    `).get(id));

    if (!request) {
        req.flash('error', 'Request not found.');
        return res.redirect('/manpower');
    }

    if (!validateAreaAccess(request.area_id, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot view requests for other areas.', code: 403 });
    }

    const requestedPositions = (await db.prepare(`
        SELECT mrp.*, p.title as position_title 
        FROM manpower_request_positions mrp
        JOIN positions p ON mrp.position_id = p.id
        WHERE mrp.request_id = ?
    `).all(id));

    const allocations = (await db.prepare(`
        SELECT ma.*, p.title as requested_position_title, 
               act_p.title as actual_position_title,
               e.full_name as existing_emp_name, e.employee_id as emp_code,
               alloc_user.full_name as allocated_by_name,
               conf_user.full_name as confirmed_by_name
        FROM manpower_allocations ma
        LEFT JOIN manpower_request_positions mrp ON ma.request_position_id = mrp.id
        LEFT JOIN positions p ON mrp.position_id = p.id
        LEFT JOIN positions act_p ON ma.actual_position_id = act_p.id
        LEFT JOIN employees e ON ma.employee_id = e.id
        LEFT JOIN users alloc_user ON ma.allocated_by = alloc_user.id
        LEFT JOIN users conf_user ON ma.confirmed_by = conf_user.id
        WHERE ma.request_id = ?
        ORDER BY ma.created_at ASC
    `).all(id));

    const entries = (await db.prepare(`
        SELECT me.*, u.full_name as author_name 
        FROM manpower_request_entries me
        JOIN users u ON me.author_id = u.id
        WHERE me.request_id = ?
        ORDER BY me.created_at ASC
    `).all(id));

    const summary = (await getManpowerSummary(id));
    const positionsList = (await db.prepare('SELECT * FROM positions WHERE is_active = 1 ORDER BY title ASC').all());
    const availableEmployees = (await db.prepare("SELECT id, employee_id, full_name FROM employees WHERE status = 'active' ORDER BY full_name ASC").all());

    res.render('manpower/view', {
        title: `Manpower Request #${request.id} - TAASCOR`,
        request,
        requestedPositions,
        allocations,
        entries,
        summary,
        positionsList,
        availableEmployees
    });
});

// POST /manpower/:id/reply
router.post('/:id/reply', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);
    const { content } = req.body;

    if (!content || !content.trim()) {
        req.flash('error', 'Message cannot be empty.');
        return res.redirect(`/manpower/${id}`);
    }

    const request = (await db.prepare('SELECT * FROM manpower_requests WHERE id = ?').get(id));
    if (!request || !validateAreaAccess(request.area_id, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'Access denied.', code: 403 });
    }

    (await db.prepare(`
        INSERT INTO manpower_request_entries (request_id, author_id, author_role, content, entry_type, created_at)
        VALUES (?, ?, ?, ?, 'comment', UTC_TIMESTAMP())
    `).run(id, user.id, user.role, content.trim()));

    if (user.role === 'COORDINATOR') {
        (await notifyHR(
            `Manpower Request #${id} Update`,
            `Coordinator added comments to Request #${id}.`,
            `/manpower/${id}`,
            `mp-reply-${id}-${Date.now()}`
        ));
    } else {
        (await createNotification(
            request.requested_by,
            `HR Update on Request #${id}`,
            `HR added comments to your manpower request #${id}.`,
            `/manpower/${id}`,
            `mp-hr-reply-${id}-${Date.now()}`
        ));
    }

    req.flash('success', 'Message added.');
    res.redirect(`/manpower/${id}`);
});

// POST /manpower/:id/allocate (HR assigns named workers)
router.post('/:id/allocate', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (user.role !== 'HR' && user.role !== 'ADMIN') {
        return res.status(403).render('error', { title: 'Access Denied', message: 'Only HR can assign workers.', code: 403 });
    }

    const db = getDb();
    const id = parseInt(req.params.id);
    const { request_position_id, worker_type, existing_employee_id, worker_name } = req.body;

    const request = (await db.prepare('SELECT * FROM manpower_requests WHERE id = ?').get(id));
    if (!request) {
        req.flash('error', 'Request not found.');
        return res.redirect('/manpower');
    }

    let assignedEmpId = null;
    let nameStr = null;

    if (worker_type === 'existing') {
        if (!existing_employee_id) {
            req.flash('error', 'Please select an existing employee.');
            return res.redirect(`/manpower/${id}`);
        }
        assignedEmpId = parseInt(existing_employee_id);
        const emp = (await db.prepare('SELECT full_name FROM employees WHERE id = ?').get(assignedEmpId));
        nameStr = emp ? emp.full_name : 'Existing Worker';
    } else {
        if (!worker_name || !worker_name.trim()) {
            req.flash('error', 'Please provide the incoming worker name.');
            return res.redirect(`/manpower/${id}`);
        }
        nameStr = worker_name.trim();
    }

    const posRow = (await db.prepare('SELECT * FROM manpower_request_positions WHERE id = ?').get(parseInt(request_position_id)));

    (await db.prepare(`
        INSERT INTO manpower_allocations (request_id, request_position_id, employee_id, worker_name, allocated_by, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'proposed', UTC_TIMESTAMP(), UTC_TIMESTAMP())
    `).run(id, posRow.id, assignedEmpId, nameStr, user.id));

    // Thread entry
    (await db.prepare(`
        INSERT INTO manpower_request_entries (request_id, author_id, author_role, content, entry_type, created_at)
        VALUES (?, ?, 'HR', ?, 'allocation', UTC_TIMESTAMP())
    `).run(id, user.id, `Assigned candidate: "${nameStr}". Awaiting coordinator confirmation upon arrival.`));

    (await syncRequestStatus(id));

    // Notify coordinator
    (await createNotification(
        request.requested_by,
        `Worker Assigned to Request #${id}`,
        `HR assigned candidate "${nameStr}" for your review upon arrival.`,
        `/manpower/${id}`,
        `mp-alloc-${id}-${Date.now()}`
    ));

    (await logAction(user.id, 'ALLOCATE_WORKER', 'manpower_allocations', null, { requestId: id, worker: nameStr }));

    req.flash('success', `Assigned worker "${nameStr}". Awaiting coordinator confirmation.`);
    res.redirect(`/manpower/${id}`);
});

// POST /manpower/:id/confirm-arrival (Coordinator confirms arrival + sets actual position/schedule)
router.post('/:id/confirm-arrival', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);
    const { allocation_id, status_decision, actual_position_id, position_change_reason, shift_start, shift_end } = req.body;

    const request = (await db.prepare('SELECT * FROM manpower_requests WHERE id = ?').get(id));
    if (!request || !validateAreaAccess(request.area_id, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'Access denied.', code: 403 });
    }

    const alloc = (await db.prepare(`
        SELECT ma.*, mrp.position_id as requested_position_id 
        FROM manpower_allocations ma
        LEFT JOIN manpower_request_positions mrp ON ma.request_position_id = mrp.id
        WHERE ma.id = ? AND ma.request_id = ?
    `).get(parseInt(allocation_id), id));

    if (!alloc) {
        req.flash('error', 'Worker allocation record not found.');
        return res.redirect(`/manpower/${id}`);
    }

    if (status_decision === 'did_not_report') {
        (await db.prepare(`
            UPDATE manpower_allocations 
            SET status = 'did_not_report', confirmed_by = ?, confirmed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
            WHERE id = ?
        `).run(user.id, alloc.id));

        (await db.prepare(`
            INSERT INTO manpower_request_entries (request_id, author_id, author_role, content, entry_type, created_at)
            VALUES (?, ?, ?, ?, 'system', UTC_TIMESTAMP())
        `).run(id, user.id, user.role, `Worker "${alloc.worker_name || 'Candidate'}" was marked as: DID NOT REPORT FOR DUTY.`));

        (await syncRequestStatus(id));
        req.flash('warning', 'Worker marked as Did Not Report.');
        return res.redirect(`/manpower/${id}`);
    }

    // Confirmed arrival!
    const actualPosId = actual_position_id ? parseInt(actual_position_id) : alloc.requested_position_id;
    let employeeId = alloc.employee_id;

    // If incoming worker was not an existing employee record, add to masterfile now!
    if (!employeeId) {
        const year = new Date().getFullYear();
        const empCode = `TAAS-${year}-${require('crypto').randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
        const parts = (alloc.worker_name || 'Worker').trim().split(' ');
        const firstName = parts[0] || 'Worker';
        const lastName = parts.slice(1).join(' ') || 'Employee';

        const empRes = (await db.prepare(`
            INSERT INTO employees (employee_id, first_name, last_name, full_name, area_id, coordinator_id, position_id, employment_start_date, status, remarks, created_at, updated_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)
        `).run(
            empCode,
            firstName,
            lastName,
            alloc.worker_name,
            request.area_id,
            user.role === 'COORDINATOR' ? user.id : request.requested_by,
            actualPosId,
            request.deployment_date,
            `Deployed via Manpower Request #${id}`,
            user.id
        ));

        employeeId = empRes.lastInsertRowid;
    } else {
        // Update existing employee to this area and coordinator
        (await db.prepare(`
            UPDATE employees 
            SET area_id = ?, coordinator_id = ?, position_id = ?, status = 'active', updated_at = UTC_TIMESTAMP(), updated_by = ?
            WHERE id = ?
        `).run(request.area_id, user.id, actualPosId, user.id, employeeId));
    }

    // If schedule provided, create initial schedule
    if (shift_start && shift_end) {
        (await db.prepare(`
            INSERT INTO employee_schedules (employee_id, work_date, shift_start, shift_end, is_rest_day, created_by, created_at)
            VALUES (?, ?, ?, ?, 0, ?, UTC_TIMESTAMP())
        ON CONFLICT(employee_id, work_date) DO UPDATE SET shift_start = excluded.shift_start, shift_end = excluded.shift_end, is_rest_day = excluded.is_rest_day
        `).run(employeeId, request.deployment_date, shift_start, shift_end, user.id));
    }

    // Update allocation record
    (await db.prepare(`
        UPDATE manpower_allocations 
        SET status = 'confirmed', employee_id = ?, confirmed_by = ?, confirmed_at = UTC_TIMESTAMP(),
            actual_position_id = ?, position_change_reason = ?, updated_at = UTC_TIMESTAMP()
        WHERE id = ?
    `).run(
        employeeId,
        user.id,
        actualPosId,
        position_change_reason ? position_change_reason.trim() : null,
        alloc.id
    ));

    let confirmMsg = `Worker "${alloc.worker_name || 'Candidate'}" confirmed for duty and added to Active Masterfile!`;
    if (actualPosId !== alloc.requested_position_id) {
        confirmMsg += ` (Position adjusted from requested with reason: ${position_change_reason || 'Operational adjustment'})`;
    }

    (await db.prepare(`
        INSERT INTO manpower_request_entries (request_id, author_id, author_role, content, entry_type, created_at)
        VALUES (?, ?, ?, ?, 'system', UTC_TIMESTAMP())
    `).run(id, user.id, user.role, confirmMsg));

    (await syncRequestStatus(id));

    (await notifyHR(
        `Worker Arrival Confirmed: Request #${id}`,
        `Coordinator confirmed arrival of worker for Request #${id}.`,
        `/manpower/${id}`,
        `mp-conf-${id}-${Date.now()}`
    ));

    (await logAction(user.id, 'CONFIRM_WORKER_ARRIVAL', 'manpower_allocations', alloc.id, {
        employeeId,
        actualPosId
    }));

    req.flash('success', confirmMsg);
    res.redirect(`/manpower/${id}`);
});

router.post('/:id/claim', requireAuth, async (req,res) => {
 if(req.session.user.role !== 'HR') return res.status(403).render('error',{title:'Access Denied',message:'Only HR can accept a manpower request.',code:403});
 const db=getDb(), id=Number(req.params.id)||0;
 const claimed=await db.transaction(async()=>{
  // SQLite does not support FOR UPDATE - just a regular SELECT
  const request=await db.prepare('SELECT id,status,requested_by FROM manpower_requests WHERE id=?').get(id);
  if(!request || ['filled','declined','cancelled'].includes(request.status)) return false;
  if(await db.prepare('SELECT request_id FROM manpower_request_handlers WHERE request_id=?').get(id)) return false;
  await db.prepare('INSERT INTO manpower_request_handlers (request_id,hr_id) VALUES (?,?)').run(id,req.session.user.id);
  await db.prepare("UPDATE manpower_requests SET status=CASE WHEN status='submitted' THEN 'under_review' ELSE status END,updated_at=UTC_TIMESTAMP() WHERE id=?").run(id);
  await db.prepare("INSERT INTO manpower_request_entries (request_id,author_id,author_role,content,entry_type) VALUES (?,?,'HR',?,'status_change')").run(id,req.session.user.id,req.session.user.full_name+' accepted this request.');
  await logAction(req.session.user.id,'CLAIM_MANPOWER_REQUEST','manpower_requests',id,{});
  await createNotification(request.requested_by,'HR accepted your request',req.session.user.full_name+' is handling manpower request #'+id,'/manpower/'+id,'manpower-claim-'+id);
  return true;
 })();
 req.flash(claimed?'success':'warning',claimed?'You are now handling this request.':'This request is already assigned or closed.');
 res.redirect('/manpower/'+id);
});

// POST /manpower/:id/delete  (Coordinator own requests; HR/Admin any request)
router.post('/:id/delete', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);

    const request = await db.prepare('SELECT * FROM manpower_requests WHERE id = ?').get(id);
    if (!request) {
        req.flash('error', 'Request not found.');
        return res.redirect('/manpower');
    }

    // Access control: coordinator can only delete their own; HR/Admin can delete any
    const isOwner = user.role === 'COORDINATOR' && request.requested_by === user.id;
    const isHRAdmin = ['HR', 'HEAD_HR', 'ADMIN'].includes(user.role);
    if (!isOwner && !isHRAdmin) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot delete this request.', code: 403 });
    }

    // Only allow delete if not yet filled/under deployment
    if (['filled'].includes(request.status)) {
        req.flash('error', 'Cannot delete a request that has already been filled.');
        return res.redirect(`/manpower/${id}`);
    }

    await db.transaction(async () => {
        await db.prepare('DELETE FROM manpower_allocations WHERE request_id = ?').run(id);
        await db.prepare('DELETE FROM manpower_request_positions WHERE request_id = ?').run(id);
        await db.prepare('DELETE FROM manpower_request_entries WHERE request_id = ?').run(id);
        await db.prepare('DELETE FROM manpower_request_handlers WHERE request_id = ?').run(id);
        await db.prepare('DELETE FROM manpower_requests WHERE id = ?').run(id);
    })();

    await logAction(user.id, 'DELETE_MANPOWER_REQUEST', 'manpower_requests', id, { reason: 'User deleted request' });
    req.flash('success', `Manpower Request #${id} has been deleted.`);
    res.redirect('/manpower');
});
module.exports = router;
