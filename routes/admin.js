const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { logAction, getAuditLogs } = require('../services/audit');
const { sendAccountApprovedEmail } = require('../services/email');
const { createNotification } = require('../services/notification');

// Middleware to ensure HR or ADMIN
function requireAdminOrHR(req, res, next) {
    if (req.session.user?.role !== 'ADMIN' && req.session.user?.role !== 'HR') {
        return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to access management features.', code: 403 });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (req.session.user?.role !== 'ADMIN') {
        return res.status(403).render('error', { title: 'Access Denied', message: 'This page is restricted to Administrators only.', code: 403 });
    }
    next();
}

// GET /admin/pending-coordinators (HR & ADMIN)
router.get('/pending-coordinators', requireAuth, requireAdminOrHR, async (req, res) => {
    const db = getDb();
    const pendingList = (await db.prepare(`
        SELECT * FROM users 
        WHERE role = 'COORDINATOR' AND status = 'pending'
        ORDER BY created_at ASC
    `).all());

    const areas = (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all());

    res.render('admin/pending-coordinators', {
        title: 'Pending Coordinator Registrations - TAASCOR',
        pendingList,
        areas
    });
});

// POST /admin/approve-coordinator (HR & ADMIN: Assign area and activate)
router.post('/approve-coordinator', requireAuth, requireAdminOrHR, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const { user_id, area_id, remarks } = req.body;

    if (!user_id || !area_id) {
        req.flash('error', 'You must assign the coordinator to an area or warehouse before approving.');
        return res.redirect('/admin/pending-coordinators');
    }

    const coordinator = (await db.prepare('SELECT * FROM users WHERE id = ? AND role = "COORDINATOR"').get(parseInt(user_id)));
    if (!coordinator) {
        req.flash('error', 'Coordinator not found.');
        return res.redirect('/admin/pending-coordinators');
    }

    const area = (await db.prepare('SELECT * FROM areas WHERE id = ?').get(parseInt(area_id)));

    // End any existing assignment
    (await db.prepare(`
        UPDATE coordinator_area_assignments 
        SET is_current = 0, ended_at = UTC_TIMESTAMP() 
        WHERE user_id = ? AND is_current = 1
    `).run(coordinator.id));

    // Insert new assignment
    (await db.prepare(`
        INSERT INTO coordinator_area_assignments (user_id, area_id, assigned_by, assigned_at, is_current, remarks)
        VALUES (?, ?, ?, UTC_TIMESTAMP(), 1, ?)
    `).run(coordinator.id, area.id, user.id, remarks ? remarks.trim() : null));

    // Update user status to active
    (await db.prepare(`
        UPDATE users 
        SET status = 'active', approved_by = ?, approved_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()
        WHERE id = ?
    `).run(user.id, coordinator.id));

    (await logAction(user.id, 'APPROVE_COORDINATOR', 'users', coordinator.id, {
        area_id: area.id,
        area_name: area.name,
        remarks
    }));

    (await createNotification(
        coordinator.id,
        'Account Approved!',
        `Your coordinator registration has been approved. You are assigned to: ${area.name}.`,
        '/dashboard'
    ));

    try {
        await sendAccountApprovedEmail(coordinator.email, coordinator.full_name);
    } catch (e) {
        console.error('Email error:', e.message);
    }

    req.flash('success', `Coordinator ${coordinator.full_name} approved and assigned to ${area.name}.`);
    res.redirect('/admin/pending-coordinators');
});

