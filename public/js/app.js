// TAASCOR Attendance Monitoring System - Client-side JS

document.addEventListener('DOMContentLoaded', () => {
    // Mobile Sidebar Toggle
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const sidebarToggle = document.getElementById('sidebarToggle');
    const mobileViewport = window.matchMedia('(max-width: 768px)');

    function setMobileSidebar(open) {
        if (!sidebar || !sidebarOverlay || !mobileMenuBtn) return;
        sidebar.classList.toggle('open', open);
        sidebarOverlay.classList.toggle('show', open);
        mobileMenuBtn.setAttribute('aria-expanded', String(open));
        sidebar.inert = mobileViewport.matches && !open;
        if (mobileViewport.matches) document.body.style.overflow = open ? 'hidden' : '';
    }

    if (sidebarToggle && sidebar) {
        sidebarToggle.addEventListener('click', () => {
            const collapsed = document.body.classList.toggle('sidebar-collapsed');
            sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
            sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
        });
        sidebar.querySelectorAll('.nav-item').forEach(link => {
            const label = link.querySelector('span:not(.nav-icon)')?.textContent.trim();
            if (label) { link.setAttribute('aria-label', label); link.title = label; }
            if (link.classList.contains('active')) link.setAttribute('aria-current', 'page');
        });
    }

    if (mobileMenuBtn && sidebar && sidebarOverlay) {
        setMobileSidebar(false);
        mobileMenuBtn.addEventListener('click', () => {
            const open = !sidebar.classList.contains('open');
            setMobileSidebar(open);
            if (open) sidebar.querySelector('a')?.focus();
        });

        sidebarOverlay.addEventListener('click', () => {
            setMobileSidebar(false);
            mobileMenuBtn.focus();
        });
        mobileViewport.addEventListener('change', () => {
            setMobileSidebar(false);
            document.body.style.overflow = '';
        });
        sidebar.addEventListener('keydown', event => {
            if (!mobileViewport.matches || !sidebar.classList.contains('open') || event.key !== 'Tab') return;
            const links = [...sidebar.querySelectorAll('a, button')].filter(el => el.getClientRects().length);
            const first = links[0], last = links[links.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        });
    }

    // User Profile Dropdown
    const userMenuBtn = document.getElementById('userMenuBtn');
    const userMenu = document.getElementById('userMenu');

    if (userMenuBtn && userMenu) {
        userMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            userMenu.classList.toggle('show');
            userMenuBtn.setAttribute('aria-expanded', String(userMenu.classList.contains('show')));
            if (notifMenu) notifMenu.classList.remove('show');
            notifBellBtn?.setAttribute('aria-expanded', 'false');
        });
    }

    // Notification Dropdown & Polling
    const notifBellBtn = document.getElementById('notifBellBtn');
    const notifMenu = document.getElementById('notifMenu');
    const notifBadge = document.getElementById('notifCountBadge');
    const notifContainer = document.getElementById('notifItemsContainer');
    const notifMarkAll = document.getElementById('notifMarkAllBtn');
    const notifFeedback = document.getElementById('notifFeedback');
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';

    notifMenu?.addEventListener('click', event => event.stopPropagation());
    notifMarkAll?.addEventListener('click', async () => {
        notifMarkAll.disabled = true;
        notifFeedback.hidden = true;
        try {
            const response = await fetch('/notifications/mark-all-read', {
                method: 'POST',
                headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken }
            });
            if (!response.ok || !(await response.json()).success) throw new Error('Could not mark notifications as read');
            notifContainer.querySelectorAll('.unread').forEach(item => item.classList.remove('unread'));
            notifBadge?.classList.add('hidden');
            await Promise.all([loadNotificationDropdown(), pollUnreadCount()]);
        } catch {
            notifFeedback.textContent = 'Unable to mark notifications as read. Please try again.';
            notifFeedback.hidden = false;
        } finally {
            notifMarkAll.disabled = false;
        }
    });

    if (notifBellBtn && notifMenu) {
        notifBellBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            notifMenu.classList.toggle('show');
            notifBellBtn.setAttribute('aria-expanded', String(notifMenu.classList.contains('show')));
            if (userMenu) userMenu.classList.remove('show');
            userMenuBtn?.setAttribute('aria-expanded', 'false');

            if (notifMenu.classList.contains('show')) {
                await loadNotificationDropdown();
            }
        });
    }

    // Close dropdowns on outside click
    document.addEventListener('click', () => {
        if (userMenu) userMenu.classList.remove('show');
        if (notifMenu) notifMenu.classList.remove('show');
        userMenuBtn?.setAttribute('aria-expanded', 'false');
        notifBellBtn?.setAttribute('aria-expanded', 'false');
    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (sidebar?.classList.contains('open')) {
            setMobileSidebar(false);
            mobileMenuBtn?.focus();
        }
        if (userMenu?.classList.contains('show')) {
            userMenu.classList.remove('show');
            userMenuBtn.setAttribute('aria-expanded', 'false');
            userMenuBtn.focus();
        }
        if (notifMenu?.classList.contains('show')) {
            notifMenu.classList.remove('show');
            notifBellBtn.setAttribute('aria-expanded', 'false');
            notifBellBtn.focus();
        }
    });

    async function loadNotificationDropdown() {
        if (!notifContainer) return;
        try {
            const res = await fetch('/api/notifications/latest', {
                headers: { 'Accept': 'application/json' }
            });
            const data = await res.json();
            
            if (!data.notifications || data.notifications.length === 0) {
                notifContainer.innerHTML = '<div class="notif-empty">No new notifications</div>';
                return;
            }

            const items = data.notifications.map(notification => {
                const form = document.createElement('form');
                form.method = 'POST';
                form.action = '/notifications/' + Number(notification.id) + '/open';
                const token = document.createElement('input');
                token.type = 'hidden';
                token.name = '_csrf';
                token.value = csrfToken;
                const button = document.createElement('button');
                button.type = 'submit';
                button.className = notification.is_read ? 'notif-item notif-open' : 'notif-item notif-open unread';
                const time = new Date(notification.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                for (const [className, value] of [['notif-title', notification.title], ['notif-msg', notification.message], ['notif-time', time]]) {
                    const span = document.createElement('span');
                    span.className = className;
                    span.textContent = value;
                    button.append(span);
                }
                form.append(token, button);
                return form;
            });
            notifContainer.replaceChildren(...items);
        } catch (err) {
            notifContainer.innerHTML = '<div class="notif-empty">Unable to load notifications</div>';
        }
    }

    // Periodic Notification Polling (every 30s)
    async function pollUnreadCount() {
        try {
            const res = await fetch('/api/notifications/unread-count');
            const data = await res.json();
            if (notifBadge) {
                if (data.count > 0) {
                    notifBadge.textContent = data.count;
                    notifBadge.classList.remove('hidden');
                } else {
                    notifBadge.classList.add('hidden');
                }
            }

            // Real-time dynamic menu panel glow update
            if (data.glow) {
                document.querySelectorAll('[data-glow-path]').forEach(el => {
                    const p = el.getAttribute('data-glow-path');
                    const c = Number(data.glow[p]) || 0;
                    let badge = el.querySelector('.nav-glow-badge');
                    if (c > 0) {
                        el.classList.add('nav-item-glowing');
                        if (!badge) {
                            badge = document.createElement('span');
                            badge.className = 'nav-glow-badge';
                            badge.innerHTML = '<span class="nav-glow-dot"></span><span class="nav-glow-count">' + c + '</span>';
                            el.appendChild(badge);
                        } else {
                            const countEl = badge.querySelector('.nav-glow-count');
                            if (countEl) countEl.textContent = c;
                        }
                    } else {
                        el.classList.remove('nav-item-glowing');
                        if (badge) badge.remove();
                    }
                });
            }
        } catch (e) {
            // Silently handle polling failure
        }
    }

    setInterval(pollUnreadCount, 30000);

    // Schedule Conflict Detection
    const startDateInput = document.getElementById('start_date');
    const conflictAlert = document.getElementById('conflictAlert');
    const conflictMsg = document.getElementById('conflictMsg');

    if (startDateInput && conflictAlert) {
        startDateInput.addEventListener('change', checkConflicts);
        document.querySelectorAll('.emp-checkbox').forEach(cb => {
            cb.addEventListener('change', checkConflicts);
        });

        async function checkConflicts() {
            const date = startDateInput.value;
            const checkedEmp = document.querySelector('.emp-checkbox:checked');
            if (!date || !checkedEmp) {
                conflictAlert.classList.add('hidden');
                return;
            }

            try {
                const res = await fetch(`/api/schedules/check-conflict?employee_id=${checkedEmp.value}&work_date=${date}`);
                const data = await res.json();
                if (data.conflict) {
                    conflictMsg.textContent = data.message;
                    conflictAlert.classList.remove('hidden');
                } else {
                    conflictAlert.classList.add('hidden');
                }
            } catch (e) {
                conflictAlert.classList.add('hidden');
            }
        }
    }
});
