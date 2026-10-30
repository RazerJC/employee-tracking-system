const bcrypt = require('bcryptjs');
const { getDb, initializeDb, closeDb } = require('../db/database');

async function cleanupCoordinators() {
    await initializeDb();
    const db = getDb();

    console.log('=================================================================');
    console.log('   TAASCOR: CLEANING UP COORDINATOR ACCOUNTS');
    console.log('=================================================================\n');

    // 1. Identify Target Accounts
    let admin = await db.prepare("SELECT id, email, full_name, role FROM users WHERE role = 'ADMIN' LIMIT 1").get();
    let headHr = await db.prepare("SELECT id, email, full_name, role FROM users WHERE role = 'HEAD_HR' OR email = 'headhr@taascor.com' LIMIT 1").get();
    let hr = await db.prepare("SELECT id, email, full_name, role FROM users WHERE email = 'hr@taascor.com' OR (role = 'HR' AND id = 11) LIMIT 1").get();
    let markPasa = await db.prepare("SELECT id, email, full_name, role FROM users WHERE email = 'mark.pasa@taascor.com' LIMIT 1").get();

    console.log('Primary accounts to KEEP:');
    console.log('  Admin:', admin ? `[${admin.id}] ${admin.email}` : 'NOT FOUND');
    console.log('  Head HR:', headHr ? `[${headHr.id}] ${headHr.email}` : 'NOT FOUND');
    console.log('  HR:', hr ? `[${hr.id}] ${hr.email}` : 'NOT FOUND');
    console.log('  Mark Pasa:', markPasa ? `[${markPasa.id}] ${markPasa.email}` : 'NOT FOUND');

    if (!markPasa) {
        throw new Error('mark.pasa@taascor.com account not found!');
    }
    if (!hr) {
        throw new Error('hr@taascor.com account not found!');
    }

    const hrId = hr.id;
    const markPasaId = markPasa.id; // user 9
    const adminId = admin ? admin.id : markPasaId;

    // Get all foreign keys that reference users(id)
    const fks = await db.prepare(`
        SELECT TABLE_NAME, COLUMN_NAME 
        FROM information_schema.KEY_COLUMN_USAGE 
        WHERE REFERENCED_TABLE_NAME = 'users' 
          AND REFERENCED_COLUMN_NAME = 'id' 
          AND TABLE_SCHEMA = ?
    `).all(process.env.DB_NAME);

    console.log(`Found ${fks.length} foreign key relationships referencing users(id).`);

    // 2. Reassign/merge Jun Mark Pasa (user 15) to Mark Pasa (user 9)
    const junMarkPasa = await db.prepare("SELECT id FROM users WHERE email = 'jun.mark.pasa@taascor.com'").get();
    if (junMarkPasa) {
        const u15Id = junMarkPasa.id;
        console.log(`\nMerging [${u15Id}] jun.mark.pasa@taascor.com into [${markPasaId}] mark.pasa@taascor.com...`);

        // Deduplicate coordinator_attendance before FK update
        const existingDates = await db.prepare('SELECT work_date FROM coordinator_attendance WHERE user_id = ?').all(markPasaId);
        const dateSet = new Set(existingDates.map(d => d.work_date));
        const u15Att = await db.prepare('SELECT id, work_date FROM coordinator_attendance WHERE user_id = ?').all(u15Id);
        for (const row of u15Att) {
            if (dateSet.has(row.work_date)) {
                await db.prepare('DELETE FROM coordinator_attendance WHERE id = ?').run(row.id);
            }
        }

        // Reassign all FKs from u15Id to markPasaId
        for (const { TABLE_NAME, COLUMN_NAME } of fks) {
            if (TABLE_NAME === 'users' && COLUMN_NAME === 'approved_by') {
                await db.prepare(`UPDATE users SET approved_by = ? WHERE approved_by = ?`).run(adminId, u15Id);
                continue;
            }
            if (TABLE_NAME === 'coordinator_area_assignments') {
                await db.prepare(`DELETE FROM coordinator_area_assignments WHERE user_id = ?`).run(u15Id);
                continue;
            }
            try {
                await db.prepare(`UPDATE ${TABLE_NAME} SET ${COLUMN_NAME} = ? WHERE ${COLUMN_NAME} = ?`).run(markPasaId, u15Id);
            } catch (e) {
                console.warn(`Warning updating ${TABLE_NAME}.${COLUMN_NAME}:`, e.message);
            }
        }

        await db.prepare('DELETE FROM users WHERE id = ?').run(u15Id);
        console.log('✓ Jun Mark Pasa merged and deleted.');
    }

    // 3. Reassign/merge hr.santos (user 2) to hr@taascor.com (user 11)
    const hrSantos = await db.prepare("SELECT id FROM users WHERE email = 'hr.santos@taascor.com'").get();
    if (hrSantos) {
        const u2Id = hrSantos.id;
        console.log(`\nReassigning [${u2Id}] hr.santos@taascor.com to [${hrId}] hr@taascor.com...`);
        for (const { TABLE_NAME, COLUMN_NAME } of fks) {
            if (TABLE_NAME === 'users' && COLUMN_NAME === 'approved_by') {
                await db.prepare(`UPDATE users SET approved_by = ? WHERE approved_by = ?`).run(adminId, u2Id);
                continue;
            }
            if (TABLE_NAME === 'coordinator_area_assignments') {
                await db.prepare(`DELETE FROM coordinator_area_assignments WHERE user_id = ?`).run(u2Id);
                continue;
            }
            try {
                await db.prepare(`UPDATE ${TABLE_NAME} SET ${COLUMN_NAME} = ? WHERE ${COLUMN_NAME} = ?`).run(hrId, u2Id);
            } catch (e) {
                console.warn(`Warning updating ${TABLE_NAME}.${COLUMN_NAME}:`, e.message);
            }
        }
        await db.prepare('DELETE FROM users WHERE id = ?').run(u2Id);
        console.log('✓ hr.santos removed and references transferred to hr@taascor.com');
    }

    // 4. Delete all other users not in keepIds
    const keepIds = [admin?.id, headHr?.id, hrId, markPasaId].filter(Boolean);
    console.log('\nRetaining user IDs:', keepIds);

    const toDelete = await db.prepare(`SELECT id, email, full_name, role FROM users WHERE id NOT IN (${keepIds.join(',')})`).all();
    console.log(`Found ${toDelete.length} accounts to delete.`);

    if (toDelete.length > 0) {
        const deleteIds = toDelete.map(u => u.id);

        // For each foreign key, delete or reassign
        for (const { TABLE_NAME, COLUMN_NAME } of fks) {
            if (TABLE_NAME === 'users') {
                await db.prepare(`UPDATE users SET approved_by = ? WHERE approved_by IN (${deleteIds.join(',')})`).run(adminId);
                continue;
            }
            if (TABLE_NAME === 'notifications' || TABLE_NAME === 'email_verification_tokens' || TABLE_NAME === 'password_reset_tokens' || TABLE_NAME === 'coordinator_area_assignments' || TABLE_NAME === 'coordinator_attendance') {
                await db.prepare(`DELETE FROM ${TABLE_NAME} WHERE ${COLUMN_NAME} IN (${deleteIds.join(',')})`).run();
                continue;
            }
            if (TABLE_NAME === 'audit_logs') {
                await db.prepare(`UPDATE audit_logs SET user_id = NULL WHERE user_id IN (${deleteIds.join(',')})`).run();
                continue;
            }
            // Other tables: reassign to markPasaId (if coordinator action) or adminId / hrId
            const targetId = COLUMN_NAME.includes('hr') ? hrId : (COLUMN_NAME.includes('created') || COLUMN_NAME.includes('assigned') ? adminId : markPasaId);
            try {
                await db.prepare(`UPDATE ${TABLE_NAME} SET ${COLUMN_NAME} = ? WHERE ${COLUMN_NAME} IN (${deleteIds.join(',')})`).run(targetId);
            } catch (e) {
                console.warn(`Warning updating ${TABLE_NAME}.${COLUMN_NAME}:`, e.message);
            }
        }

        const res = await db.prepare(`DELETE FROM users WHERE id IN (${deleteIds.join(',')})`).run();
        console.log(`✓ Successfully deleted ${res.changes} accounts.`);
    }

    // 5. Standardize passwords and status for the retained accounts
    const standardCoordHash = bcrypt.hashSync('Taascor@2026', 12);
    const standardHrHash = bcrypt.hashSync('hr@2026', 12);
    const standardHeadHrHash = bcrypt.hashSync('headhr@2026', 12);
    const standardAdminHash = bcrypt.hashSync('admin@2026', 12);

    await db.prepare("UPDATE users SET password_hash = ?, status = 'active', email_verified = 1, must_change_password = 0 WHERE id = ?").run(standardCoordHash, markPasaId);
    await db.prepare("UPDATE users SET password_hash = ?, status = 'active', email_verified = 1, must_change_password = 0 WHERE id = ?").run(standardHrHash, hrId);
    if (headHr) {
        await db.prepare("UPDATE users SET password_hash = ?, status = 'active', email_verified = 1, must_change_password = 0 WHERE id = ?").run(standardHeadHrHash, headHr.id);
    }
    if (admin) {
        await db.prepare("UPDATE users SET password_hash = ?, status = 'active', email_verified = 1, must_change_password = 0 WHERE id = ?").run(standardAdminHash, admin.id);
    }

    // 6. Ensure Mark Pasa has active warehouse assignment
    const pasaArea = await db.prepare('SELECT * FROM coordinator_area_assignments WHERE user_id = ? AND is_current = 1').get(markPasaId);
    if (!pasaArea) {
        const area = await db.prepare("SELECT id FROM areas WHERE name LIKE '%BI CHAIN%' ORDER BY id ASC LIMIT 1").get();
        if (area) {
            await db.prepare(`
                INSERT INTO coordinator_area_assignments (user_id, area_id, assigned_by, assigned_at, is_current, remarks)
                VALUES (?, ?, ?, UTC_TIMESTAMP(), 1, 'Assigned warehouse')
            `).run(markPasaId, area.id, adminId);
            console.log(`✓ Assigned Mark Pasa to Area ${area.id}`);
        }
    }

    // 7. Verification: list all remaining users in DB
    const finalUsers = await db.prepare('SELECT id, email, full_name, role, status FROM users ORDER BY id ASC').all();
    console.log('\n=================================================================');
    console.log('   FINAL REMAINING ACCOUNTS IN SYSTEM:');
    console.log('=================================================================');
    console.table(finalUsers);

    await closeDb();
}

cleanupCoordinators().catch(console.error);
