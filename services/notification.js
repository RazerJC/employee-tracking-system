// Notification service
const { getDb } = require('../db/database');

async function createNotification(userId, title, message, link = null, dedupKey = null) {
    const db = getDb();
    
    // Check for duplicate if dedup key provided
    if (dedupKey) {
        const existing = (await db.prepare(
            'SELECT id FROM notifications WHERE dedup_key = ?'
        ).get(dedupKey));
        if (existing) return existing.id;
    }
    
    const result = (await db.prepare(
        `INSERT INTO notifications (user_id, title, message, link, dedup_key, created_at) 
         VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())`
    ).run(userId, title, message, link, dedupKey));
    
    return result.lastInsertRowid;
}

async function notifyRole(role, title, message, link = null, dedupKey = null) {
    const db = getDb();
    const users = (await db.prepare('SELECT id FROM users WHERE role = ? AND status = ?').all(role, 'active'));
    
    for (const user of users) {
        const key = dedupKey ? `${dedupKey}-${user.id}` : null;
        (await createNotification(user.id, title, message, link, key));
    }
}

async function notifyHR(title, message, link = null, dedupKey = null) {
    (await notifyRole('HR', title, message, link, dedupKey));
    (await notifyRole('ADMIN', title, message, link, dedupKey));
}

async function getUnreadCount(userId) {
    const db = getDb();
    const result = (await db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0').get(userId));
    return result.count;
}

async function getNotifications(userId, limit = 20, offset = 0) {
    const db = getDb();
    return (await db.prepare(
        `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(userId, limit, offset));
}

async function markAsRead(notificationId, userId) {
    const db = getDb();
    (await db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(notificationId, userId));
}

async function markAllAsRead(userId) {
    const db = getDb();
    (await db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId));
}

async function getMenuGlow(user) {
    if (!user) return {};
    const db = getDb();
    const glow = {
        '/btw': 0,
        '/concerns': 0,
        '/manpower': 0,
        '/incidents': 0,
        '/admin/pending-coordinators': 0,
        '/coordinator-attendance': 0,
        '/attendance': 0,
        '/schedules': 0,
        '/employees': 0,
        '/departments': 0
    };

    try {
        // 1. Unread notifications categorized by target link
        const unreadRows = (await db.prepare(
            'SELECT link, COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0 GROUP BY link'
        ).all(user.id));

        for (const row of unreadRows) {
            if (!row.link) continue;
            for (const key of Object.keys(glow)) {
                if (row.link.startsWith(key)) {
                    glow[key] += Number(row.count) || 0;
                    break;
                }
            }
        }

        // 2. Role-specific actionable pending counts for HR and ADMIN
        if (user.role === 'HR' || user.role === 'ADMIN' || user.role === 'HEAD_HR') {
            const pendingBtw = (await db.prepare(
                "SELECT COUNT(*) as c FROM btw_cases WHERE status IN ('pending_hr_review', 'for_clarification')"
            ).get());
            if (pendingBtw && pendingBtw.c > 0) {
                glow['/btw'] = Math.max(glow['/btw'], Number(pendingBtw.c));
            }

            const pendingCoordinators = (await db.prepare(
                "SELECT COUNT(*) as c FROM users WHERE role = 'COORDINATOR' AND status = 'pending'"
            ).get());
            if (pendingCoordinators && pendingCoordinators.c > 0) {
                glow['/admin/pending-coordinators'] = Math.max(glow['/admin/pending-coordinators'], Number(pendingCoordinators.c));
            }

            const openConcerns = (await db.prepare(
                "SELECT COUNT(*) as c FROM concern_reports WHERE status = 'open'"
            ).get());
            if (openConcerns && openConcerns.c > 0) {
                glow['/concerns'] = Math.max(glow['/concerns'], Number(openConcerns.c));
            }

            const pendingManpower = (await db.prepare(
                "SELECT COUNT(*) as c FROM manpower_requests WHERE status = 'pending' OR status = 'submitted'"
            ).get());
            if (pendingManpower && pendingManpower.c > 0) {
                glow['/manpower'] = Math.max(glow['/manpower'], Number(pendingManpower.c));
            }

            const activeIncidents = (await db.prepare(
                "SELECT COUNT(*) as c FROM incident_reports WHERE status IN ('reported', 'under_investigation')"
            ).get());
            if (activeIncidents && activeIncidents.c > 0) {
                glow['/incidents'] = Math.max(glow['/incidents'], Number(activeIncidents.c));
            }
        } else if (user.role === 'COORDINATOR') {
            const coordinatorAreaId = user.area_id;
            if (coordinatorAreaId) {
                const clarificationBtw = (await db.prepare(
                    "SELECT COUNT(*) as c FROM btw_cases WHERE area_id = ? AND status = 'for_clarification'"
                ).get(coordinatorAreaId));
                if (clarificationBtw && clarificationBtw.c > 0) {
                    glow['/btw'] = Math.max(glow['/btw'], Number(clarificationBtw.c));
                }
            }
        }
    } catch (err) {
        console.error('Error fetching menu glow:', err.message);
    }

    return glow;
}

module.exports = { createNotification, notifyRole, notifyHR, getUnreadCount, getNotifications, markAsRead, markAllAsRead, getMenuGlow };