// POST /admin/reject-coordinator (HR & ADMIN)
router.post('/reject-coordinator', requireAuth, requireAdminOrHR, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const { user_id, rejection_remarks } = req.body;

    if (!user_id || !rejection_remarks) {
        req.flash('error', 'Please provide rejection remarks.');
        return res.redirect('/admin/pending-coordinators');
    }

    (await db.prepare(`
        UPDATE users 
        SET status = 'rejected', rejection_remarks = ?, updated_at = UTC_TIMESTAMP()
        WHERE id = ?
    `).run(rejection_remarks.trim(), parseInt(user_id)));

    (await logAction(user.id, 'REJECT_COORDINATOR', 'users', parseInt(user_id), { remarks: rejection_remarks }));

    req.flash('success', 'Coordinator registration rejected.');
    res.redirect('/admin/pending-coordinators');
});

// POST /admin/reassign-coordinator (HR & ADMIN)
router.post('/reassign-coordinator', requireAuth, requireAdminOrHR, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const { user_id, new_area_id, remarks } = req.body;

    if (!user_id || !new_area_id) {
        req.flash('error', 'Please specify coordinator and new area.');
        return res.redirect('back');
    }

    const coordId = parseInt(user_id);
    const newArea = (await db.prepare('SELECT * FROM areas WHERE id = ?').get(parseInt(new_area_id)));

    // End previous assignment while preserving history
    (await db.prepare(`
        UPDATE coordinator_area_assignments 
        SET is_current = 0, ended_at = UTC_TIMESTAMP() 
        WHERE user_id = ? AND is_current = 1
    `).run(coordId));

    // Create new assignment
    (await db.prepare(`
        INSERT INTO coordinator_area_assignments (user_id, area_id, assigned_by, assigned_at, is_current, remarks)
        VALUES (?, ?, ?, UTC_TIMESTAMP(), 1, ?)
    `).run(coordId, newArea.id, user.id, remarks ? remarks.trim() : 'Reassigned by HR'));

    (await logAction(user.id, 'REASSIGN_COORDINATOR', 'coordinator_area_assignments', null, {
        coordinator_id: coordId,
        new_area: newArea.name
    }));

    (await createNotification(
        coordId,
        'Assignment Updated',
        `Your assigned area has been updated to: ${newArea.name}.`,
        '/dashboard'
    ));

    req.flash('success', `Coordinator reassigned to ${newArea.name}. History preserved.`);
    res.redirect('back');
});

// GET /admin/users (ADMIN only)
router.get('/users', requireAuth, requireAdmin, async (req, res) => {
    const db = getDb();
    const users = (await db.prepare(`
        SELECT u.*, a.name as current_area_name, caa.assigned_at as area_assigned_at
        FROM users u
        LEFT JOIN coordinator_area_assignments caa ON caa.user_id = u.id AND caa.is_current = 1
        LEFT JOIN areas a ON caa.area_id = a.id
        ORDER BY u.created_at DESC
    `).all());

    const areas = (await db.prepare('SELECT * FROM areas WHERE is_active = 1 ORDER BY name ASC').all());

    res.render('admin/users', {
        title: 'User Management - TAASCOR',
        users,
        areas
    });
});

