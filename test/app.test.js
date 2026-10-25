'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { openDatabase } = require('../src/db');
const { createApp, csvCell } = require('../src/app');

const PASSWORD = 'test-password';
let db;
let app;

beforeEach(() => {
  db = openDatabase(':memory:');
  app = createApp({ db, teacherPassword: PASSWORD, sessionSecret: 'test-secret' });
});
afterEach(() => db.close());

async function csrfFor(agent, url = '/') {
  const res = await agent.get(url);
  const match = res.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, `no CSRF token on ${url}`);
  return match[1];
}

async function teacherAgent() {
  const agent = request.agent(app);
  const token = await csrfFor(agent, '/teacher/login');
  await agent.post('/teacher/login').type('form').send({ _csrf: token, password: PASSWORD }).expect(303);
  return agent;
}

const form = (n, extra = {}) => ({
  name: `Student ${n}`,
  studentNumber: String(700000 + n),
  email: `s${n}@student.inholland.nl`,
  ...extra,
});

async function join(groupId, n, extra) {
  const agent = request.agent(app);
  // The login page always carries a form, even when sign-up is closed.
  const token = await csrfFor(agent, '/teacher/login');
  return agent.post(`/groups/${groupId}/join`).type('form').send({ _csrf: token, ...form(n, extra) });
}

// ---------- Student flows ----------

test('home page lists groups with free spots', async () => {
  const g = db.createGroup({ name: 'Team Tulp', description: 'Webshop voor bloemen' });
  db.signUp(g.id, { name: 'A', studentNumber: '111111', email: 'a@x.nl' });
  const res = await request(app).get('/').expect(200);
  assert.match(res.text, /Team Tulp/);
  assert.match(res.text, /3 plekken vrij/);
  assert.match(res.text, /Webshop voor bloemen/);
});

test('home page shows an empty state without groups', async () => {
  const res = await request(app).get('/').expect(200);
  assert.match(res.text, /Nog geen groepen/);
});

test('group page shows the sign-up form', async () => {
  const g = db.createGroup({ name: 'Alpha' });
  const res = await request(app).get(`/groups/${g.id}`).expect(200);
  assert.match(res.text, /Meld je aan/);
  assert.match(res.text, /0 van 4 plekken bezet/);
});

test('student can sign up for a group', async () => {
  const g = db.createGroup({ name: 'Alpha' });
  const res = await join(g.id, 1);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/');
  assert.equal(db.getGroup(g.id).member_count, 1);
});

test('5th student is refused with 409 and the group stays at 4', async () => {
  const g = db.createGroup({ name: 'Alpha' });
  for (let i = 1; i <= 4; i++) assert.equal((await join(g.id, i)).status, 303);
  const res = await join(g.id, 5);
  assert.equal(res.status, 409);
  assert.match(res.text, /vol/);
  assert.equal(db.getGroup(g.id).member_count, 4);
});

test('concurrent sign-ups never exceed 4', async () => {
  const g = db.createGroup({ name: 'Rush' });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => join(g.id, i + 1)));
  assert.equal(results.filter((r) => r.status === 303).length, 4);
  assert.equal(db.getGroup(g.id).member_count, 4);
});

