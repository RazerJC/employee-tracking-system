// SQLite-compatible session store for local development.
// Uses express-session's built-in MemoryStore so no extra npm packages are needed.
// Sessions will reset on server restart — acceptable for local/dev use.
const session = require('express-session');

function createSessionStore() {
    const store = new session.MemoryStore();

    // Add an onReady() shim so server.js can call await sessionStore.onReady()
    store.onReady = () => Promise.resolve();

    // Add a close() shim so server.js can call await sessionStore.close()
    store.close = () => Promise.resolve();

    return store;
}

module.exports = { createSessionStore };
