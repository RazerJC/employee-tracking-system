// Authentication middleware
const { requireArea } = require('./area-guard');

async function requireAuth(req, res, next) {
    if (!req.session.user) {
        req.flash('error', 'Please log in to continue.');
        return res.redirect('/login');
    }
    
    // Check if user is still active
    const { getDb } = require('../db/database');
    const db = getDb();
    const user = (await db.prepare('SELECT status, role, must_change_password FROM users WHERE id = ?').get(req.session.user.id));
    
    if (!user || user.status !== 'active') {
        req.session.destroy();
        return res.redirect('/login?suspended=1');
    }
    
    if (user.must_change_password) return res.redirect('/change-password');

    // Update session role in case admin changed it
    req.session.user.role = user.role;
    res.locals.user = req.session.user;
    
    return requireArea(req, res, next);
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session.user) {
            req.flash('error', 'Please log in to continue.');
            return res.redirect('/login');
        }
        
        if (!roles.includes(req.session.user.role)) {
            return res.status(403).render('error', {
                title: 'Access Denied',
                message: 'You do not have permission to access this page.',
                code: 403
            });
        }
        
        next();
    };
}

function requirePendingOrActive(req, res, next) {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    next();
}

module.exports = { requireAuth, requireRole, requirePendingOrActive };
