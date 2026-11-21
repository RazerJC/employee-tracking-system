const fs = require('fs');
const path = require('path');
const { getDb, getPool, initializeDb, closeDb } = require('./database');

async function importSqlite(sourcePath) {
    if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('Usage: npm run db:import-sqlite -- /absolute/path/to/taascor.db');
    const { DatabaseSync } = require('node:sqlite');
    const source = new DatabaseSync(path.resolve(sourcePath), { readOnly: true });
    let lock;
    let sourceTransaction = false;
    try {
        await initializeDb();
        lock = await getPool().getConnection();
        const lockName = `taascor-import-${process.env.DB_NAME}`.slice(0, 64);
        const [result] = await lock.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
        if (!result[0].acquired) throw new Error('Another import is running.');
        source.exec('BEGIN');
        sourceTransaction = true;
        const violations = source.prepare('PRAGMA foreign_key_check').all();
        if (violations.length) throw new Error(`Source has ${violations.length} foreign-key violations. Resolve them before importing.`);
        const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]).filter(t => t !== 'sessions');
        const counts = {};
        await getDb().transaction(async () => {
            for (const table of [...tables, 'sessions']) {
                const row = await getDb().prepare(`SELECT COUNT(*) AS count FROM \`${table}\``).get();
                if (row.count) throw new Error(`Target table ${table} is not empty. Use a new database; no rows were imported.`);
            }
            for (const table of tables) {
                const exists = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
                if (!exists) { counts[table] = 0; continue; }
                const columnInfo = await getDb().prepare(`SHOW COLUMNS FROM \`${table}\``).all();
                const columns = columnInfo.map(c => c.Field);
                const sourceColumns = source.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
                const unknown = sourceColumns.filter(c => !columns.includes(c));
                if (unknown.length) throw new Error(`Unmapped source columns in ${table}: ${unknown.join(', ')}. Import rolled back to prevent data loss.`);
                const selected = columns.filter(c => sourceColumns.includes(c));
                const orderBy = sourceColumns.includes('id') ? ' ORDER BY id' : '';
                const rows = source.prepare(`SELECT * FROM "${table}"${orderBy}`).all();
                const insert = getDb().prepare(`INSERT INTO \`${table}\` (${selected.map(c => '\`' + c + '\`').join(',')}) VALUES (${selected.map(() => '?').join(',')})`);
                for (const row of rows) {
                    for (const column of columnInfo.filter(c => c.Type === 'date')) {
                        const value = row[column.Field];
                        if (value != null && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !require('luxon').DateTime.fromISO(value).isValid || Number(value.slice(0,4)) < 1000)) {
                            throw new Error(`Import rolled back: ${table} record ${row.id}, ${column.Field} must be a valid YYYY-MM-DD date (year 1000 or later). Correct the source record; dates are never guessed.`);
                        }
                    }
                    try {
                        await insert.run(...selected.map(c => table === 'users' && c === 'approved_by' ? null : row[c]));
                    } catch (error) {
                        throw new Error(`Import rolled back at ${table} record ${row.id}: ${error.code || error.message}`, { cause: error });
                    }
                }
                if (table === 'users' && selected.includes('approved_by')) {
                    for (const row of rows) if (row.approved_by !== null) await getDb().prepare('UPDATE users SET approved_by = ? WHERE id = ?').run(row.approved_by, row.id);
                }
                const target = await getDb().prepare(`SELECT COUNT(*) AS count FROM \`${table}\``).get();
                if (target.count !== rows.length) throw new Error(`Row-count mismatch for ${table}`);
                counts[table] = target.count;
            }
        }, lock)();
        return counts;
    } finally {
        if (sourceTransaction) source.exec('ROLLBACK');
        source.close();
        if (lock) {
            try {
                await lock.query('SELECT RELEASE_LOCK(?)', [`taascor-import-${process.env.DB_NAME}`.slice(0, 64)]);
            } finally {
                lock.release();
            }
        }
    }
}
if (require.main === module) {
    importSqlite(process.argv[2]).then(counts => console.log('Import complete; verified row counts:', counts))
        .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(closeDb);
}
module.exports = { importSqlite };
