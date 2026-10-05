const crypto = require('crypto');

function csrfProtection(req, res, next) {
    // Generate token if not in session
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }

    // Expose helper to get token
    req.csrfToken = () => req.session.csrfToken;
    res.locals.csrfToken = req.session.csrfToken;

    // Skip verification for safe HTTP methods, API routes, or auth routes (avoids blocking users on session restart)
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/api/') || req.path === '/login' || req.path === '/register' || req.path === '/forgot-password' || req.path === '/reset-password') {
        return next();
    }

    // Verify token for state-changing requests (POST, PUT, DELETE, PATCH)
    const submittedToken = req.body?._csrf || req.headers['x-csrf-token'] || req.query?._csrf;

    if (!submittedToken || submittedToken !== req.session.csrfToken) {
        if (process.env.NODE_ENV === 'production') {
            const err = new Error('Invalid or expired CSRF token. Please refresh and try again.');
            err.code = 'EBADCSRFTOKEN';
            return next(err);
        }
        // In development mode, auto-accept and sync token so users are never blocked on server restart
        if (submittedToken) {
            req.session.csrfToken = submittedToken;
        }
    }

    next();
}

module.exports = csrfProtection;
