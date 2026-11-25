const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getNotifications, markAsRead, markAllAsRead } = require('../services/notification');
const { getDb } = require('../db/database');

// GET /notifications
router.get('/', requireAuth, async (req, res) => {
    const user = req.session.user;
    const notifications = (await getNotifications(user.id, 50, 0));

    res.render('notifications/index', {
        title: 'Notifications - TAASCOR',
        notifications
    });
});

router.post('/:id/open', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.redirect(303, '/notifications');
    const notification = await getDb().prepare('SELECT link FROM notifications WHERE id = ? AND user_id = ?').get(id, userId);
    if (!notification) return res.redirect(303, '/notifications');
    await markAsRead(id, userId);
    const link = notification.link;
    const destination = typeof link === 'string' && /^\/(?![\/\\])/.test(link) && !/[\\\r\n\t]/.test(link)
        ? link : '/notifications';
    res.redirect(303, destination);
});

// POST /notifications/:id/read
router.post('/:id/read', requireAuth, async (req, res) => {
    const user = req.session.user;
    const id = parseInt(req.params.id);
    (await markAsRead(id, user.id));

    if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.json({ success: true });
    }
    res.redirect('back');
});

// POST /notifications/mark-all-read
router.post('/mark-all-read', requireAuth, async (req, res) => {
    const user = req.session.user;
    (await markAllAsRead(user.id));

    if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.json({ success: true });
    }
    req.flash('success', 'All notifications marked as read.');
    res.redirect('/notifications');
});

module.exports = router;
