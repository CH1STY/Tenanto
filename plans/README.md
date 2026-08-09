# Tenant-App — Planning Docs

Building-wise tenant management application. This folder holds the finalized plan
(no application code yet).

## Index

| #   | Document                                       | Contents                                                      |
| --- | ---------------------------------------------- | ------------------------------------------------------------- |
| 00  | [Overview](./00-overview.md)                   | Problem statement, goals, scope                               |
| 01  | [Tech Stack](./01-stack.md)                    | Chosen technologies and why                                   |
| 02  | [Roles & RBAC](./02-roles-rbac.md)             | Roles, permissions, promote/demote flows                      |
| 03  | [Data Model](./03-data-model.md)               | Collections, ERD, indexes                                     |
| 04  | [Key Scenarios](./04-scenarios.md)             | Unit reassignment, transactions, active building              |
| 05  | [Security](./05-security.md)                   | Threat model & hardening measures                             |
| 06  | [Project Structure](./06-project-structure.md) | Folder layout & build phases                                  |
| 07  | [Monthly Ledger](./07-monthly-ledger.md)       | Opening balance, service charges, dues, payments, month close |
| 08  | [Cash Book View](./08-cashbook-view.md)        | Two-sided cash book layout mapped to the real July 2026 sheet |

## Status

- **Phase:** Planning complete — awaiting approval to scaffold.
- **Last updated:** 2026-08-08

## Quick summary

- **Stack:** Next.js (App Router) + TypeScript, Tailwind + shadcn/ui, MongoDB + Mongoose, Auth.js (JWT + bcrypt), Zod.
- **Logins:** `SUPER_ADMIN` and `MANAGER` only. `TENANT` is a record (no login) unless promoted.
- **Core domain:** Buildings → Floors/Units → Tenancies → month-wise Transactions, with full history preserved on reassignment.
