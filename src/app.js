'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const { DomainError } = require('./db');

const STUDENT_NUMBER_RE = /^\d{6,8}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const HTTP_STATUS = {
  NOT_FOUND: 404,
  GROUP_FULL: 409,
  ALREADY_SIGNED_UP: 409,
  DUPLICATE_NAME: 409,
  SIGNUP_CLOSED: 403,
  CAPACITY_BELOW_MEMBERS: 409,
  INVALID_CAPACITY: 400,
};

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function validateSignup(body) {
  const name = String(body.name || '').trim();
  const studentNumber = String(body.studentNumber || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const errors = [];
  if (name.length < 2 || name.length > 80) errors.push('Vul je volledige naam in (2–80 tekens).');
  if (!STUDENT_NUMBER_RE.test(studentNumber)) errors.push('Een studentnummer bestaat uit 6 tot 8 cijfers.');
  if (!EMAIL_RE.test(email) || email.length > 120) errors.push('Vul een geldig e-mailadres in.');
  return { values: { name, studentNumber, email }, errors };
}

function validateGroup(body, maxSize) {
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const capacity = Number.parseInt(body.capacity ?? maxSize, 10);
  const errors = [];
  if (name.length < 1 || name.length > 60) errors.push('Geef de groep een naam (max. 60 tekens).');
  if (description.length > 500) errors.push('De omschrijving mag maximaal 500 tekens zijn.');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > maxSize) {
    errors.push(`Groepsgrootte moet tussen 1 en ${maxSize} liggen.`);
  }
  return { values: { name, description, capacity }, errors };
}

