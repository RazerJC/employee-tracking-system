const pendingCategories = [
    { key: 'accounts', path: '/admin/pending-coordinators', label: 'Account Approvals', table: 'users', title: 'full_name', statuses: ['pending'], where: "role IN ('COORDINATOR', 'HR', 'HEAD_HR')" },
    { key: 'btw', path: '/btw', filter: '?tab=pending', label: 'Back-to-Work', table: 'btw_cases', title: 'case_ref', statuses: ['pending_hr_review', 'for_clarification'] },
    { key: 'concerns', path: '/concerns', filter: '?status=pending', label: 'Employee Concerns', table: 'concern_reports', title: 'category', statuses: ['submitted', 'under_review', 'for_employee_reporting'] },
    { key: 'manpower', path: '/manpower', filter: '?status=pending', label: 'Manpower Requests', table: 'manpower_requests', title: "CONCAT('Request #', r.id)", statuses: ['submitted', 'under_review', 'partially_filled'] },
    { key: 'incidents', path: '/incidents', filter: '?status=pending', label: 'Incident Reports', table: 'incident_reports', title: 'title', statuses: ['reported', 'under_investigation', 'hr_action_taken'] }
];

function pendingFilter(category, areaId) {
    const params = [...category.statuses];
    const clauses = ['r.status IN (' + params.map(() => '?').join(', ') + ')'];
    if (category.where) clauses.push(category.where);
    if (areaId && category.key !== 'accounts') {
        clauses.push('r.area_id = ?');
        params.push(areaId);
    }
    return { where: clauses.join(' AND '), params };
}

async function getPendingCounts(db, areaId) {
    const params = [];
    const columns = pendingCategories.map((category, index) => {
        const filter = pendingFilter(category, areaId);
        params.push(...filter.params);
        return `(SELECT COUNT(*) FROM ${category.table} r WHERE ${filter.where}) AS count_${index}`;
    });
    const row = await db.prepare('SELECT ' + columns.join(', ')).get(...params);
    return Object.fromEntries(pendingCategories.map(({ path }, index) => [path, Number(row['count_' + index])]));
}

async function getPendingRecords(db, category, areaId) {
    const { where, params } = pendingFilter(category, areaId);
    const accounts = category.key === 'accounts';
    return db.prepare(`
        SELECT r.id, r.status, ${category.title} AS title, ${accounts ? 'NULL' : 'a.name'} AS area_name
        FROM ${category.table} r
        ${accounts ? '' : 'JOIN areas a ON a.id = r.area_id'}
        WHERE ${where}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 50
    `).all(...params);
}

module.exports = { pendingCategories, getPendingCounts, getPendingRecords };
