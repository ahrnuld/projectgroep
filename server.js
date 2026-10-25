'use strict';

const path = require('node:path');
const { openDatabase } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'projectgroepen.db');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
let TEACHER_PASSWORD = process.env.TEACHER_PASSWORD;

if (!TEACHER_PASSWORD) {
  if (IS_PRODUCTION) {
    // The repository is public, so a default password would be known to everyone.
    console.error('TEACHER_PASSWORD must be set when NODE_ENV=production.');
    process.exit(1);
  }
  TEACHER_PASSWORD = 'docent';
  console.warn('TEACHER_PASSWORD not set: using the demo password "docent". Set it before real use.');
}

const db = openDatabase(DB_FILE);
const app = createApp({
  db,
  teacherPassword: TEACHER_PASSWORD,
  sessionSecret: process.env.SESSION_SECRET,
  trustProxy: IS_PRODUCTION || process.env.TRUST_PROXY === '1',
});

const server = app.listen(PORT, () => {
  console.log(`Projectgroepen running on http://localhost:${PORT} (database: ${DB_FILE})`);
});

// Close the database cleanly when the container is stopped or redeployed.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
