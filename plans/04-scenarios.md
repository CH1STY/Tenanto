# 04 — Key Scenarios

## 1. Reassign a unit to a new tenant

Example: Yasin occupies unit `1A`. He is deactivated and `1A` is reassigned to Sharmin.
Yasin's transaction history must remain intact.

```mermaid
sequenceDiagram
    actor Admin as SuperAdmin/Manager
    participant App
    participant DB as MongoDB

    Admin->>App: Deactivate Yasin on unit 1A
    App->>DB: Update Yasin's Tenancy (endDate=now, isActive=false)
    Note over DB: Yasin's transactions stay linked to his old tenancy
    Admin->>App: Assign Sharmin to unit 1A
    App->>DB: Create new Tenancy (unit=1A, user=Sharmin, isActive=true)
    App-->>Admin: 1A now occupied by Sharmin
```

- The old `Tenancy` is closed, not deleted.
- A new `Tenancy` is created for the same `Unit`.
- All of Yasin's `Transaction` documents remain attached to his closed tenancy.

## 2. Month-wise transactions

```mermaid
graph LR
    Ten[Tenancy: Yasin @ 1A] --> M1[2026-06 · PAID]
    Ten --> M2[2026-07 · PAID]
    Ten --> M3[2026-08 · DUE]
```

- Each month raises a `SERVICE_CHARGE` `Charge` per active tenant; `Payment`s settle it.
- Unpaid charges roll forward as dues; history stays attached to the tenant's tenancy.
- Full opening-balance / service-charge / dues / payments / month-close flow is
  documented in [07 — Monthly Ledger](./07-monthly-ledger.md).

## 3. Active building selection

```mermaid
sequenceDiagram
    actor User as Manager/SuperAdmin
    participant App
    participant DB

    User->>App: Log in
    App->>DB: Load user (activeBuildingId?)
    alt has active building
        App-->>User: Redirect to that building's dashboard
    else none set
        App-->>User: Show building selection page
    end
    User->>App: Click a building
    App->>DB: Save activeBuildingId on user
    App-->>User: Land on building dashboard (persists next login)
```

- On building click, `activeBuildingId` is saved on the user (and mirrored in an
  httpOnly cookie for fast reads).
- The user always lands on that building's dashboard until they actively switch.

## 4. Promote / demote (SuperAdmin only)

- **Promote** `TENANT → MANAGER`: set `email` + initial password → login enabled.
- **Demote** `MANAGER → TENANT`: clear `email`/`passwordHash` → login disabled;
  tenant record and history preserved.
