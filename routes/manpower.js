const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { validateAreaAccess } = require('../middleware/area-guard');
const { getDb } = require('../db/database');
const { pendingCategories } = require('../services/pending-work');
const pendingStatuses = pendingCategories.find(category => category.path === '/manpower').statuses;
const { logAction } = require('../services/audit');
const { notifyHR, createNotification } = require('../services/notification');
const { getManpowerSummary, syncRequestStatus } = require('../services/manpower');
const { validDate } = require('../services/employee-status');

function ownsCoordinatorRequest(request, req) {
    const user = req.session.user;
    return user.role === 'COORDINATOR' && request.requested_by === user.id;
}

function canEditRequest(request, req) {
    return ownsCoordinatorRequest(request, req) && !['declined', 'cancelled'].includes(request.status);
}

const editablePositions = `
    SELECT p.*, mrp.id AS request_position_id, mrp.quantity_requested,
           (SELECT COUNT(*) FROM manpower_allocations ma WHERE ma.request_position_id = mrp.id) AS allocation_count,
           (SELECT COUNT(*) FROM manpower_allocations ma WHERE ma.request_position_id = mrp.id
            AND ma.status IN ('proposed', 'confirmed')) AS assigned_count
    FROM positions p
    LEFT JOIN manpower_request_positions mrp ON mrp.position_id = p.id AND mrp.request_id = ?
    WHERE p.is_active = 1 OR mrp.id IS NOT NULL
    ORDER BY p.title
`;

function requestedQuantities(positions, availablePositions) {
    return availablePositions.map(({ id }) => [id, Number(positions?.[`p_${id}`] ?? positions?.[id] ?? 0)]);
}

router.post('/position-catalog', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (!['COORDINATOR', 'HR', 'ADMIN'].includes(user.role)) {
        return res.status(403).json({ error: 'You do not have access to manage positions.' });
    }

    const { action, position_id, title, description } = req.body;
    const id = Number(position_id);
    if (!['create', 'edit', 'archive'].includes(action) ||
        (action !== 'create' && (!Number.isSafeInteger(id) || id < 1))) {
        return res.status(400).json({ error: 'Choose a valid position action.' });
    }

    const name = typeof title === 'string' ? title.trim() : '';
    const notes = typeof description === 'string' ? description.trim() : '';
    if (action !== 'archive' && (!name || name.length > 191 || notes.length > 1000 ||
        (description != null && typeof description !== 'string'))) {
        return res.status(400).json({ error: 'Enter a title up to 191 characters and a description up to 1,000 characters.' });
    }

    const db = getDb();
    try {
        const position = await db.transaction(async () => {
            if (action === 'create') {
                const result = await db.prepare(`
                    INSERT INTO positions (title, description, created_by) VALUES (?, ?, ?)
                `).run(name, notes || null, user.id);
                const saved = await db.prepare('SELECT id, title, description FROM positions WHERE id = ?').get(result.lastInsertRowid);
                await logAction(user.id, 'CREATE_POSITION', 'positions', saved.id, { title: saved.title });
                return saved;
            }

            const current = await db.prepare('SELECT id, title FROM positions WHERE id = ? AND is_active = 1 FOR UPDATE').get(id);
            if (!current) return null;
            if (action === 'archive') {
                await db.prepare('UPDATE positions SET is_active = 0 WHERE id = ?').run(id);
                await logAction(user.id, 'ARCHIVE_POSITION', 'positions', id, { title: current.title });
                return current;
            }

            await db.prepare('UPDATE positions SET title = ?, description = ? WHERE id = ?').run(name, notes || null, id);
            await logAction(user.id, 'UPDATE_POSITION', 'positions', id, { title: name });
            return { id, title: name, description: notes };
        })();
        if (!position) return res.status(404).json({ error: 'This position is no longer active. Refresh the page.' });
        return res.status(action === 'create' ? 201 : 200).json({ position });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A position with this title already exists.' });
        throw error;
    }
});

