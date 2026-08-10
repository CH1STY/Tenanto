# Tenant App

Building‑wise tenant management with a month‑wise cash book: buildings, floors,
units, tenants, service charges, dues, payments, income, expenses, withdrawals,
printable/downloadable monthly cash books, and a full audit trail.

## Tech stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **MongoDB** + **Mongoose** — requires a **replica set** (multi‑document transactions are used)
- **Auth.js (NextAuth v5)** — JWT sessions + bcrypt password hashing
- **Tailwind CSS v4**, **Zod**

## Prerequisites

- **Node.js 20+** and npm
- One of:
  - **Docker + Docker Compose** (recommended for local — provides a single‑node MongoDB replica set), or
  - A **MongoDB replica set** / **MongoDB Atlas** cluster you can connect to

## Environment variables

Create a `.env.local` in the project root for local development. In production,
set the same variables in your host/platform environment.

| Variable                   | Required    | Description                                                                       |
| -------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `MONGODB_URI`              | yes         | Mongo connection string. **Must point to a replica set** (transactions are used). |
| `AUTH_SECRET`              | yes         | Secret used by Auth.js to encrypt sessions. Generate a strong random value.       |
| `AUTH_URL`                 | production  | Canonical public URL of the app, e.g. `https://tenants.example.com`.              |
| `SEED_SUPERADMIN_NAME`     | for seeding | Display name for the initial SuperAdmin.                                          |
| `SEED_SUPERADMIN_EMAIL`    | for seeding | Login email for the initial SuperAdmin.                                           |
| `SEED_SUPERADMIN_PASSWORD` | for seeding | Initial password for the SuperAdmin (change after first login).                   |

Example `.env.local`:

```dotenv
# Local MongoDB (single-node replica set from docker-compose.yml)
MONGODB_URI="mongodb://127.0.0.1:27017/tenant_app?directConnection=true"

# Generate one with: npx auth secret   (or: openssl rand -base64 32)
AUTH_SECRET="replace-with-a-strong-random-secret"
AUTH_URL="http://localhost:3000"

# Used once by `npm run seed`
SEED_SUPERADMIN_NAME="Super Admin"
SEED_SUPERADMIN_EMAIL="admin@example.com"
SEED_SUPERADMIN_PASSWORD="ChangeMe!2026"
```

> Do **not** commit `.env.local`. Generate a fresh `AUTH_SECRET` per environment.

## Run locally

```bash
npm install          # install dependencies
npm run db:up        # start MongoDB (single-node replica set) in Docker
npm run seed         # create the SuperAdmin + demo building
npm run dev          # start the dev server
```

Or do it all in one command:

```bash
npm run start:all    # db:up + seed + dev
```

Open http://localhost:3000 and sign in at `/login` with the seeded
`SEED_SUPERADMIN_EMAIL` / `SEED_SUPERADMIN_PASSWORD`.

### Local database commands

| Command            | What it does                                              |
| ------------------ | --------------------------------------------------------- |
| `npm run db:up`    | Start MongoDB and wait until healthy (replica set ready). |
| `npm run db:down`  | Stop MongoDB (keeps data).                                |
| `npm run db:reset` | Stop MongoDB and **delete its data volume** (wipe all).   |
| `npm run db:logs`  | Tail MongoDB logs.                                        |

To wipe all data and start fresh locally:

```bash
npm run db:reset && npm run db:up && npm run seed
```

## Run in production

1. **Provision MongoDB** as a replica set — the simplest is a free/managed
   **MongoDB Atlas** cluster (Atlas is a replica set by default). Self‑hosted
   MongoDB must be configured as a replica set. Get its connection string
   (`mongodb+srv://user:pass@cluster/tenant_app`).

2. **Set environment variables** on the host/platform:
   `MONGODB_URI`, `AUTH_SECRET`, `AUTH_URL`, and (for the one‑time seed)
   `SEED_SUPERADMIN_*`.

3. **Build and start:**

   ```bash
   npm ci
   npm run build
   npm run start          # listens on $PORT (default 3000)
   ```

4. **Seed the first admin once** against the production database, then rotate
   the seed password:

   ```bash
   npm run seed
   ```

   (`npm run seed` reads `.env.local`; in production run the seed with the
   production env vars available, e.g. `node scripts/seed.mjs` with env set.)

### Production notes

- Serve behind **HTTPS** and set `AUTH_URL` to the public URL.
- Generate a strong `AUTH_SECRET` per environment (`npx auth secret` or
  `openssl rand -base64 32`).
- No Dockerfile is included; deploy on any Node host with `npm run build` +
  `npm run start`, or on **Vercel** (set the env vars and use MongoDB Atlas).
- `next start` respects the `PORT` environment variable.

## Roles & first steps

- **SUPER_ADMIN** — full control: buildings, units, admins, roles, audit logs.
- **MANAGER (admin)** — manages tenants and the cash book for the specific
  buildings assigned to them.
- **TENANT** — a record occupying a unit (no login).

After first sign‑in as SuperAdmin:

1. Create a building and its units (**Buildings**).
2. Add tenants and assign them to units.
3. Add admins and grant them building access (**Admins**).
4. Open a month in a building's **Cash book** and start recording payments,
   income, expenses and withdrawals.

## Scripts

| Script              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Start the development server.                  |
| `npm run build`     | Production build.                              |
| `npm run start`     | Start the production server (after `build`).   |
| `npm run lint`      | Run ESLint.                                    |
| `npm run seed`      | Create the SuperAdmin + demo building.         |
| `npm run db:up`     | Start local MongoDB (Docker).                  |
| `npm run db:down`   | Stop local MongoDB.                            |
| `npm run db:reset`  | Stop local MongoDB and delete its data volume. |
| `npm run db:logs`   | Tail local MongoDB logs.                       |
| `npm run setup`     | `db:up` + `seed`.                              |
| `npm run start:all` | `db:up` + `seed` + `dev`.                      |