function csvCell(value) {
  let s = String(value ?? '');
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function createApp({ db, teacherPassword, sessionSecret, trustProxy = false } = {}) {
  if (!db) throw new Error('createApp requires a db');
  if (!teacherPassword) throw new Error('createApp requires a teacherPassword');

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');
  // Behind a reverse proxy (Coolify/Traefik) so req.secure reflects the original HTTPS request.
  if (trustProxy) app.set('trust proxy', 1);

  // Health check for the container platform; registered before sessions so it never creates one.
  app.get('/healthz', (req, res) => {
    db.stats();
    res.type('text/plain').send('ok');
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(
    session({
      name: 'pg.sid',
      secret: sessionSecret || crypto.randomBytes(32).toString('hex'),
      resave: false,
      saveUninitialized: false,
      // 'auto' marks the cookie Secure whenever the request came in over HTTPS.
      cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 8 * 60 * 60 * 1000 },
    })
  );

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    res.locals.isTeacher = Boolean(req.session.isTeacher);
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.path = req.path;
    res.locals.maxSize = db.MAX_GROUP_SIZE;
    next();
  });

  // Simple CSRF protection: every POST form carries the session's token.
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrf = req.session.csrf;
    if (req.method === 'POST' && !safeEqual(req.body._csrf || '', req.session.csrf)) {
      return res.status(403).render('error', { title: 'Sessie verlopen', message: 'Je sessie is verlopen. Ververs de pagina en probeer het opnieuw.' });
    }
    next();
  });

  const flash = (req, type, text) => {
    req.session.flash = { type, text };
  };

  const statusFor = (err) => HTTP_STATUS[err.code] || 400;

  // ---------- Student pages ----------

  app.get('/', (req, res) => {
    res.render('index', {
      title: 'Kies je projectgroep',
      groups: db.listGroups(),
      signupClosed: db.isSignupClosed(),
      stats: db.stats(),
    });
  });

  app.get('/groups/:id', (req, res, next) => {
    const group = db.getGroup(Number(req.params.id));
    if (!group) return next();
    res.render('group', {
      title: group.name,
      group,
      memberCount: group.member_count,
      signupClosed: db.isSignupClosed(),
      values: {},
      errors: [],
    });
  });

  app.post('/groups/:id/join', (req, res, next) => {
    const groupId = Number(req.params.id);
    const group = db.getGroup(groupId);
    if (!group) return next();
    const { values, errors } = validateSignup(req.body);
    const renderForm = (status, errs) =>
      res.status(status).render('group', {
        title: group.name,
        group: db.getGroup(groupId),
        memberCount: group.member_count,
        signupClosed: db.isSignupClosed(),
        values,
        errors: errs,
      });

    if (errors.length) return renderForm(400, errors);
    try {
      db.signUp(groupId, values);
    } catch (err) {
      if (err instanceof DomainError) return renderForm(statusFor(err), [err.message]);
      throw err;
    }
    flash(req, 'success', `Gelukt! Je bent aangemeld bij "${group.name}".`);
    res.redirect(303, '/');
  });

  app.get('/status', (req, res) => {
    const studentNumber = String(req.query.studentNumber || '').trim();
    const student = STUDENT_NUMBER_RE.test(studentNumber) ? db.findStudentByNumber(studentNumber) : null;
    res.render('status', {
      title: 'Mijn aanmelding',
      searched: Boolean(studentNumber),
      studentNumber,
      groupName: student ? student.group_name : null,
      groupId: student ? student.group_id : null,
      signupClosed: db.isSignupClosed(),
      values: {},
      errors: [],
    });
  });

  app.post('/withdraw', (req, res) => {
    const studentNumber = String(req.body.studentNumber || '').trim();
    const email = String(req.body.email || '').trim();
    const render = (status, errors) =>
      res.status(status).render('status', {
        title: 'Mijn aanmelding',
        searched: false,
        studentNumber: '',
        groupName: null,
        groupId: null,
        signupClosed: db.isSignupClosed(),
        values: { studentNumber, email },
        errors,
      });

    if (!STUDENT_NUMBER_RE.test(studentNumber) || !EMAIL_RE.test(email)) {
      return render(400, ['Vul je studentnummer en e-mailadres in.']);
    }
    try {
      const s = db.withdraw({ studentNumber, email });
      flash(req, 'success', `Je bent afgemeld bij "${s.group_name}".`);
      res.redirect(303, '/');
    } catch (err) {
      if (err instanceof DomainError) return render(statusFor(err), [err.message]);
      throw err;
    }
  });

  // ---------- Teacher pages ----------

  app.get('/teacher/login', (req, res) => {
    if (req.session.isTeacher) return res.redirect('/teacher');
    res.render('login', { title: 'Inloggen docent', error: null });
  });

  app.post('/teacher/login', (req, res) => {
    if (!safeEqual(req.body.password || '', teacherPassword)) {
      return res.status(401).render('login', { title: 'Inloggen docent', error: 'Onjuist wachtwoord.' });
    }
    req.session.regenerate((err) => {
      if (err) return res.status(500).render('error', { title: 'Fout', message: 'Inloggen mislukt.' });
      req.session.isTeacher = true;
      req.session.csrf = crypto.randomBytes(24).toString('hex');
      res.redirect(303, '/teacher');
    });
  });

  app.post('/teacher/logout', (req, res) => {
    req.session.destroy(() => res.redirect(303, '/'));
  });

  const requireTeacher = (req, res, next) => {
    if (req.session.isTeacher) return next();
    if (req.method === 'GET') return res.redirect('/teacher/login');
    res.status(401).render('error', { title: 'Niet ingelogd', message: 'Log in als docent om dit te doen.' });
  };

  const teacher = express.Router();
  teacher.use(requireTeacher);

  const renderDashboard = (res, status = 200, extra = {}) =>
    res.status(status).render('dashboard', {
      title: 'Docentendashboard',
      groups: db.listGroupsWithMembers(),
      stats: db.stats(),
      signupClosed: db.isSignupClosed(),
      newGroup: { name: '', description: '', capacity: db.MAX_GROUP_SIZE },
      errors: [],
      ...extra,
    });

  teacher.get('/', (req, res) => renderDashboard(res));

  teacher.post('/groups', (req, res) => {
    const { values, errors } = validateGroup(req.body, db.MAX_GROUP_SIZE);
    if (errors.length) return renderDashboard(res, 400, { newGroup: values, errors });
    try {
      const g = db.createGroup(values);
      flash(req, 'success', `Groep "${g.name}" aangemaakt.`);
      res.redirect(303, '/teacher');
    } catch (err) {
      if (err instanceof DomainError) return renderDashboard(res, statusFor(err), { newGroup: values, errors: [err.message] });
      throw err;
    }
  });

  teacher.post('/groups/bulk', (req, res) => {
    const count = Number.parseInt(req.body.count, 10);
    const prefix = String(req.body.prefix || 'Groep').trim().slice(0, 50) || 'Groep';
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      return renderDashboard(res, 400, { errors: ['Kies een aantal tussen 1 en 50.'] });
    }
    const existing = new Set(db.listGroups().map((g) => g.name.toLowerCase()));
    let created = 0;
    for (let n = 1; created < count; n++) {
      const name = `${prefix} ${n}`;
      if (existing.has(name.toLowerCase())) continue;
      db.createGroup({ name });
      created++;
    }
    flash(req, 'success', `${created} groepen aangemaakt.`);
    res.redirect(303, '/teacher');
  });

  teacher.post('/groups/:id/update', (req, res) => {
    const { values, errors } = validateGroup(req.body, db.MAX_GROUP_SIZE);
    if (errors.length) return renderDashboard(res, 400, { errors });
    try {
      db.updateGroup(Number(req.params.id), values);
      flash(req, 'success', `Groep "${values.name}" bijgewerkt.`);
      res.redirect(303, '/teacher');
    } catch (err) {
      if (err instanceof DomainError) return renderDashboard(res, statusFor(err), { errors: [err.message] });
      throw err;
    }
  });

  teacher.post('/groups/:id/delete', (req, res) => {
    const group = db.getGroup(Number(req.params.id));
    if (!group || !db.deleteGroup(group.id)) {
      return renderDashboard(res, 404, { errors: ['Groep niet gevonden.'] });
    }
    flash(req, 'success', `Groep "${group.name}" verwijderd.`);
    res.redirect(303, '/teacher');
  });

  teacher.post('/students/:id/remove', (req, res) => {
    if (!db.removeStudent(Number(req.params.id))) {
      return renderDashboard(res, 404, { errors: ['Student niet gevonden.'] });
    }
    flash(req, 'success', 'Student verwijderd uit de groep.');
    res.redirect(303, '/teacher');
  });

  teacher.post('/students/:id/move', (req, res) => {
    try {
      db.moveStudent(Number(req.params.id), Number(req.body.groupId));
      flash(req, 'success', 'Student verplaatst.');
      res.redirect(303, '/teacher');
    } catch (err) {
      if (err instanceof DomainError) return renderDashboard(res, statusFor(err), { errors: [err.message] });
      throw err;
    }
  });

  teacher.post('/signup-status', (req, res) => {
    const closed = req.body.closed === '1';
    db.setSignupClosed(closed);
    flash(req, 'success', closed ? 'Aanmelden is nu gesloten.' : 'Aanmelden is nu geopend.');
    res.redirect(303, '/teacher');
  });

  teacher.get('/export.csv', (req, res) => {
    const header = ['Groep', 'Naam', 'Studentnummer', 'E-mail', 'Aangemeld op'];
    const rows = db.listStudents().map((s) => [s.group_name, s.name, s.student_number, s.email, s.created_at]);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="projectgroepen.csv"');
    res.send('﻿' + csv + '\r\n');
  });

  app.use('/teacher', teacher);

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Niet gevonden', message: 'Deze pagina bestaat niet (meer).' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Er ging iets mis', message: 'Probeer het later opnieuw.' });
  });

  return app;
}

module.exports = { createApp, validateSignup, validateGroup, csvCell };
