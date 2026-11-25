const { getDb } = require('../db/database');
const { DateTime } = require('luxon');

/**
 * Calculates summary metrics for a manpower request
 */
async function getManpowerSummary(requestId) {
    const db = getDb();
    
    // Total requested
    const totalRequested = (await db.prepare(`
        SELECT COALESCE(SUM(quantity_requested), 0) as total 
        FROM manpower_request_positions 
        WHERE request_id = ?
    `).get(requestId)).total;

    // Allocations count
    const allocStats = (await db.prepare(`
        SELECT 
            COUNT(*) as total_alloc,
            SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END) as proposed_count,
            SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_count,
            SUM(CASE WHEN status = 'did_not_report' THEN 1 ELSE 0 END) as no_show_count
        FROM manpower_allocations 
        WHERE request_id = ?
    `).get(requestId));

    const confirmed = allocStats.confirmed_count || 0;
    const proposed = allocStats.proposed_count || 0;
    const remaining = Math.max(0, totalRequested - confirmed);

    return {
        totalRequested,
        proposed,
        confirmed,
        noShow: allocStats.no_show_count || 0,
        remaining
    };
}

/**
 * Automatically updates request status based on confirmation numbers
 */
async function syncRequestStatus(requestId) {
    const db = getDb();
    const req = (await db.prepare(`SELECT status FROM manpower_requests WHERE id = ?`).get(requestId));
    if (!req || ['declined', 'cancelled'].includes(req.status)) {
        return;
    }

    const summary = (await getManpowerSummary(requestId));

    let newStatus = req.status;
    if (summary.totalRequested > 0) {
        if (summary.confirmed >= summary.totalRequested) {
            newStatus = 'filled';
        } else if (summary.confirmed > 0 || summary.proposed > 0) {
            newStatus = 'partially_filled';
        } else if (newStatus !== 'under_review') {
            newStatus = 'submitted';
        }
    }

    if (newStatus !== req.status) {
        (await db.prepare(`
            UPDATE manpower_requests 
            SET status = ?, updated_at = UTC_TIMESTAMP() 
            WHERE id = ?
        `).run(newStatus, requestId));
    }
}

async function getManpowerDashboard(db, areaId) {
    const today = DateTime.now().setZone('Asia/Manila').startOf('day');
    const since = today.minus({ days: 6 });
    const areaFilter = areaId ? 'AND mr.area_id = ?' : '';
    const areaParams = areaId ? [areaId] : [];
    const [requests, deployments] = await Promise.all([
        db.prepare(`
            SELECT mr.id, mr.status, mr.deployment_date, a.name AS area_name, u.full_name AS coordinator_name,
                   (SELECT COALESCE(SUM(p.quantity_requested), 0)
                    FROM manpower_request_positions p WHERE p.request_id = mr.id) AS requested,
                   (SELECT COUNT(*) FROM manpower_allocations ma
                    WHERE ma.request_id = mr.id AND ma.status = 'confirmed') AS confirmed
            FROM manpower_requests mr
            JOIN areas a ON a.id = mr.area_id
            JOIN users u ON u.id = mr.requested_by
            WHERE 1 = 1 ${areaFilter}
            ORDER BY CASE WHEN mr.status IN ('filled', 'declined', 'cancelled') THEN 1 ELSE 0 END,
                     mr.deployment_date DESC, mr.id DESC
        `).all(...areaParams),
        db.prepare(`
            SELECT a.name AS area_name, d.name AS department_name,
                   COUNT(*) AS confirmed, MAX(ma.confirmed_at) AS latest_confirmation
            FROM manpower_allocations ma
            JOIN manpower_requests mr ON mr.id = ma.request_id
            JOIN areas a ON a.id = mr.area_id
            LEFT JOIN employees e ON e.id = ma.employee_id AND e.area_id = mr.area_id
            LEFT JOIN departments d ON d.id = e.department_id AND d.area_id = mr.area_id
            WHERE ma.status = 'confirmed' AND ma.confirmed_at >= ? AND ma.confirmed_at < ? ${areaFilter}
            GROUP BY a.id, a.name, d.id, d.name
            ORDER BY latest_confirmation DESC, a.name, d.name
        `).all(since.toUTC().toSQL({ includeOffset: false }), today.plus({ days: 1 }).toUTC().toSQL({ includeOffset: false }), ...areaParams)
    ]);

    return {
        deployments,
        requests: requests.map(request => {
            const requested = Number(request.requested);
            const confirmed = Number(request.confirmed);
            const closed = ['declined', 'cancelled'].includes(request.status);
            const percentage = requested ? Math.min(100, Math.floor(confirmed / requested * 1000) / 10) : null;
            return {
                ...request, requested, confirmed, percentage,
                outcome: closed ? (request.status === 'declined' ? 'Declined' : 'Cancelled') :
                    !requested ? 'No target' : confirmed >= requested ? 'Target met' : 'Target not met'
            };
        })
    };
}

module.exports = { getManpowerSummary, syncRequestStatus, getManpowerDashboard };