// POST /admin/create-user (ADMIN only) — creates COORDINATOR, HR, HEAD_HR, or ADMIN
async function handleCreateUser(req, res) {
    const admin = req.session.user;
    const db = getDb();
    const { email, password, full_name, role, area_id } = req.body;

    if (!email || !password || !full_name) {
        req.flash('error', 'All required fields must be filled.');
        return res.redirect('/admin/users');
    }

    const allowedRoles = ['COORDINATOR', 'HR', 'HEAD_HR', 'ADMIN'];
    const assignedRole = allowedRoles.includes(role) ? role : 'HR';

    const trimmedInput = email.trim().toLowerCase();
    const candidateEmail = trimmedInput.includes('@') ? trimmedInput : `${trimmedInput}@taascor.com`;

    const existing = (await db.prepare('SELECT id FROM users WHERE email = ? OR email = ?').get(trimmedInput, candidateEmail));
    if (existing) {
        req.flash('error', 'An account with that email already exists.');
        return res.redirect('/admin/users');
    }

    const hash = bcrypt.hashSync(password, 12);

    const result = (await db.prepare(`
        INSERT INTO users (email, password_hash, full_name, role, status, email_verified, must_change_password, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', 1, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())
    `).run(candidateEmail, hash, full_name.trim(), assignedRole));

    const newUserId = result.lastInsertRowid;

    // If coordinator, assign warehouse
    if (assignedRole === 'COORDINATOR') {
        let targetAreaId = area_id ? parseInt(area_id) : null;
        if (!targetAreaId) {
            const firstArea = await db.prepare('SELECT id FROM areas WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
            if (firstArea) targetAreaId = firstArea.id;
        }

        if (targetAreaId) {
            await db.prepare(`
                INSERT INTO coordinator_area_assignments (user_id, area_id, assigned_by, assigned_at, is_current, remarks)
                VALUES (?, ?, ?, UTC_TIMESTAMP(), 1, 'Assigned by Administrator')
            `).run(newUserId, targetAreaId, admin.id);
        }
    }

    (await logAction(admin.id, 'CREATE_USER', 'users', newUserId, { email: candidateEmail, role: assignedRole }));

    req.flash('success', `${assignedRole} account created for ${full_name} (${candidateEmail}). Ready for immediate login.`);
    res.redirect('/admin/users');
}

router.post('/create-user', requireAuth, requireAdmin, handleCreateUser);
router.post('/create-hr', requireAuth, requireAdmin, handleCreateUser);

// POST /admin/users/:id/toggle-status (ADMIN only)
router.post('/users/:id/toggle-status', requireAuth, requireAdmin, async (req, res) => {
    const admin = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);

    if (id === admin.id) {
        req.flash('error', 'You cannot suspend your own admin account.');
        return res.redirect('/admin/users');
    }

    const targetUser = (await db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    if (!targetUser) {
        req.flash('error', 'User not found.');
        return res.redirect('/admin/users');
    }

    const newStatus = targetUser.status === 'active' ? 'suspended' : 'active';
    (await db.prepare("UPDATE users SET status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?").run(newStatus, id));

    (await logAction(admin.id, 'TOGGLE_USER_STATUS', 'users', id, { newStatus }));

    req.flash('success', `User ${targetUser.full_name} is now ${newStatus}.`);
    res.redirect('/admin/users');
});

// GET /admin/areas (ADMIN & HR)
router.get('/areas', requireAuth, requireAdminOrHR, async (req, res) => {
    const db = getDb();
    const areas = (await db.prepare(`
        SELECT a.*,
               (SELECT COUNT(*) FROM employees WHERE area_id = a.id AND status = 'active') as active_workers,
               (SELECT GROUP_CONCAT(u.full_name, ', ') FROM coordinator_area_assignments caa JOIN users u ON caa.user_id = u.id WHERE caa.area_id = a.id AND caa.is_current = 1) as current_coordinator
        FROM areas a
        ORDER BY a.name ASC
    `).all());

    res.render('admin/areas', {
        title: 'Warehouses & Areas - TAASCOR',
        areas
    });
});

// POST /admin/areas
router.post('/areas', requireAuth, requireAdminOrHR, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const { name, description } = req.body;

    if (!name || !name.trim()) {
        req.flash('error', 'Area name is required.');
        return res.redirect('/admin/areas');
    }

    try {
        (await db.prepare(`
            INSERT INTO areas (name, description, is_active, created_at, created_by)
            VALUES (?, ?, 1, UTC_TIMESTAMP(), ?)
        `).run(name.trim(), description ? description.trim() : null, user.id));

        (await logAction(user.id, 'CREATE_AREA', 'areas', null, { name: name.trim() }));
        req.flash('success', `Area "${name.trim()}" added successfully.`);
    } catch (e) {
        req.flash('error', 'An area with this name already exists.');
    }

    res.redirect('/admin/areas');
});

