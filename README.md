# NASC SPORTS

A premium, minimal sports portal for the Physical Education Department.

## Stack
- Frontend: HTML + CSS + vanilla JavaScript
- Backend: Node.js + Express
- Database: SQLite
- App support: PWA manifest + service worker

## Run on a computer
1. Install Node.js LTS.
2. Open a terminal in this folder.
3. Run:
   npm install
   npm start
4. Open http://localhost:3000

Default staff password: `NASCPD`

For a real deployment, set a strong `STAFF_PASSWORD` and `SESSION_SECRET` using environment variables.

## Main features
- Home page
- Upcoming fixtures with search
- Staff-only event creation/edit/delete
- Staff-controlled registration toggle
- Student registration forms
- Staff registered-student list
- Anonymous enquiries/complaints
- Direct email link to nascpd@nehrucolleges.com
- Responsive mobile design
- PWA structure so it can be installed like an app

## Important security note
The default password is included because it was requested for the prototype. Before publishing publicly, change it in your deployment environment. For a college-wide production system, you should also add proper staff accounts/roles, HTTPS, backups, rate limiting and stronger authentication.
