const path = require('path');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
require('dotenv').config();
const { getDb, initializeDb, closeDb, runTransaction } = require('./database');

const sourcePath = process.argv[2];
const AREA_NAME = 'SHOPEE PHIXC';
const COORDINATOR_EMAIL = 'PHIXC@taascor.com';
const COORDINATOR_NAME = 'PHIXC';
const TEMP_PASSWORD = process.env.PHIXC_COORDINATOR_PASSWORD || 'Coord123!';

function toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const text = String(value).trim();
    const parsed = XLSX.SSF.parse_date_code(Number(value));
    if (parsed && Number.isFinite(Number(value))) {
        return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

async function main() {
    if (!sourcePath) throw new Error('Usage: node db/import-phixc.js <xlsx-path>');
    const workbook = XLSX.readFile(path.resolve(sourcePath), { cellDates: true });
    const sheet = workbook.Sheets.PHIXC;
    if (!sheet) throw new Error('PHIXC worksheet was not found.');
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) throw new Error('PHIXC worksheet has no employee rows.');

    await initializeDb();
    const db = getDb();
    const result = await runTransaction(async () => {
        const admin = await db.prepare("SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id LIMIT 1").get();
        const actorId = admin ? admin.id : null;

        let area = await db.prepare('SELECT id FROM areas WHERE name = ?').get(AREA_NAME);
        if (!area) {
            const created = await db.prepare(`INSERT INTO areas (name, description, is_active, created_at, created_by)
                VALUES (?, ?, 1, UTC_TIMESTAMP(), ?)`).run(AREA_NAME, 'SHOPEE PHIXC employee location', actorId);
            area = { id: created.lastInsertRowid };
        }

        let coordinator = await db.prepare('SELECT id FROM users WHERE email = ?').get(COORDINATOR_EMAIL);
        if (!coordinator) {
            const hash = bcrypt.hashSync(TEMP_PASSWORD, 12);
            const created = await db.prepare(`INSERT INTO users
                (email, password_hash, full_name, role, status, email_verified, must_change_password, approved_by, approved_at, created_at, updated_at)
                VALUES (?, ?, ?, 'COORDINATOR', 'active', 1, 1, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())`)
                .run(COORDINATOR_EMAIL, hash, COORDINATOR_NAME, actorId);
            coordinator = { id: created.lastInsertRowid };
        } else {
            await db.prepare(`UPDATE users SET full_name = ?, role = 'COORDINATOR', status = 'active', email_verified = 1,
                approved_by = ?, approved_at = COALESCE(approved_at, UTC_TIMESTAMP()), updated_at = UTC_TIMESTAMP() WHERE id = ?`)
                .run(COORDINATOR_NAME, actorId, coordinator.id);
        }

        await db.prepare('UPDATE coordinator_area_assignments SET is_current = 0, ended_at = UTC_TIMESTAMP() WHERE user_id = ? AND is_current = 1')
            .run(coordinator.id);
        const currentAssignment = await db.prepare('SELECT id FROM coordinator_area_assignments WHERE user_id = ? AND area_id = ? AND is_current = 1')
            .get(coordinator.id, area.id);
        if (!currentAssignment) {
            await db.prepare(`INSERT INTO coordinator_area_assignments (user_id, area_id, assigned_by, assigned_at, is_current, remarks)
                VALUES (?, ?, ?, UTC_TIMESTAMP(), 1, ?)`)
                .run(coordinator.id, area.id, coordinator.id, 'Imported from PHIXC worksheet');
        }

        const departments = new Map();
        const positions = new Map();
        let imported = 0;
        for (const row of rows) {
            const employeeId = String(row['staffid'] || '').trim();
            const fullName = String(row['FULLNAME'] || '').trim();
            if (!employeeId || !fullName) continue;
            const firstName = String(row['First Name'] || '').trim() || fullName.split(',').slice(1).join(',').trim();
            const lastName = String(row['Last Name'] || '').trim() || fullName.split(',')[0].trim();
            const departmentName = String(row['DEPARTMENT'] || '').trim();
            const positionTitle = String(row['POSITION'] || '').trim();
            let departmentId = null;
            let positionId = null;
            if (departmentName) {
                if (!departments.has(departmentName)) {
                    let department = await db.prepare('SELECT id FROM departments WHERE area_id = ? AND name = ?').get(area.id, departmentName);
                    if (!department) {
                        const created = await db.prepare(`INSERT INTO departments (area_id, name, created_by, created_at, updated_at)
                            VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`).run(area.id, departmentName, actorId);
                        department = { id: created.lastInsertRowid };
                    }
                    departments.set(departmentName, department.id);
                }
                departmentId = departments.get(departmentName);
            }
            if (positionTitle) {
                if (!positions.has(positionTitle)) {
                    let position = await db.prepare('SELECT id FROM positions WHERE title = ?').get(positionTitle);
                    if (!position) {
                        const created = await db.prepare(`INSERT INTO positions (title, description, is_active, created_at, created_by)
                            VALUES (?, ?, 1, UTC_TIMESTAMP(), ?)`).run(positionTitle, `Imported from ${AREA_NAME}`, actorId);
                        position = { id: created.lastInsertRowid };
                    }
                    positions.set(positionTitle, position.id);
                }
                positionId = positions.get(positionTitle);
            }
            const startDate = toDate(row['DATE EMPLOYED']) || new Date().toISOString().slice(0, 10);
            await db.prepare(`INSERT INTO employees
                (employee_id, first_name, last_name, full_name, area_id, coordinator_id, department_id, position_id, employment_start_date, status, created_at, updated_at, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)
                ON DUPLICATE KEY UPDATE first_name = VALUES(first_name), last_name = VALUES(last_name), full_name = VALUES(full_name),
                area_id = VALUES(area_id), coordinator_id = VALUES(coordinator_id), department_id = VALUES(department_id), position_id = VALUES(position_id),
                employment_start_date = VALUES(employment_start_date), status = 'active', updated_at = UTC_TIMESTAMP(), updated_by = VALUES(created_by)`)
                .run(employeeId, firstName, lastName, fullName, area.id, coordinator.id, departmentId, positionId, startDate, actorId);
            imported += 1;
        }
        return { imported, areaId: area.id, coordinatorId: coordinator.id };
    });
    console.log(JSON.stringify({ ...result, coordinatorEmail: COORDINATOR_EMAIL, temporaryPasswordUsed: !process.env.PHIXC_COORDINATOR_PASSWORD }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => closeDb());