// GET /admin/positions (ADMIN & HR)
router.get('/positions', requireAuth, requireAdminOrHR, async (req, res) => {
    const db = getDb();
    const positions = (await db.prepare(`
        SELECT p.*, (SELECT COUNT(*) FROM employees WHERE position_id = p.id AND status = 'active') as active_workers
        FROM positions p
        ORDER BY p.title ASC
    `).all());

    res.render('admin/positions', {
        title: 'Positions - TAASCOR',
        positions
    });
});

// POST /admin/positions
router.post('/positions', requireAuth, requireAdminOrHR, async (req, res) => {
    const user = req.session.user;
    const db = getDb();
    const { title, description } = req.body;

    if (!title || !title.trim()) {
        req.flash('error', 'Position title is required.');
        return res.redirect('/admin/positions');
    }

    try {
        (await db.prepare(`
            INSERT INTO positions (title, description, is_active, created_at, created_by)
            VALUES (?, ?, 1, UTC_TIMESTAMP(), ?)
        `).run(title.trim(), description ? description.trim() : null, user.id));

        (await logAction(user.id, 'CREATE_POSITION', 'positions', null, { title: title.trim() }));
        req.flash('success', `Position "${title.trim()}" added successfully.`);
    } catch (e) {
        req.flash('error', 'A position with this title already exists.');
    }

    res.redirect('/admin/positions');
});

// GET /admin/audit-logs (ADMIN only)
router.get('/audit-logs', requireAuth, requireAdmin, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    const filters = {
        action: req.query.action || '',
        entityType: req.query.entity_type || '',
        dateFrom: req.query.date_from || '',
        dateTo: req.query.date_to || ''
    };

    const { logs, total } = (await getAuditLogs(filters, limit, offset));
    const totalPages = Math.ceil(total / limit);

    res.render('admin/audit-logs', {
        title: 'Audit Logs - TAASCOR',
        logs,
        total,
        page,
        totalPages,
        filters
    });
});

// POST /admin/users/:id/reset-password (ADMIN only)
router.post('/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
    const admin = req.session.user;
    const db = getDb();
    const id = parseInt(req.params.id);
    const { new_password, confirm_password } = req.body;

    if (!new_password || new_password !== confirm_password) {
        req.flash('error', 'Passwords do not match.');
        return res.redirect('/admin/users');
    }

    if (new_password.length < 8) {
        req.flash('error', 'Password must be at least 8 characters long.');
        return res.redirect('/admin/users');
    }

    const targetUser = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!targetUser) {
        req.flash('error', 'User not found.');
        return res.redirect('/admin/users');
    }

    const hash = bcrypt.hashSync(new_password, 12);
    await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = UTC_TIMESTAMP() WHERE id = ?').run(hash, id);

    await logAction(admin.id, 'ADMIN_RESET_PASSWORD', 'users', id, { target_email: targetUser.email });

    req.flash('success', `Password for ${targetUser.full_name} (${targetUser.email}) has been reset successfully.`);
    res.redirect('/admin/users');
});

router.get('/staff/:id', requireAuth, requireAdmin, async (req,res) => {
 const db=getDb();
 const staff=await db.prepare("SELECT id,full_name,email,role,status,phone,bio,profile_photo,created_at,last_login_at FROM users WHERE id=? AND role IN ('HR','HEAD_HR','COORDINATOR')").get(Number(req.params.id)||0);
 if(!staff) return res.status(404).render('error',{title:'Staff not found',message:'Staff account not found.',code:404});
 const attendance=await db.prepare('SELECT work_date,time_in,time_out FROM coordinator_attendance WHERE user_id=? ORDER BY work_date DESC LIMIT 30').all(staff.id);
 const activities=await db.prepare('SELECT action,entity_type,entity_id,created_at FROM audit_logs WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 50').all(staff.id);
 res.render('admin/staff-profile',{title:'Staff Profile - TAASCOR',staff,attendance,activities});
});
module.exports = router;
