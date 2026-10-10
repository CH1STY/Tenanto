# Tenant App

Building‑wise tenant management with a month‑wise cash book: buildings, floors,
units, tenants, service charges, dues, payments, income, expenses, withdrawals,
monthly image attachments, printable/downloadable monthly cash books, a full
audit trail, and one‑click building import/export.

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
- A multi-stage Dockerfile builds the standalone server. Docker Compose can
  run it against an existing replica set via `MONGODB_URI`; only the app starts
  by default. The bundled MongoDB is opt-in for local development via
  `npm run db:up`. You can also deploy on a Node host or on **Vercel**.
- `next start` respects the `PORT` environment variable.

### Woodpecker CI and Docker deployment

The root `.woodpecker.yml` runs `npm ci`, lint, TypeScript checks, and a
production build on pushes to `main` and pull/merge requests targeting `main`.
Pull/merge requests are validated only and never deploy. Only successful
pushes to `main` build a Docker image and deploy it on the Woodpecker agent's
Docker host. Other branches do not trigger this workflow. No registry or SSH
connection is needed.

Before enabling the pipeline:

1. Use a **Linux Docker-backend agent** on the deployment host. Set its
   `WOODPECKER_AGENT_LABELS` to include `deployment=tenanto` so deployments
   always reach the same host. The host must provide
   `/var/run/docker.sock`, and port **3000** must be available.
2. Have a Woodpecker administrator enable **Trusted** for this repository;
   the build and deploy steps need the host Docker socket. This grants host
   control to pipeline code, so restrict push access and require approval
   for untrusted pull requests.
3. Add a repository secret named **`env_file`** containing the complete
   production dotenv contents (not a filename or base64 string):

   ```dotenv
   MONGODB_URI='mongodb://host.docker.internal:27017/tenant_app?replicaSet=rs0&directConnection=true'
   AUTH_SECRET='replace-with-a-strong-random-secret'
   AUTH_URL='https://tenants.example.com'
   ```

   Use the host MongoDB URI above, a reachable network IP/hostname, or an Atlas
   replica-set URI. `localhost` inside the app container refers to the app
   container, **not** the Docker host. The app and seed services map
   `host.docker.internal` to the host gateway on Linux. Host MongoDB must
   listen on a container-reachable interface and permit access through the
   firewall; restrict that access to trusted clients. Quote
   values containing `$` with single quotes to prevent Compose interpolation.
   Allow the secret for **push** events only, not pull requests. If using an
   image restriction, allow `docker:29-cli`.
4. Enable **Cancel previous pipelines** for push events to avoid overlapping
   deployments of this repository. Do not run another deployment pipeline
   against the same Compose project concurrently.

The Docker image is tagged `tenanto:<commit SHA>`. Production environment
values are written to a permission-restricted temporary `.env` only in the
deploy step, passed to Compose, then removed on exit. Environment files are
excluded from the Docker build context. Build checks use a non-secret MongoDB
URI solely for import-time validation and do not connect to production.

Deployment uses the stable Compose project name `tenanto`, starts **only the
Next.js app**, and waits for the app's `/login` health check.
A failed health check fails the pipeline; automatic rollback is not provided.
The login check verifies HTTP readiness, not database connectivity. MongoDB
is managed separately and is never started by the deployment pipeline.
If an earlier deployment already started `tenant-mongo`, this change does not
stop or delete it; stop it separately only after migrating any required data.

The pipeline does **not** seed or reset the database. Seed the first admin
once using `docker compose --project-name tenanto --profile seed run --rm seed`
on the host with the production environment and `SEED_SUPERADMIN_*` values
available. The host needs a checkout of the project for this one-time command.

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

## Import & export buildings

A **SuperAdmin** can move a building — with all of its data — between
environments as a single self‑contained JSON file, from **Buildings**.

- **Export** (per building): downloads a `<building>_<date>.json` file
  containing the building, its units, tenants, tenancies, monthly periods,
  charges, payments, income, expenses, withdrawals, and every attached month
  image (bundled as base64). Available at
  `GET /admin/buildings/export/[buildingId]`.
- **Import**: upload an exported JSON file to recreate it as a **brand‑new**
  building. Every record is given a fresh id and all cross‑references (units,
  tenancies, charges, payments, and month images) are remapped, so an import
  never collides with existing data and stays fully self‑consistent. Imports
  never overwrite an existing building.

Notes:

- The export format is versioned (`BUILDING_EXPORT_VERSION`); older v1 exports
  (without images) still import cleanly.
- Import files are capped at **30 MB**. Because images are embedded as base64,
  the server‑action body limit is raised accordingly in `next.config.ts`.
- Deleting a building removes all of its scoped records, including attached
  images, so nothing is left orphaned.

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
