// Area guard middleware - ensures coordinators can only access their assigned area's data
const { getDb } = require('../db/database');

async function getCoordinatorAreaId(userId) {
    const db = getDb();
    const assignment = (await db.prepare(
        'SELECT area_id FROM coordinator_area_assignments WHERE user_id = ? AND is_current = 1'
    ).get(userId));
    return assignment ? assignment.area_id : null;
}

// Middleware: attach current area to request for coordinators
async function attachArea(req, res, next) {
    if (!req.session.user) return next();
    
    if (req.session.user.role === 'COORDINATOR') {
        let areaId = (await getCoordinatorAreaId(req.session.user.id));
        const db = getDb();

        if (!areaId) {
            try {
                const firstArea = (await db.prepare('SELECT id FROM areas WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get());
                if (firstArea) {
                    await db.prepare(`
                        INSERT INTO coordinator_area_assignments (user_id, area_id, assigned_by, assigned_at, is_current, remarks)
                        VALUES (?, ?, ?, UTC_TIMESTAMP(), 1, 'Auto-assigned default warehouse')
                    `).run(req.session.user.id, firstArea.id, req.session.user.id);
                    areaId = firstArea.id;
                }
            } catch (e) {
                console.error('[AREA-GUARD] Error assigning default area:', e.message);
            }
        }

        req.userAreaId = areaId;
        res.locals.userAreaId = areaId;
        
        if (areaId) {
            const area = (await db.prepare('SELECT * FROM areas WHERE id = ?').get(areaId));
            req.userArea = area;
            res.locals.userArea = area;
        }
    } else {
        // HR, HEAD_HR, and ADMIN can see all areas
        req.userAreaId = null;
        res.locals.userAreaId = null;
    }
    
    next();
}

// Middleware: require coordinator to have an assigned area
async function requireArea(req, res, next) {
    if (req.session.user && req.session.user.role === 'COORDINATOR') {
        if (!req.userAreaId) {
            const db = getDb();
            const firstArea = (await db.prepare('SELECT id FROM areas WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get());
            if (firstArea) {
                req.userAreaId = firstArea.id;
                res.locals.userAreaId = firstArea.id;
            }
        }
    }
    next();
}

// Validate that an entity belongs to the coordinator's area
function validateAreaAccess(areaId, req) {
    if (req.session.user.role === 'COORDINATOR') {
        return parseInt(areaId) === parseInt(req.userAreaId);
    }
    // HR and ADMIN can access any area
    return true;
}

// Get area filter for queries - returns area_id for coordinators, null for HR/ADMIN
function getAreaFilter(req) {
    if (req.session.user.role === 'COORDINATOR') {
        return req.userAreaId;
    }
    return null;
}

module.exports = { attachArea, requireArea, validateAreaAccess, getAreaFilter, getCoordinatorAreaId };
