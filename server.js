require('dotenv').config();
require('express-async-errors');
const express = require('express');
const path = require('path');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { initializeDb, getDb, closeDb } = require('./db/database');
const { createSessionStore } = require('./db/session-store');
const { createInitialAdmin } = require('./db/seed');
const { DateTime } = require('luxon');
const csrfProtection = require('./middleware/csrf');
const { attachArea } = require('./middleware/area-guard');
const { getMenuGlow } = require('./services/notification');

const app = express();
const PORT = process.env.PORT || 3000;

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32 || sessionSecret.startsWith('change-this')) {
    throw new Error('SESSION_SECRET must be a random value of at least 32 characters.');
}
const sessionStore = createSessionStore();

// Body parsing (support image upload)
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Trust proxy for production (Render, Heroku, etc.)
app.set('trust proxy', 1);

// Health check & legacy compatibility (before CSRF and session)
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() }));
app.get(/^\/ATTENDANCE\/health\.php$/, (req, res) => res.status(200).send('OK'));
app.get(/^\/ATTENDANCE(?:\/.*)?$/, (req, res) => res.redirect('/dashboard'));
app.get('/', (req, res) => res.redirect('/dashboard'));

// Session
app.use(session({
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 8 * 60 * 60 * 1000, // 8 hours
        sameSite: 'lax'
    },
    name: 'taascor.sid'
}));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Global template variables & Area attachment
app.use(async (req, res, next) => {
    if (req.session.user) {
        try {
            const db = getDb();
            const freshUser = (await db.prepare('SELECT id, email, full_name, role, status, profile_photo, phone, bio FROM users WHERE id = ?').get(req.session.user.id));
            if (freshUser) {
                req.session.user.full_name = freshUser.full_name;
                req.session.user.profile_photo = freshUser.profile_photo;
                req.session.user.phone = freshUser.phone;
                req.session.user.bio = freshUser.bio;
            }
        } catch (e) {}
    }
    res.locals.user = req.session.user || null;
    res.locals.currentPath = req.path;
    res.locals.DateTime = DateTime;
    res.locals.needsCoordinatorTimeIn = false;
    if (req.method === 'GET' && req.session.user?.role === 'COORDINATOR' && !req.path.startsWith('/api/')) {
        try {
            const workDate = DateTime.now().setZone('Asia/Manila').toISODate();
            const record = await getDb().prepare('SELECT time_in FROM coordinator_attendance WHERE user_id = ? AND work_date = ?').get(req.session.user.id, workDate);
            res.locals.needsCoordinatorTimeIn = !record?.time_in;
        } catch (error) {
            console.error('Unable to check coordinator time-in:', error.message);
        }
    }
    
    res.locals.formatDate = (dateStr) => {
        if (!dateStr) return '—';
        try {
            const str = String(dateStr).trim();
            let dt = str.includes('T')
                ? DateTime.fromISO(str, { zone: 'utc' })
                : DateTime.fromSQL(str, { zone: 'utc' });
            if (!dt.isValid) {
                dt = DateTime.fromISO(str.replace(' ', 'T'), { zone: 'utc' });
            }
            return dt.isValid ? dt.setZone('Asia/Manila').toFormat('MMM dd, yyyy') : str;
        } catch (e) {
            return dateStr;
        }
    };

    res.locals.formatDateTime = (dateStr) => {
        if (!dateStr) return '—';
        try {
            const str = String(dateStr).trim();
            let dt = str.includes('T')
                ? DateTime.fromISO(str, { zone: 'utc' })
                : DateTime.fromSQL(str, { zone: 'utc' });
            if (!dt.isValid) {
                dt = DateTime.fromISO(str.replace(' ', 'T'), { zone: 'utc' });
            }
            return dt.isValid ? dt.setZone('Asia/Manila').toFormat('MMM dd, yyyy HH:mm') : str;
        } catch (e) {
            return dateStr;
        }
    };

    res.locals.formatTime = (timeStr) => {
        if (!timeStr) return '—';
        try {
            const str = String(timeStr).trim();
            if (/am|pm/i.test(str)) {
                let dt = DateTime.fromFormat(str, 'h:mm a');
                if (!dt.isValid) dt = DateTime.fromFormat(str, 'hh:mm a');
                if (dt.isValid) return dt.toFormat('HH:mm');
            }
            const parts = str.split(':');
            const h = parseInt(parts[0], 10);
            const m = parts[1] ? String(parts[1]).slice(0, 2).padStart(2, '0') : '00';
            if (isNaN(h)) return str;
            const h24 = String(h).padStart(2, '0');
            return `${h24}:${m}`;
        } catch (e) {
            return timeStr;
        }
    };

    // Flash messages
    res.locals.flash = req.session.flash || {};
    delete req.session.flash;

    // Unread notifications & menu lighting highlights
    if (req.session.user) {
        try {
            const db = getDb();
            const result = (await db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0').get(req.session.user.id));
            res.locals.unreadCount = result ? result.count : 0;
            res.locals.menuGlow = await getMenuGlow(req.session.user);
        } catch (e) {
            res.locals.unreadCount = 0;
            res.locals.menuGlow = {};
        }
    } else {
        res.locals.unreadCount = 0;
        res.locals.menuGlow = {};
    }

    next();
});

// Flash message helper
app.use((req, res, next) => {
    req.flash = (type, message) => {
        req.session.flash = req.session.flash || {};
        req.session.flash[type] = message;
    };
    next();
});

// Area guard attaches current area for coordinators
app.use(attachArea);

// CSRF Protection
app.use(csrfProtection);

// Mount Routes
app.use('/', require('./routes/auth'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/employees', require('./routes/employees'));
app.use('/schedules', require('./routes/schedules'));
app.use('/attendance', require('./routes/attendance'));
app.use('/coordinator-attendance', require('./routes/coordinator-attendance'));
app.use('/concerns', require('./routes/concerns'));
app.use('/btw', require('./routes/btw'));
app.use('/manpower', require('./routes/manpower'));
app.use('/notifications', require('./routes/notifications'));
app.use('/admin', require('./routes/admin'));
app.use('/departments', require('./routes/departments'));
app.use('/reports', require('./routes/reports'));
app.use('/api', require('./routes/api'));

// 404 handler
app.use((req, res) => {
    res.status(404).render('error', {
        title: 'Page Not Found',
        message: 'The page you are looking for does not exist.',
        code: 404
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error(err);

    if (err.code === 'EBADCSRFTOKEN') {
        req.flash('error', 'Form session expired or invalid CSRF token. Please try again.');
        const fallback = req.get('Referrer') || '/';
        return res.redirect(fallback);
    }

    res.status(500).render('error', {
        title: 'Server Error',
        message: process.env.NODE_ENV === 'production'
            ? 'An unexpected error occurred.'
            : err.message,
        code: 500
    });
});

async function start(port = PORT) {
    await initializeDb();
    await createInitialAdmin();
    await sessionStore.onReady();
    return app.listen(port, () => {
        console.log(`TAASCOR Attendance Tracking System (ATS) running on http://localhost:${PORT}`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
}

async function shutdown() {
    await sessionStore.close();
    await closeDb();
}
if (require.main === module) {
    start().then(server => {
        for (const signal of ['SIGINT', 'SIGTERM']) {
            process.once(signal, () => server.close(() => shutdown().then(() => process.exit(0))));
        }
    }).catch(async error => {
        console.error('Startup failed:', error.message);
        await shutdown();
        process.exitCode = 1;
    });
}

module.exports = app;
module.exports.start = start;
module.exports.shutdown = shutdown;
