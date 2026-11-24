// The latest allocation for this warehouse controls roster eligibility.
// An allocation to another warehouse does not affect the employee's current roster.
const coordinatorRosterCondition = `
    e.status = 'active' AND COALESCE((
        SELECT ma.status
        FROM manpower_allocations ma
        JOIN manpower_requests mr ON mr.id = ma.request_id
        WHERE ma.employee_id = e.id AND mr.area_id = e.area_id
          AND (ma.status = 'confirmed' OR mr.status NOT IN ('cancelled', 'declined'))
        ORDER BY ma.id DESC
        LIMIT 1
    ), 'confirmed') = 'confirmed'
`;

module.exports = { coordinatorRosterCondition };
