const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const { getPool } = require('./database');

function createSessionStore() {
    const store = new MySQLStore({
        createDatabaseTable: true,
        endConnectionOnClose: false,
        expiration: 8 * 60 * 60 * 1000,
        checkExpirationInterval: 15 * 60 * 1000
    }, getPool());

    return store;
}

module.exports = { createSessionStore };
