'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, MAX_GROUP_SIZE } = require('../src/db');

let db;
const student = (n) => ({ name: `Student ${n}`, studentNumber: String(600000 + n), email: `s${n}@student.inholland.nl` });

beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => db.close());

test('max group size is 4', () => {
  assert.equal(MAX_GROUP_SIZE, 4);
});

test('creates a group with default capacity 4', () => {
  const g = db.createGroup({ name: 'Alpha' });
  assert.equal(g.name, 'Alpha');
  assert.equal(g.capacity, 4);
  assert.equal(g.member_count, 0);
  assert.equal(g.spots_left, 4);
});

test('rejects capacity above 4 or below 1', () => {
  assert.throws(() => db.createGroup({ name: 'Too big', capacity: 5 }), { code: 'INVALID_CAPACITY' });
  assert.throws(() => db.createGroup({ name: 'Too small', capacity: 0 }), { code: 'INVALID_CAPACITY' });
});

test('rejects duplicate group names case-insensitively', () => {
  db.createGroup({ name: 'Alpha' });
  assert.throws(() => db.createGroup({ name: 'alpha' }), { code: 'DUPLICATE_NAME' });
});

test('allows exactly 4 sign-ups and refuses the 5th', () => {
  const g = db.createGroup({ name: 'Alpha' });
  for (let i = 1; i <= 4; i++) db.signUp(g.id, student(i));
  assert.equal(db.getGroup(g.id).member_count, 4);
  assert.throws(() => db.signUp(g.id, student(5)), { code: 'GROUP_FULL' });
  assert.equal(db.getGroup(g.id).member_count, 4);
});

test('respects a smaller custom capacity', () => {
  const g = db.createGroup({ name: 'Duo', capacity: 2 });
  db.signUp(g.id, student(1));
  db.signUp(g.id, student(2));
  assert.throws(() => db.signUp(g.id, student(3)), { code: 'GROUP_FULL' });
});

test('database trigger blocks moving a student into a full group', () => {
  const g = db.createGroup({ name: 'Alpha' });
  for (let i = 1; i <= 4; i++) db.signUp(g.id, student(i));
  const other = db.createGroup({ name: 'Beta' });
  const s = db.signUp(other.id, student(9));
  assert.throws(() => db.moveStudent(s.id, g.id), { code: 'GROUP_FULL' });
  assert.equal(db.getGroup(g.id).member_count, 4);
});

test('a student can only be in one group', () => {
  const a = db.createGroup({ name: 'Alpha' });
  const b = db.createGroup({ name: 'Beta' });
  db.signUp(a.id, student(1));
  assert.throws(() => db.signUp(b.id, student(1)), { code: 'ALREADY_SIGNED_UP' });
});

test('signing up for a missing group fails with NOT_FOUND', () => {
  assert.throws(() => db.signUp(999, student(1)), { code: 'NOT_FOUND' });
});

test('withdraw requires matching student number and e-mail', () => {
  const g = db.createGroup({ name: 'Alpha' });
  db.signUp(g.id, student(1));
  assert.throws(() => db.withdraw({ studentNumber: '600001', email: 'wrong@x.nl' }), { code: 'NOT_FOUND' });
  const removed = db.withdraw({ studentNumber: '600001', email: 'S1@student.inholland.nl' });
  assert.equal(removed.group_name, 'Alpha');
  assert.equal(db.getGroup(g.id).member_count, 0);
});

test('closing sign-up blocks sign-up and withdraw', () => {
  const g = db.createGroup({ name: 'Alpha' });
  db.signUp(g.id, student(1));
  db.setSignupClosed(true);
  assert.equal(db.isSignupClosed(), true);
  assert.throws(() => db.signUp(g.id, student(2)), { code: 'SIGNUP_CLOSED' });
  assert.throws(() => db.withdraw({ studentNumber: '600001', email: 's1@student.inholland.nl' }), { code: 'SIGNUP_CLOSED' });
  db.setSignupClosed(false);
  db.signUp(g.id, student(2));
  assert.equal(db.getGroup(g.id).member_count, 2);
});

test('moving a student between groups', () => {
  const a = db.createGroup({ name: 'Alpha' });
  const b = db.createGroup({ name: 'Beta' });
  const s = db.signUp(a.id, student(1));
  db.moveStudent(s.id, b.id);
  assert.equal(db.getGroup(a.id).member_count, 0);
  assert.equal(db.getGroup(b.id).member_count, 1);
});

test('cannot lower capacity below current member count', () => {
  const g = db.createGroup({ name: 'Alpha' });
  for (let i = 1; i <= 3; i++) db.signUp(g.id, student(i));
  assert.throws(() => db.updateGroup(g.id, { name: 'Alpha', capacity: 2 }), { code: 'CAPACITY_BELOW_MEMBERS' });
  const updated = db.updateGroup(g.id, { name: 'Alpha 2', description: 'x', capacity: 3 });
  assert.equal(updated.name, 'Alpha 2');
  assert.equal(updated.spots_left, 0);
});

test('deleting a group removes its members', () => {
  const g = db.createGroup({ name: 'Alpha' });
  db.signUp(g.id, student(1));
  assert.equal(db.deleteGroup(g.id), true);
  assert.equal(db.findStudentByNumber('600001'), null);
  assert.equal(db.deleteGroup(g.id), false);
});

test('stats summarise groups and spots', () => {
  const a = db.createGroup({ name: 'Alpha' });
  db.createGroup({ name: 'Beta', capacity: 2 });
  for (let i = 1; i <= 4; i++) db.signUp(a.id, student(i));
  assert.deepEqual(db.stats(), { groups: 2, students: 4, capacity: 6, openSpots: 2, fullGroups: 1, emptyGroups: 1 });
});

test('data persists in a SQLite file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.db');
  const first = openDatabase(file);
  const g = first.createGroup({ name: 'Persisted' });
  first.signUp(g.id, student(1));
  first.close();
  const second = openDatabase(file);
  assert.equal(second.findStudentByNumber('600001').group_name, 'Persisted');
  second.close();
});