// GET /manpower (List requests)
router.get('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const statusFilter = req.query.status || '';
    const selectedAreaId = user.role === 'COORDINATOR' ? req.userAreaId : (req.query.area_id ? parseInt(req.query.area_id) : null);

    let where = [];
    let params = [];

    if (user.role === 'COORDINATOR') {
        where.push('(mr.requested_by = ? OR mr.area_id = ?)');
        params.push(user.id, selectedAreaId ?? null);
    } else if (selectedAreaId) {
        where.push('mr.area_id = ?');
        params.push(selectedAreaId);
    }

    if (statusFilter === 'pending') {
        where.push('mr.status IN (' + pendingStatuses.map(() => '?').join(', ') + ')');
        params.push(...pendingStatuses);
    } else if (statusFilter) {
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
        requests: requests.map(request => ({ ...request, canEdit: canEditRequest(request, req) })),
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
        areas,
        request: null,
        positionsOnly: false,
        quantities: {}
    });
});

router.route('/:id/edit')
    .all(requireAuth)
    .get(async (req, res) => {
        const db = getDb();
        const request = await db.prepare(`
            SELECT mr.*, a.name AS area_name FROM manpower_requests mr
            JOIN areas a ON a.id = mr.area_id WHERE mr.id = ?
        `).get(req.params.id);
        if (!request || !canEditRequest(request, req)) {
            return res.status(403).render('error', { title: 'Request Locked', message: 'Only the requesting coordinator can edit this request. Cancelled and declined requests are closed.', code: 403 });
        }
        const positions = await db.prepare(editablePositions).all(request.id);
        const positionsOnly = req.query.section === 'positions';
        res.render('manpower/form', {
            title: positionsOnly ? 'Edit Positions' : 'Edit Manpower Request',
            request,
            positions,
            positionsOnly,
            areas: [req.userArea],
            quantities: Object.fromEntries(positions.map(row => [row.id, row.quantity_requested ?? 0]))
        });
    })
    .post(async (req, res) => {
        const db = getDb();
        const { deployment_date, shift_details, reason, priority, remarks, positions } = req.body;
        const positionsOnly = req.query.section === 'positions';
        const editUrl = `/manpower/${req.params.id}/edit${positionsOnly ? '?section=positions' : ''}`;
        const result = await db.transaction(async () => {
            const request = await db.prepare('SELECT * FROM manpower_requests WHERE id = ? FOR UPDATE').get(req.params.id);
            if (!request || !canEditRequest(request, req)) return 'locked';

            const available = await db.prepare(editablePositions).all(request.id);
            const quantities = requestedQuantities(positions, available);
            if (!positionsOnly && (!validDate(deployment_date) || typeof reason !== 'string' || !reason.trim() ||
                !['low', 'normal', 'high', 'urgent'].includes(priority) ||
                [shift_details, remarks].some(value => value != null && typeof value !== 'string'))) return 'invalid-details';
            if (!quantities.some(([, quantity]) => quantity > 0) ||
                quantities.some(([, quantity]) => !Number.isInteger(quantity) || quantity < 0 || quantity > 100)) return 'invalid-positions';
            if (quantities.some(([, quantity], index) => quantity < Math.max(available[index].assigned_count, available[index].allocation_count ? 1 : 0))) {
                return 'allocated';
            }

            if (positionsOnly) {
                await db.prepare('UPDATE manpower_requests SET updated_at = UTC_TIMESTAMP() WHERE id = ?').run(request.id);
            } else {
                await db.prepare(`
                    UPDATE manpower_requests SET deployment_date = ?, shift_details = ?, reason = ?,
                        priority = ?, remarks = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?
                `).run(deployment_date, shift_details?.trim() || null, reason.trim(), priority, remarks?.trim() || null, request.id);
            }
            const insert = db.prepare('INSERT INTO manpower_request_positions (request_id, position_id, quantity_requested) VALUES (?, ?, ?)');
            const update = db.prepare('UPDATE manpower_request_positions SET quantity_requested = ? WHERE id = ?');
            const remove = db.prepare('DELETE FROM manpower_request_positions WHERE id = ?');
            for (const [index, [positionId, quantity]] of quantities.entries()) {
                const rowId = available[index].request_position_id;
                if (rowId && quantity > 0) await update.run(quantity, rowId);
                else if (rowId) await remove.run(rowId);
                else if (quantity > 0) await insert.run(request.id, positionId, quantity);
            }
            await syncRequestStatus(request.id);
            await db.prepare(`
                INSERT INTO manpower_request_entries (request_id, author_id, author_role, content, entry_type, created_at)
                VALUES (?, ?, 'COORDINATOR', 'Updated the manpower request.', 'comment', UTC_TIMESTAMP())
            `).run(request.id, req.session.user.id);
            await logAction(req.session.user.id, 'UPDATE_MANPOWER_REQUEST', 'manpower_requests', request.id, { deployment_date: positionsOnly ? request.deployment_date : deployment_date });
            return 'saved';
        })();
        if (result === 'locked') {
            return res.status(403).render('error', { title: 'Request Locked', message: 'Only the requesting coordinator can edit this request. Cancelled and declined requests are closed.', code: 403 });
        }
        if (result === 'allocated') {
            req.flash('error', 'Keep enough slots for workers already assigned. Positions with allocation history need at least one slot.');
            return res.redirect(editUrl);
        }
        if (result === 'invalid-details' || result === 'invalid-positions') {
            req.flash('error', result === 'invalid-details'
                ? 'Enter a valid deployment date, reason, and priority.'
                : 'Enter at least one position quantity from 1 to 100.');
            return res.redirect(editUrl);
        }
        req.flash('success', positionsOnly ? 'Requested positions updated.' : 'Manpower request updated.');
        res.redirect(`/manpower/${req.params.id}${positionsOnly ? '#requested-positions' : ''}`);
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
                const posExists = (await db.prepare('SELECT id FROM positions WHERE id = ? AND is_active = 1').get(posId));
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

    const canManageWarehouse = validateAreaAccess(request.area_id, req);
    if (!canManageWarehouse && !ownsCoordinatorRequest(request, req)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot view requests for other areas.', code: 403 });
    }

    const requestedPositions = (await db.prepare(`
        SELECT mrp.*, p.title as position_title 
        FROM manpower_request_positions mrp
        JOIN positions p ON mrp.position_id = p.id
        WHERE mrp.request_id = ?
    `).all(id));

    const allocations = (await db.prepare(`
        SELECT ma.*, p.title as requested_position_title, mrp.position_id AS requested_position_id,
               CASE WHEN ma.status = 'confirmed' AND e.area_id = ? THEN COALESCE(current_p.title, act_p.title)
                    ELSE act_p.title END AS actual_position_title,
               e.full_name as existing_emp_name, e.employee_id as emp_code, e.area_id as employee_area_id,
               d.name as department_name,
               alloc_user.full_name as allocated_by_name,
               conf_user.full_name as confirmed_by_name
        FROM manpower_allocations ma
        LEFT JOIN manpower_request_positions mrp ON ma.request_position_id = mrp.id
        LEFT JOIN positions p ON mrp.position_id = p.id
        LEFT JOIN positions act_p ON ma.actual_position_id = act_p.id
        LEFT JOIN employees e ON ma.employee_id = e.id
        LEFT JOIN positions current_p ON current_p.id = e.position_id
        LEFT JOIN departments d ON e.department_id = d.id AND d.area_id = e.area_id
        LEFT JOIN users alloc_user ON ma.allocated_by = alloc_user.id
        LEFT JOIN users conf_user ON ma.confirmed_by = conf_user.id
        WHERE ma.request_id = ?
        ORDER BY ma.created_at ASC
    `).all(request.area_id, id));

    const entries = (await db.prepare(`
        SELECT me.*, u.full_name as author_name 
        FROM manpower_request_entries me
        JOIN users u ON me.author_id = u.id
        WHERE me.request_id = ?
        ORDER BY me.created_at ASC
    `).all(id));

    const summary = (await getManpowerSummary(id));
    const positionsList = await db.prepare(`
        SELECT p.* FROM positions p WHERE p.is_active = 1 OR EXISTS (
            SELECT 1 FROM manpower_request_positions mrp WHERE mrp.request_id = ? AND mrp.position_id = p.id
        ) ORDER BY p.title
    `).all(request.id);
    const departments = await db.prepare('SELECT id, name FROM departments WHERE area_id = ? ORDER BY name').all(request.area_id);
    const availableEmployees = (await db.prepare("SELECT id, employee_id, full_name FROM employees WHERE status = 'active' ORDER BY full_name ASC").all());

    res.render('manpower/view', {
        title: `Manpower Request #${request.id} - TAASCOR`,
        request,
        requestedPositions,
        allocations,
        entries,
        summary,
        positionsList,
        availableEmployees,
        departments,
        canManageWarehouse,
        canEdit: canEditRequest(request, req)
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

// POST /manpower/:id/allocate (HR sends a batch of workers)
router.post('/:id/allocate', requireAuth, async (req, res) => {
    const user = req.session.user;
    if (!['HR', 'ADMIN'].includes(user.role)) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'Only HR can assign workers.', code: 403 });
    }

    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.redirect('/manpower');
    const destination = `/manpower/${id}`;
    const db = getDb();
    const submitted = req.body.workers;
    const rows = submitted === undefined ? [req.body] : submitted && typeof submitted === 'object' ? Object.values(submitted) : [];
    if (!rows.length || rows.some(row => !row || typeof row !== 'object')) {
        req.flash('error', 'Add at least one worker.');
        return res.redirect(destination);
    }

    const error = await db.transaction(async () => {
        const request = await db.prepare('SELECT status, requested_by FROM manpower_requests WHERE id = ? FOR UPDATE').get(id);
        if (!request || ['filled', 'declined', 'cancelled'].includes(request.status)) return 'Select an open manpower request.';

        const positions = await db.prepare(`
            SELECT mrp.id, p.title, mrp.quantity_requested,
                   (SELECT COUNT(*) FROM manpower_allocations ma
                    WHERE ma.request_position_id = mrp.id AND ma.status IN ('proposed', 'confirmed')) AS assigned
            FROM manpower_request_positions mrp JOIN positions p ON p.id = mrp.position_id
            WHERE mrp.request_id = ?
        `).all(id);
        const remaining = new Map(positions.map(position => [position.id, {
            title: position.title, count: Number(position.quantity_requested) - Number(position.assigned)
        }]));
        const alreadyAssigned = await db.prepare(`
            SELECT employee_id FROM manpower_allocations
            WHERE request_id = ? AND employee_id IS NOT NULL AND status IN ('proposed', 'confirmed')
        `).all(id);
        const employeeIds = new Set(alreadyAssigned.map(allocation => allocation.employee_id));
        const workers = [];

        for (const [index, row] of rows.entries()) {
            const positionId = Number(row.request_position_id);
            const slot = remaining.get(positionId);
            if (!slot) return `Worker ${index + 1}: select a requested position.`;
            if (slot.count <= 0) return `The batch exceeds the remaining slots for ${slot.title}. Remove a worker or choose another position.`;

            let employeeId = null;
            let name;
            if (row.worker_type === 'existing') {
                employeeId = Number(row.existing_employee_id) || 0;
                if (employeeIds.has(employeeId)) return `Worker ${index + 1}: this employee is already on the request or in this batch.`;
                const employee = await db.prepare("SELECT full_name FROM employees WHERE id = ? AND status = 'active'").get(employeeId);
                if (!employee) return `Worker ${index + 1}: select an active employee.`;
                employeeIds.add(employeeId);
                name = employee.full_name;
            } else if (row.worker_type === 'new' || row.worker_type === undefined) {
                name = typeof row.worker_name === 'string' ? row.worker_name.trim() : '';
                if (!name || name.length > 191) return `Worker ${index + 1}: enter a candidate name of up to 191 characters.`;
            } else {
                return `Worker ${index + 1}: choose a worker source.`;
            }
            slot.count--;
            workers.push({ positionId, employeeId, name });
        }

        const insertAllocation = db.prepare(`
            INSERT INTO manpower_allocations (request_id, request_position_id, employee_id, worker_name, allocated_by, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'proposed', UTC_TIMESTAMP(), UTC_TIMESTAMP())
        `);
        const allocationIds = [];
        for (const worker of workers) {
            const allocation = await insertAllocation.run(id, worker.positionId, worker.employeeId, worker.name, user.id);
            allocationIds.push(allocation.lastInsertRowid);
        }
        const count = workers.length;
        const label = count === 1 ? 'worker' : 'workers';
        await db.prepare(`
            INSERT INTO manpower_request_entries (request_id, author_id, author_role, content, entry_type, created_at)
            VALUES (?, ?, ?, ?, 'allocation', UTC_TIMESTAMP())
        `).run(id, user.id, user.role, `HR sent ${count} ${label} to the coordinator. Awaiting office reports.`);
        await syncRequestStatus(id);
        await createNotification(
            request.requested_by,
            `Workers Assigned to Request #${id}`,
            `HR sent ${count} ${label} for your review upon arrival.`,
            destination,
            `mp-alloc-${allocationIds[0]}`
        );
        await logAction(user.id, 'ALLOCATE_WORKERS', 'manpower_requests', id, { allocationIds });
        return null;
    })();

    if (error) req.flash('error', error);
    else req.flash('success', `Sent ${rows.length} ${rows.length === 1 ? 'worker' : 'workers'}. Awaiting coordinator confirmation.`);
    res.redirect(destination);
});

// POST /manpower/:id/confirm-arrival (Coordinator confirms arrival + sets actual position/schedule)
router.post('/:id/confirm-arrival', requireAuth, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);
    const { allocation_id, status_decision, department_id, actual_position_id, position_change_reason, shift_start, shift_end } = req.body;

    if (!['confirmed', 'did_not_report'].includes(status_decision)) {
        req.flash('error', 'Choose an arrival status.');
        return res.redirect(`/manpower/${id}`);
    }

    const result = await db.transaction(async () => {
        const request = await db.prepare('SELECT * FROM manpower_requests WHERE id = ? FOR UPDATE').get(id);
        if (!request || !validateAreaAccess(request.area_id, req)) return { denied: true };
        if (['cancelled', 'declined'].includes(request.status)) return { error: 'This request is closed.' };

        const alloc = (await db.prepare(`
            SELECT ma.*, mrp.position_id as requested_position_id
            FROM manpower_allocations ma
            LEFT JOIN manpower_request_positions mrp ON ma.request_position_id = mrp.id
            WHERE ma.id = ? AND ma.request_id = ? FOR UPDATE
        `).get(parseInt(allocation_id), id));

        if (!alloc) return { error: 'Worker allocation not found.' };
        if (alloc.status === 'confirmed' || (alloc.status === 'did_not_report' && status_decision === 'did_not_report')) {
            return { error: 'This arrival decision has already been recorded.' };
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
            return { didNotReport: true };
        }

        const department = await db.prepare('SELECT id FROM departments WHERE id = ? AND area_id = ? FOR UPDATE')
            .get(Number(department_id) || 0, request.area_id);
        if (!department) return { error: 'Select a department in this warehouse.' };

        const actualPosId = actual_position_id ? parseInt(actual_position_id) : alloc.requested_position_id;
        if (!await db.prepare('SELECT id FROM positions WHERE id = ? AND (is_active = 1 OR id = ?)').get(actualPosId || 0, alloc.requested_position_id)) {
            return { error: 'Select an active position.' };
        }
        const requester = await db.prepare('SELECT role FROM users WHERE id = ?').get(request.requested_by);
        const coordinatorId = requester?.role === 'COORDINATOR' ? request.requested_by :
            (user.role === 'COORDINATOR' ? user.id : null);
        let employeeId = alloc.employee_id;

        // If incoming worker was not an existing employee record, add to masterfile now!
        if (!employeeId) {
            const year = new Date().getFullYear();
            const empCode = `TAAS-${year}-${require('crypto').randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
            const parts = (alloc.worker_name || 'Worker').trim().split(' ');
            const firstName = parts[0] || 'Worker';
            const lastName = parts.slice(1).join(' ') || 'Employee';

            const empRes = (await db.prepare(`
                INSERT INTO employees (employee_id, first_name, last_name, full_name, area_id, coordinator_id, position_id, department_id, employment_start_date, status, remarks, created_at, updated_at, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)
            `).run(
                empCode,
                firstName,
                lastName,
                alloc.worker_name,
                request.area_id,
                coordinatorId,
                actualPosId,
                department.id,
                request.deployment_date,
                `Deployed via Manpower Request #${id}`,
                user.id
            ));

            employeeId = empRes.lastInsertRowid;
        } else {
            // Update existing employee to this area and coordinator
            (await db.prepare(`
                UPDATE employees
                SET area_id = ?, coordinator_id = ?, position_id = ?, department_id = ?, status = 'active', updated_at = UTC_TIMESTAMP(), updated_by = ?
                WHERE id = ?
            `).run(request.area_id, coordinatorId, actualPosId, department.id, user.id, employeeId));
        }

        // If schedule provided, create initial schedule
        if (shift_start && shift_end) {
            (await db.prepare(`
                INSERT INTO employee_schedules (employee_id, work_date, shift_start, shift_end, is_rest_day, created_by, created_at)
                VALUES (?, ?, ?, ?, 0, ?, UTC_TIMESTAMP())
                ON DUPLICATE KEY UPDATE shift_start = VALUES(shift_start), shift_end = VALUES(shift_end), is_rest_day = VALUES(is_rest_day)
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

        let confirmMsg = `Worker "${alloc.worker_name || 'Candidate'}" reported to the office and is now on the attendance roster.`;
        if (actualPosId !== alloc.requested_position_id) {
            confirmMsg += ` (Position adjusted from requested with reason: ${position_change_reason || 'Operational adjustment'})`;
        }

        (await db.prepare(`
            INSERT INTO manpower_request_entries (request_id, author_id, author_role, content, entry_type, created_at)
            VALUES (?, ?, ?, ?, 'system', UTC_TIMESTAMP())
        `).run(id, user.id, user.role, confirmMsg));

        (await syncRequestStatus(id));
        return { allocationId: alloc.id, employeeId, actualPosId, confirmMsg };
    })();

    if (result.denied) {
        return res.status(403).render('error', { title: 'Access Denied', message: 'Access denied.', code: 403 });
    }
    if (result.error || result.didNotReport) {
        req.flash(result.error ? 'error' : 'warning', result.error || 'Worker marked as Did Not Report.');
        return res.redirect(`/manpower/${id}`);
    }
    const { allocationId, employeeId, actualPosId, confirmMsg } = result;

    (await notifyHR(
        `Worker Arrival Confirmed: Request #${id}`,
        `Coordinator confirmed arrival of worker for Request #${id}.`,
        `/manpower/${id}`,
        `mp-conf-${id}-${Date.now()}`
    ));

    (await logAction(user.id, 'CONFIRM_WORKER_ARRIVAL', 'manpower_allocations', allocationId, {
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
  const request=await db.prepare('SELECT id,status,requested_by FROM manpower_requests WHERE id=? FOR UPDATE').get(id);
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
