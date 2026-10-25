'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MAX_GROUP_SIZE = 4;

const SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT    NOT NULL DEFAULT '',
    capacity    INTEGER NOT NULL DEFAULT ${MAX_GROUP_SIZE}
                CHECK (capacity BETWEEN 1 AND ${MAX_GROUP_SIZE}),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS students (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id       INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name           TEXT    NOT NULL,
    student_number TEXT    NOT NULL UNIQUE,
    email          TEXT    NOT NULL,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_students_group ON students(group_id);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Last line of defence: the database itself refuses to overfill a group,
  -- even if application code is bypassed.
  CREATE TRIGGER IF NOT EXISTS trg_students_capacity
  BEFORE INSERT ON students
  WHEN (SELECT COUNT(*) FROM students WHERE group_id = NEW.group_id)
       >= (SELECT capacity FROM groups WHERE id = NEW.group_id)
  BEGIN
    SELECT RAISE(ABORT, 'GROUP_FULL');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_students_capacity_move
  BEFORE UPDATE OF group_id ON students
  WHEN NEW.group_id <> OLD.group_id
   AND (SELECT COUNT(*) FROM students WHERE group_id = NEW.group_id)
       >= (SELECT capacity FROM groups WHERE id = NEW.group_id)
  BEGIN
    SELECT RAISE(ABORT, 'GROUP_FULL');
  END;
`;

class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function openDatabase(filename = ':memory:') {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec(SCHEMA);

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function translate(err) {
    if (err instanceof DomainError) return err;
    const msg = String(err && err.message);
    if (msg.includes('GROUP_FULL')) return new DomainError('GROUP_FULL', 'Deze groep is al vol.');
    if (msg.includes('students.student_number')) {
      return new DomainError('ALREADY_SIGNED_UP', 'Dit studentnummer is al aangemeld bij een groep.');
    }
    if (msg.includes('groups.name')) return new DomainError('DUPLICATE_NAME', 'Er bestaat al een groep met deze naam.');
    if (msg.includes('CHECK constraint')) {
      return new DomainError('INVALID_CAPACITY', `Groepsgrootte moet tussen 1 en ${MAX_GROUP_SIZE} liggen.`);
    }
    return err;
  }

  const q = {
    listGroups: db.prepare(`
      SELECT g.id, g.name, g.description, g.capacity, g.created_at,
             COUNT(s.id) AS member_count
      FROM groups g LEFT JOIN students s ON s.group_id = g.id
      GROUP BY g.id ORDER BY g.name COLLATE NOCASE`),
    getGroup: db.prepare(`
      SELECT g.id, g.name, g.description, g.capacity, g.created_at,
             (SELECT COUNT(*) FROM students WHERE group_id = g.id) AS member_count
      FROM groups g WHERE g.id = ?`),
    insertGroup: db.prepare('INSERT INTO groups (name, description, capacity) VALUES (?, ?, ?)'),
    updateGroup: db.prepare('UPDATE groups SET name = ?, description = ?, capacity = ? WHERE id = ?'),
    deleteGroup: db.prepare('DELETE FROM groups WHERE id = ?'),
    membersOf: db.prepare('SELECT * FROM students WHERE group_id = ? ORDER BY created_at, id'),
    allStudents: db.prepare(`
      SELECT s.*, g.name AS group_name FROM students s JOIN groups g ON g.id = s.group_id
      ORDER BY g.name COLLATE NOCASE, s.name COLLATE NOCASE`),
    studentByNumber: db.prepare(`
      SELECT s.*, g.name AS group_name FROM students s JOIN groups g ON g.id = s.group_id
      WHERE s.student_number = ?`),
    getStudent: db.prepare('SELECT * FROM students WHERE id = ?'),
    insertStudent: db.prepare('INSERT INTO students (group_id, name, student_number, email) VALUES (?, ?, ?, ?)'),
    deleteStudent: db.prepare('DELETE FROM students WHERE id = ?'),
    moveStudent: db.prepare('UPDATE students SET group_id = ? WHERE id = ?'),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                            ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  };

  const plain = (row) => (row ? { ...row } : row);

  return {
    MAX_GROUP_SIZE,

    close: () => db.close(),

    listGroups() {
      return q.listGroups.all().map((g) => ({ ...g, spots_left: g.capacity - g.member_count }));
    },

    listGroupsWithMembers() {
      return this.listGroups().map((g) => ({ ...g, members: q.membersOf.all(g.id).map(plain) }));
    },

    getGroup(id) {
      const g = q.getGroup.get(id);
      return g ? { ...g, spots_left: g.capacity - g.member_count } : null;
    },

    createGroup({ name, description = '', capacity = MAX_GROUP_SIZE }) {
      try {
        const res = q.insertGroup.run(name, description, capacity);
        return this.getGroup(Number(res.lastInsertRowid));
      } catch (err) {
        throw translate(err);
      }
    },

    updateGroup(id, { name, description = '', capacity }) {
      try {
        return transaction(() => {
          const group = this.getGroup(id);
          if (!group) throw new DomainError('NOT_FOUND', 'Groep niet gevonden.');
          if (capacity < group.member_count) {
            throw new DomainError(
              'CAPACITY_BELOW_MEMBERS',
              `Deze groep heeft al ${group.member_count} leden; de grootte kan niet lager worden.`
            );
          }
          q.updateGroup.run(name, description, capacity, id);
          return this.getGroup(id);
        });
      } catch (err) {
        throw translate(err);
      }
    },

    deleteGroup(id) {
      return q.deleteGroup.run(id).changes > 0;
    },

    signUp(groupId, { name, studentNumber, email }) {
      try {
        return transaction(() => {
          if (this.isSignupClosed()) throw new DomainError('SIGNUP_CLOSED', 'Aanmelden is gesloten.');
          const group = this.getGroup(groupId);
          if (!group) throw new DomainError('NOT_FOUND', 'Groep niet gevonden.');
          const existing = q.studentByNumber.get(studentNumber);
          if (existing) {
            throw new DomainError(
              'ALREADY_SIGNED_UP',
              `Je bent al aangemeld bij groep "${existing.group_name}". Meld je eerst af.`
            );
          }
          if (group.spots_left <= 0) throw new DomainError('GROUP_FULL', 'Deze groep is al vol.');
          const res = q.insertStudent.run(groupId, name, studentNumber, email);
          return plain(q.getStudent.get(Number(res.lastInsertRowid)));
        });
      } catch (err) {
        throw translate(err);
      }
    },

    // Students withdraw themselves by proving they know both number and e-mail.
    withdraw({ studentNumber, email }) {
      return transaction(() => {
        if (this.isSignupClosed()) throw new DomainError('SIGNUP_CLOSED', 'Aanmelden en afmelden is gesloten.');
        const s = q.studentByNumber.get(studentNumber);
        if (!s || s.email.toLowerCase() !== email.toLowerCase()) {
          throw new DomainError('NOT_FOUND', 'Geen aanmelding gevonden met dit studentnummer en e-mailadres.');
        }
        q.deleteStudent.run(s.id);
        return plain(s);
      });
    },

    findStudentByNumber(studentNumber) {
      return plain(q.studentByNumber.get(studentNumber)) || null;
    },

    listStudents() {
      return q.allStudents.all().map(plain);
    },

    removeStudent(id) {
      return q.deleteStudent.run(id).changes > 0;
    },

    moveStudent(studentId, groupId) {
      try {
        return transaction(() => {
          if (!q.getStudent.get(studentId)) throw new DomainError('NOT_FOUND', 'Student niet gevonden.');
          if (!this.getGroup(groupId)) throw new DomainError('NOT_FOUND', 'Groep niet gevonden.');
          q.moveStudent.run(groupId, studentId);
          return plain(q.getStudent.get(studentId));
        });
      } catch (err) {
        throw translate(err);
      }
    },

    isSignupClosed() {
      const row = q.getSetting.get('signup_closed');
      return row ? row.value === '1' : false;
    },

    setSignupClosed(closed) {
      q.setSetting.run('signup_closed', closed ? '1' : '0');
    },

    stats() {
      const groups = this.listGroups();
      const capacity = groups.reduce((n, g) => n + g.capacity, 0);
      const students = groups.reduce((n, g) => n + g.member_count, 0);
      return {
        groups: groups.length,
        students,
        capacity,
        openSpots: capacity - students,
        fullGroups: groups.filter((g) => g.spots_left === 0).length,
        emptyGroups: groups.filter((g) => g.member_count === 0).length,
      };
    },
  };
}

module.exports = { openDatabase, DomainError, MAX_GROUP_SIZE };