test('student cannot join a second group', async () => {
  const a = db.createGroup({ name: 'Alpha' });
  const b = db.createGroup({ name: 'Beta' });
  await join(a.id, 1);
  const res = await join(b.id, 1);
  assert.equal(res.status, 409);
  assert.match(res.text, /al aangemeld bij groep &#34;Alpha&#34;/);
});

test('invalid sign-up input is rejected', async () => {
  const g = db.createGroup({ name: 'Alpha' });
  const res = await join(g.id, 1, { studentNumber: 'abc', email: 'nope', name: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /studentnummer bestaat uit 6 tot 8 cijfers/);
  assert.match(res.text, /geldig e-mailadres/);
  assert.equal(db.getGroup(g.id).member_count, 0);
});

test('user input is HTML-escaped', async () => {
  db.createGroup({ name: '<script>alert(1)</script>' });
  const res = await request(app).get('/').expect(200);
  assert.doesNotMatch(res.text, /<script>alert\(1\)<\/script>/);
  assert.match(res.text, /&lt;script&gt;/);
});

test('POST without CSRF token is rejected', async () => {
  const g = db.createGroup({ name: 'Alpha' });
  await request(app).post(`/groups/${g.id}/join`).type('form').send(form(1)).expect(403);
  assert.equal(db.getGroup(g.id).member_count, 0);
});

test('unknown group returns 404', async () => {
  await request(app).get('/groups/999').expect(404);
});

test('status page finds the group of a student', async () => {
  const g = db.createGroup({ name: 'Alpha' });
  await join(g.id, 1);
  const res = await request(app).get('/status?studentNumber=700001').expect(200);
  assert.match(res.text, /aangemeld bij[\s\S]*Alpha/);
  const none = await request(app).get('/status?studentNumber=123456').expect(200);
  assert.match(none.text, /Geen aanmelding gevonden/);
});

test('student can withdraw with number and e-mail', async () => {
  const g = db.createGroup({ name: 'Alpha' });
  await join(g.id, 1);
  const agent = request.agent(app);
  const token = await csrfFor(agent, '/status');
  await agent.post('/withdraw').type('form').send({ _csrf: token, studentNumber: '700001', email: 'wrong@x.nl' }).expect(404);
  assert.equal(db.getGroup(g.id).member_count, 1);
  await agent.post('/withdraw').type('form').send({ _csrf: token, studentNumber: '700001', email: 's1@student.inholland.nl' }).expect(303);
  assert.equal(db.getGroup(g.id).member_count, 0);
});

test('sign-up is refused when the teacher closed it', async () => {
  const g = db.createGroup({ name: 'Alpha' });
  db.setSignupClosed(true);
  const page = await request(app).get('/').expect(200);
  assert.match(page.text, /Aanmelden is op dit moment gesloten/);
  const res = await join(g.id, 1);
  assert.equal(res.status, 403);
  assert.equal(db.getGroup(g.id).member_count, 0);
});

// ---------- Teacher flows ----------

test('dashboard requires login', async () => {
  const res = await request(app).get('/teacher').expect(302);
  assert.equal(res.headers.location, '/teacher/login');
  await request(app).get('/teacher/export.csv').expect(302);
});

test('wrong password is rejected', async () => {
  const agent = request.agent(app);
  const token = await csrfFor(agent, '/teacher/login');
  const res = await agent.post('/teacher/login').type('form').send({ _csrf: token, password: 'nope' }).expect(401);
  assert.match(res.text, /Onjuist wachtwoord/);
  await agent.get('/teacher').expect(302);
});

test('teacher sees groups, members and stats', async () => {
  const g = db.createGroup({ name: 'Alpha' });
  await join(g.id, 1);
  const agent = await teacherAgent();
  const res = await agent.get('/teacher').expect(200);
  assert.match(res.text, /Docentendashboard/);
  assert.match(res.text, /Student 1/);
  assert.match(res.text, /700001/);
  assert.match(res.text, /1\/4/);
});

test('teacher creates a group; capacity 5 and duplicates are refused', async () => {
  const agent = await teacherAgent();
  const token = await csrfFor(agent, '/teacher');
  await agent.post('/teacher/groups').type('form').send({ _csrf: token, name: 'Nieuw', description: 'd', capacity: '3' }).expect(303);
  assert.equal(db.listGroups()[0].capacity, 3);
  const bad = await agent.post('/teacher/groups').type('form').send({ _csrf: token, name: 'Groot', capacity: '5' }).expect(400);
  assert.match(bad.text, /tussen 1 en 4/);
  const dup = await agent.post('/teacher/groups').type('form').send({ _csrf: token, name: 'nieuw', capacity: '4' }).expect(409);
  assert.match(dup.text, /bestaat al/);
});

test('teacher bulk-creates groups without clashing names', async () => {
  db.createGroup({ name: 'Groep 1' });
  const agent = await teacherAgent();
  const token = await csrfFor(agent, '/teacher');
  await agent.post('/teacher/groups/bulk').type('form').send({ _csrf: token, prefix: 'Groep', count: '3' }).expect(303);
  assert.deepEqual(db.listGroups().map((g) => g.name), ['Groep 1', 'Groep 2', 'Groep 3', 'Groep 4']);
});

test('teacher edits, moves, removes and deletes', async () => {
  const a = db.createGroup({ name: 'Alpha' });
  const b = db.createGroup({ name: 'Beta' });
  const s1 = db.signUp(a.id, { name: 'One', studentNumber: '100001', email: 'one@x.nl' });
  const s2 = db.signUp(a.id, { name: 'Two', studentNumber: '100002', email: 'two@x.nl' });
  const agent = await teacherAgent();
  const token = await csrfFor(agent, '/teacher');

  await agent.post(`/teacher/groups/${a.id}/update`).type('form').send({ _csrf: token, name: 'Alpha+', description: 'x', capacity: '2' }).expect(303);
  assert.equal(db.getGroup(a.id).name, 'Alpha+');
  await agent.post(`/teacher/groups/${a.id}/update`).type('form').send({ _csrf: token, name: 'Alpha+', capacity: '1' }).expect(409);

  await agent.post(`/teacher/students/${s1.id}/move`).type('form').send({ _csrf: token, groupId: String(b.id) }).expect(303);
  assert.equal(db.getGroup(b.id).member_count, 1);

  await agent.post(`/teacher/students/${s2.id}/remove`).type('form').send({ _csrf: token }).expect(303);
  assert.equal(db.getGroup(a.id).member_count, 0);

  await agent.post(`/teacher/groups/${b.id}/delete`).type('form').send({ _csrf: token }).expect(303);
  assert.equal(db.getGroup(b.id), null);
  assert.equal(db.findStudentByNumber('100001'), null);
});

test('teacher cannot move a student into a full group', async () => {
  const full = db.createGroup({ name: 'Full', capacity: 1 });
  const other = db.createGroup({ name: 'Other' });
  db.signUp(full.id, { name: 'A', studentNumber: '200001', email: 'a@x.nl' });
  const s = db.signUp(other.id, { name: 'B', studentNumber: '200002', email: 'b@x.nl' });
  const agent = await teacherAgent();
  const token = await csrfFor(agent, '/teacher');
  const res = await agent.post(`/teacher/students/${s.id}/move`).type('form').send({ _csrf: token, groupId: String(full.id) }).expect(409);
  assert.match(res.text, /vol/);
});

test('teacher toggles sign-up open/closed', async () => {
  const agent = await teacherAgent();
  const token = await csrfFor(agent, '/teacher');
  await agent.post('/teacher/signup-status').type('form').send({ _csrf: token, closed: '1' }).expect(303);
  assert.equal(db.isSignupClosed(), true);
  await agent.post('/teacher/signup-status').type('form').send({ _csrf: token, closed: '0' }).expect(303);
  assert.equal(db.isSignupClosed(), false);
});

test('teacher exports CSV with formula injection neutralised', async () => {
  const g = db.createGroup({ name: 'Alpha' });
  db.signUp(g.id, { name: '=HYPERLINK("x")', studentNumber: '300001', email: 'a@x.nl' });
  const agent = await teacherAgent();
  const res = await agent.get('/teacher/export.csv').expect(200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.text, /Groep;Naam;Studentnummer;E-mail/);
  assert.match(res.text, /Alpha;"'=HYPERLINK\(""x""\)";300001;a@x\.nl/);
});

test('teacher actions require login', async () => {
  const agent = request.agent(app);
  const token = await csrfFor(agent, '/status');
  await agent.post('/teacher/groups').type('form').send({ _csrf: token, name: 'X', capacity: '4' }).expect(401);
  assert.equal(db.listGroups().length, 0);
});

test('logout ends the teacher session', async () => {
  const agent = await teacherAgent();
  const token = await csrfFor(agent, '/teacher');
  await agent.post('/teacher/logout').type('form').send({ _csrf: token }).expect(303);
  await agent.get('/teacher').expect(302);
});

test('csvCell escapes separators and formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('+1'), "'+1");
});
