const { getDb } = require('../db/database');
const { createNotification, notifyHR } = require('./notification');
const { logAction } = require('./audit');
const { randomUUID } = require('crypto');

/**
 * Ensures an absence case exists for an employee on a given work date.
 * Idempotent: checks for existing open cases or dedup_key.
 */
async function handleEmployeeAbsence(employeeId, workDate, recordedByUserId, remarks = '') {
    return recordAbsence(employeeId, workDate, recordedByUserId, remarks);
}

async function recordAbsence(employeeId, workDate, recordedByUserId, remarks) {
    const db = getDb();
    // SQLite WAL mode handles concurrent access; FOR UPDATE is not needed/supported.
    
    // Get employee details
    const emp = (await db.prepare(`
        SELECT e.*, a.name as area_name 
        FROM employees e 
        JOIN areas a ON e.area_id = a.id 
        WHERE e.id = ?
    `).get(employeeId));

    if (!emp) return null;

    const coordinatorId = emp.coordinator_id || recordedByUserId;
    const areaId = emp.area_id;

    // Check if there is already an open case for this employee
    const openCase = (await db.prepare(`
        SELECT * FROM btw_cases 
        WHERE employee_id = ? 
        AND status IN ('pending_hr_review', 'for_clarification')
        ORDER BY id DESC LIMIT 1
    `).get(employeeId));

    if (openCase) {
        let dates = [];
        try {
            dates = JSON.parse(openCase.absence_dates);
        } catch (e) {
            dates = [];
        }

        // If date not already in dates list, append it
        if (!dates.includes(workDate)) {
            dates.push(workDate);
            dates.sort();
            (await db.prepare(`
                UPDATE btw_cases 
                SET absence_dates = ?, updated_at = UTC_TIMESTAMP()
                WHERE id = ?
            `).run(JSON.stringify(dates), openCase.id));

            // Add system thread entry
            (await db.prepare(`
                INSERT INTO btw_case_entries (case_id, author_id, author_role, content, entry_type, created_at)
                VALUES (?, ?, 'SYSTEM', ?, 'system', UTC_TIMESTAMP())
            `).run(openCase.id, recordedByUserId, `Additional absence recorded for date: ${workDate}. Reason/Remarks: ${remarks || 'None provided'}`));

            // Notify HR & Coordinator
            (await notifyHR(
                `Absence Added: ${emp.full_name}`,
                `${emp.full_name} (${emp.employee_id}) has an additional absence on ${workDate}. Case Ref: ${openCase.case_ref}`,
                `/btw/${openCase.id}`,
                `btw-add-${openCase.id}-${workDate}`
            ));

            if (coordinatorId) {
                (await createNotification(
                    coordinatorId,
                    `Absence Linked: ${emp.full_name}`,
                    `Absence on ${workDate} for ${emp.full_name} linked to Case ${openCase.case_ref}.`,
                    `/btw/${openCase.id}`,
                    `notif-btw-add-${openCase.id}-${workDate}`
                ));
            }
        }
        return openCase;
    }

    // No open case; create a new one
    const year = new Date().getFullYear();
    const seq = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
    const caseRef = `BTW-${year}-${seq}`;
    const dedupKey = `btw-${employeeId}-${workDate}`;

    // Check dedup_key just in case
    const existingByDedup = (await db.prepare(`SELECT * FROM btw_cases WHERE dedup_key = ?`).get(dedupKey));
    if (existingByDedup) return existingByDedup;

    const result = (await db.prepare(`
        INSERT INTO btw_cases (case_ref, employee_id, area_id, coordinator_id, status, absence_dates, absence_reason, created_at, updated_at, dedup_key)
        VALUES (?, ?, ?, ?, 'pending_hr_review', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)
    `).run(
        caseRef,
        employeeId,
        areaId,
        coordinatorId,
        JSON.stringify([workDate]),
        remarks || 'Unexcused absence on scheduled shift',
        dedupKey
    ));

    const caseId = result.lastInsertRowid;

    // Initial thread entry
    (await db.prepare(`
        INSERT INTO btw_case_entries (case_id, author_id, author_role, content, entry_type, created_at)
        VALUES (?, ?, 'SYSTEM', ?, 'system', UTC_TIMESTAMP())
    `).run(
        caseId,
        recordedByUserId,
        `Back-To-Work clearance case created automatically following confirmed absence on ${workDate}. Employee must report for HR clearance.`
    ));

    if (remarks) {
        (await db.prepare(`
            INSERT INTO btw_case_entries (case_id, author_id, author_role, content, entry_type, created_at)
            VALUES (?, ?, 'COORDINATOR', ?, 'comment', UTC_TIMESTAMP())
        `).run(caseId, recordedByUserId, `Absence remarks/explanation: ${remarks}`));
    }

    // Notify HR and Admin
    (await notifyHR(
        `New Back-to-Work Case: ${emp.full_name}`,
        `Employee ${emp.full_name} (${emp.employee_id}) was marked absent on ${workDate}. Case Ref: ${caseRef}`,
        `/btw/${caseId}`,
        `btw-new-${caseId}`
    ));

    // Notify Coordinator
    if (coordinatorId) {
        (await createNotification(
            coordinatorId,
            `Back-to-Work Required: ${emp.full_name}`,
            `${emp.full_name} was marked absent on ${workDate}. Clearance Case ${caseRef} created. Employee needs HR clearance before returning.`,
            `/btw/${caseId}`,
            `notif-btw-new-${caseId}`
        ));
    }

    (await logAction(recordedByUserId, 'CREATE_BTW_CASE', 'btw_cases', caseId, {
        caseRef,
        employeeId,
        workDate,
        remarks
    }));

    return { id: caseId, case_ref: caseRef };
}

module.exports = { handleEmployeeAbsence };
