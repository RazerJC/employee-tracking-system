// Script to fix, ensure, and test all system accounts
// Run: node scripts/fix-and-verify-all-accounts.js
const bcrypt = require('bcryptjs');
const { getDb, initializeDb, closeDb } = require('../db/database');

async function fixAllAccounts() {
    await initializeDb();
    const db = getDb();

    console.log('--- 1. Hashing Standard Passwords ---');
    // Standard passwords for each role
    const adminHash    = bcrypt.hashSync('admin@2026', 12);
    const hrHash       = bcrypt.hashSync('hr@2026', 12);
    const headHrHash   = bcrypt.hashSync('headhr@2026', 12);
    const coordHash    = bcrypt.hashSync('Taascor@2026', 12);
    console.log('✓ Password hashes computed');

    // 1. Ensure & fix HR account
    console.log('\n--- 2. Fixing HR Account ---');
    const existingHr = await db.prepare("SELECT id FROM users WHERE email = 'hr' OR email = 'hr@taascor.com'").get();
    if (existingHr) {
        await db.prepare("UPDATE users SET email = 'hr@taascor.com', password_hash = ?, role = 'HR', status = 'active', email_verified = 1, must_change_password = 0 WHERE id = ?").run(hrHash, existingHr.id);
        console.log('✓ HR account updated — email: hr@taascor.com, password: hr@2026');
    } else {
        await db.prepare(
            `INSERT INTO users (email, password_hash, full_name, role, status, email_verified, must_change_password, created_at, updated_at)
             VALUES ('hr@taascor.com', ?, 'HR Staff', 'HR', 'active', 1, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`
        ).run(hrHash);
        console.log('✓ HR account created — email: hr@taascor.com, password: hr@2026');
    }

    // 2. Ensure & fix Admin account
    console.log('\n--- 3. Fixing Admin Account ---');
    const existingAdmin = await db.prepare("SELECT id FROM users WHERE role = 'ADMIN'").get();
    if (existingAdmin) {
        await db.prepare("UPDATE users SET password_hash = ?, status = 'active', email_verified = 1, must_change_password = 0 WHERE id = ?").run(adminHash, existingAdmin.id);
        console.log('✓ Admin account updated — password: admin@2026');
    } else {
        await db.prepare(
            `INSERT INTO users (email, password_hash, full_name, role, status, email_verified, must_change_password, created_at, updated_at)
             VALUES ('admin@taascor.com', ?, 'System Administrator', 'ADMIN', 'active', 1, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`
        ).run(adminHash);
        console.log('✓ Admin account created — email: admin@taascor.com, password: admin@2026');
    }

    // 3. Ensure & fix Head HR account
    console.log('\n--- 4. Fixing Head HR Account ---');
    const existingHeadHr = await db.prepare("SELECT id FROM users WHERE role = 'HEAD_HR'").get();
    if (existingHeadHr) {
        await db.prepare("UPDATE users SET password_hash = ?, status = 'active', email_verified = 1, must_change_password = 0 WHERE id = ?").run(headHrHash, existingHeadHr.id);
        console.log('✓ Head HR account updated — password: headhr@2026');
    } else {
        await db.prepare(
            `INSERT INTO users (email, password_hash, full_name, role, status, email_verified, must_change_password, created_at, updated_at)
             VALUES ('headhr@taascor.com', ?, 'Head HR Coordinator', 'HEAD_HR', 'active', 1, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`
        ).run(headHrHash);
        console.log('✓ Head HR account created — email: headhr@taascor.com, password: headhr@2026');
    }

    // 4. Ensure generic Coordinator test account
    console.log('\n--- 5. Fixing Generic Coordinator Account ---');
    const existingCoord = await db.prepare("SELECT id FROM users WHERE email = 'coordinator' OR email = 'coordinator@taascor.com'").get();
    let coordId = existingCoord ? existingCoord.id : null;
    if (existingCoord) {
        await db.prepare("UPDATE users SET email = 'coordinator@taascor.com', password_hash = ?, role = 'COORDINATOR', status = 'active', email_verified = 1, must_change_password = 0 WHERE id = ?").run(coordHash, existingCoord.id);
        console.log('✓ Generic coordinator account updated — email: coordinator@taascor.com, password: Taascor@2026');
    } else {
        const res = await db.prepare(
            `INSERT INTO users (email, password_hash, full_name, role, status, email_verified, must_change_password, created_at, updated_at)
             VALUES ('coordinator@taascor.com', ?, 'Coordinator Staff', 'COORDINATOR', 'active', 1, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`
        ).run(coordHash);
        coordId = res.lastInsertRowid;
        console.log('✓ Generic coordinator account created — email: coordinator@taascor.com, password: Taascor@2026');
    }

    // Assign area to generic coordinator if none
    if (coordId) {
        const coordArea = await db.prepare('SELECT id FROM coordinator_area_assignments WHERE user_id = ? AND is_current = 1').get(coordId);
        if (!coordArea) {
            const firstArea = await db.prepare('SELECT id FROM areas WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
            if (firstArea) {
                await db.prepare(`
                    INSERT INTO coordinator_area_assignments (user_id, area_id, assigned_by, assigned_at, is_current, remarks)
                    VALUES (?, ?, 1, UTC_TIMESTAMP(), 1, 'Default assignment')
                `).run(coordId, firstArea.id);
                console.log(`✓ Generic coordinator assigned to Area ${firstArea.id}`);
            }
        }
    }

    // 5. Activate & verify ALL users so no one is stuck
    console.log('\n--- 6. Activating All Users ---');
    await db.prepare("UPDATE users SET status = 'active', email_verified = 1, must_change_password = 0").run();
    console.log('✓ All users marked: active, email_verified=1, must_change_password=0');

    // 6. Reset ALL coordinator passwords to standard Taascor@2026
    console.log('\n--- 7. Standardizing All Coordinator Passwords ---');
    await db.prepare("UPDATE users SET password_hash = ? WHERE role = 'COORDINATOR'").run(coordHash);
    const coordCount = await db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'COORDINATOR'").get();
    console.log(`✓ ${coordCount.cnt} coordinator passwords set to Taascor@2026`);

    // 7. Verify all coordinators have active warehouse assignments
    console.log('\n--- 8. Verifying Warehouse Assignments ---');
    const coordinators = await db.prepare("SELECT id, full_name FROM users WHERE role = 'COORDINATOR'").all();
    const firstArea = await db.prepare('SELECT id FROM areas WHERE is_active = 1 ORDER BY id ASC LIMIT 1').get();
    let fixedAssignments = 0;
    for (const c of coordinators) {
        const ca = await db.prepare('SELECT id FROM coordinator_area_assignments WHERE user_id = ? AND is_current = 1').get(c.id);
        if (!ca && firstArea) {
            await db.prepare(`
                INSERT INTO coordinator_area_assignments (user_id, area_id, assigned_by, assigned_at, is_current, remarks)
                VALUES (?, ?, 1, UTC_TIMESTAMP(), 1, 'Auto-assigned warehouse')
            `).run(c.id, firstArea.id);
            fixedAssignments++;
        }
    }
    console.log(`✓ Checked ${coordinators.length} coordinators — fixed ${fixedAssignments} missing warehouse assignments`);

    console.log('\n========================================');
    console.log('  ALL ACCOUNTS SUCCESSFULLY PREPARED');
    console.log('========================================');
    console.log('');
    console.log('  ACCOUNT CREDENTIALS SUMMARY');
    console.log('  ----------------------------');
    console.log('  ADMIN     : admin@taascor.com    → admin@2026');
    console.log('  HR        : hr@taascor.com        → hr@2026');
    console.log('  HEAD HR   : headhr@taascor.com    → headhr@2026');
    console.log('  COORDINATOR (all): [email]        → Taascor@2026');
    console.log('');
    console.log('  Login tip: Use email OR just the prefix (e.g., "admin", "hr", "headhr")');
    console.log('========================================');
}

if (require.main === module) {
    fixAllAccounts()
        .catch(console.error)
        .finally(closeDb);
}

module.exports = { fixAllAccounts };
