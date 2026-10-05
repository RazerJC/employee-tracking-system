// Redirect all database access to the SQLite implementation.
// The original MySQL database.js has been superseded by database-sqlite.js
// for local development. All routes/services require('./database') and get SQLite.
const sqlite = require('./database-sqlite');

async function initializeDb() {
    return sqlite.initializeDb();
}

async function closeDb() {
    return sqlite.closeDb();
}

function getDb() {
    return sqlite.getDb();
}

function runTransaction(fn) {
    return sqlite.runTransaction(fn);
}

// Stub getPool so session-store doesn't crash — we replace the session store too
function getPool() {
    return null;
}

module.exports = { getDb, getPool, initializeDb, runTransaction, closeDb };
