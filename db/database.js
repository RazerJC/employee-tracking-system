require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
let pool;
const transactions = new AsyncLocalStorage();

function databaseOptions() {
    for (const key of ['DB_HOST', 'DB_USER', 'DB_NAME']) {
        if (!process.env[key]) throw new Error(key + ' is required. Configure MySQL in .env or your hosting panel.');
    }
    return {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME,
        charset: 'utf8mb4_unicode_ci',
        timezone: 'Z',
        dateStrings: true,
        decimalNumbers: true,
        waitForConnections: true,
        connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
        queueLimit: 100,
        multipleStatements: false,
        ...(process.env.DB_SSL === 'true' ? {
            ssl: {
                rejectUnauthorized: true,
                ...(process.env.DB_SSL_CA ? { ca: fs.readFileSync(process.env.DB_SSL_CA, 'utf8') } : {})
            }
        } : {})
    };
}

function getPool() {
    if (!pool) {
        pool = mysql.createPool(databaseOptions());
        pool.on('connection', connection => {
            connection.query("SET time_zone = '+00:00'", error => {
                if (error) connection.destroy();
            });
        });
    }
    return pool;
}

function parameter(value) {
    if (value === undefined) return null;
    // Convert ISO token timestamps to UTC MySQL DATETIME strings
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
        return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
    }
    return value;
}

const database = {
    prepare(sql) {
        const query = async params => {
            const connection = transactions.getStore() || getPool();
            const [result] = await connection.execute(sql, (params || []).map(parameter));
            return result;
        };
        return {
            async get(...params) {
                const rows = await query(params);
                return rows ? rows[0] : null;
            },
            async all(...params) {
                return (await query(params)) || [];
            },
            async run(...params) {
                const result = await query(params);
                return {
                    changes: result ? result.affectedRows : 0,
                    lastInsertRowid: result ? result.insertId : 0
                };
            }
        };
    },
    async exec(sql) {
        return (transactions.getStore() || getPool()).query(sql);
    },
    transaction(fn, providedConnection) {
        return async (...args) => {
            if (transactions.getStore()) return fn(...args);
            const connection = providedConnection || await getPool().getConnection();
            try {
                await connection.beginTransaction();
                const result = await transactions.run(connection, () => fn(...args));
                await connection.commit();
                return result;
            } catch (error) {
                await connection.rollback();
                throw error;
            } finally {
                if (!providedConnection) connection.release();
            }
        };
    }
};

function getDb() {
    return database;
}

async function initializeDb() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const connection = await getPool().getConnection();
    const lockName = `taascor-schema-${process.env.DB_NAME}`.slice(0, 64);
    try {
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
        if (lock.acquired !== 1) throw new Error('Could not acquire the schema initialization lock.');
        for (const statement of schema.split(';').map(sql => sql.trim()).filter(Boolean)) {
            await connection.query(statement);
        }
        const [columns] = await connection.query('SHOW COLUMNS FROM coordinator_attendance');
        const existing = new Set(columns.map(column => column.Field));
        const cameraColumns = schema.matchAll(/^    (time_(?:in|out)_(?:photo|lat|lng|accuracy|location)) ([^,]+),$/gm);
        for (const [, name, type] of cameraColumns) {
            if (!existing.has(name)) {
                await connection.query(`ALTER TABLE coordinator_attendance ADD COLUMN \`${name}\` ${type}`);
            }
        }
    } finally {
        try {
            await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
        } finally {
            connection.release();
        }
    }
    return database;
}

async function closeDb() {
    if (pool) {
        const current = pool;
        pool = undefined;
        await current.end();
    }
}

function runTransaction(fn) {
    return database.transaction(fn)();
}

module.exports = { getDb, getPool, initializeDb, runTransaction, closeDb, databaseOptions };
