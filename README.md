# Projectgroepen

A small web app where students sign up for project groups (max. 4 per group) and teachers manage the groups from a dashboard. Styled after inholland.nl (Lato, black/magenta, grey tiles, slanted hero). The UI is in Dutch.

## Run

Requires Node.js 22.13+ (uses the built-in `node:sqlite`, so there is no native build step).

```bash
npm install
npm start
```

Open http://localhost:3000. The teacher dashboard is at `/teacher`.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/projectgroepen.db` | SQLite database file |
| `TEACHER_PASSWORD` | `docent` | Teacher login (change this before real use) |
| `SESSION_SECRET` | random per start | Session cookie secret (set it so logins survive restarts) |

## Features

**Students**
- See all groups with their free places; filter to groups that still have room
- Sign up with name, student number and e-mail; one group per student
- Look up their own group, and withdraw (needs student number + e-mail) to switch groups

**Teachers**
- Overview stats (groups, students, free places, full groups)
- Create a group (capacity 1–4) or bulk-create "Groep 1…N"
- Rename/edit groups, delete groups, move students between groups, remove students
- Open or close sign-up
- Export all sign-ups as CSV (semicolon-separated for Dutch Excel)

## Design notes

- The 4-member limit is enforced three times: in validation, in a transaction in `signUp`, and by SQLite triggers on `students`, so the database itself can never hold an overfilled group.
- A unique constraint on `student_number` keeps every student in at most one group.
- Every POST form carries a per-session CSRF token; output is escaped by EJS; CSV export neutralises spreadsheet formulas.

## Tests

```bash
npm test
```

Uses Node's built-in test runner with `supertest`: database rules (capacity, duplicates, triggers, persistence) and HTTP flows (signup, concurrency, withdraw, CSRF, teacher auth, dashboard actions, CSV export). Every test uses a fresh in-memory database.

## Structure

```
server.js          entry point
src/db.js          SQLite schema and data access
src/app.js         Express routes (student + teacher)
views/             EJS templates
public/styles.css  styling
test/              automated tests
```
