'use strict';

const path = require('node:path');
const { openDatabase } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'projectgroepen.db');
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'docent';

if (!process.env.TEACHER_PASSWORD) {
  console.warn('TEACHER_PASSWORD not set: using the demo password "docent". Set it before real use.');
}

const db = openDatabase(DB_FILE);
const app = createApp({ db, teacherPassword: TEACHER_PASSWORD, sessionSecret: process.env.SESSION_SECRET });

app.listen(PORT, () => {
  console.log(`Projectgroepen running on http://localhost:${PORT}`);
});
