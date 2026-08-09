export const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  MANAGER: "MANAGER",
  TENANT: "TENANT",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Roles allowed to authenticate into the app. */
export const LOGIN_ROLES: Role[] = [ROLES.SUPER_ADMIN, ROLES.MANAGER];

export const AUDIT_ACTIONS = {
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  DELETE: "DELETE",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const PERIOD_STATUS = { OPEN: "OPEN", CLOSED: "CLOSED" } as const;
export type PeriodStatus = (typeof PERIOD_STATUS)[keyof typeof PERIOD_STATUS];

export const CHARGE_CATEGORY = {
  SERVICE_CHARGE: "SERVICE_CHARGE",
  PREVIOUS_DUE: "PREVIOUS_DUE",
  BILL: "BILL",
  OTHER: "OTHER",
} as const;
export type ChargeCategory =
  (typeof CHARGE_CATEGORY)[keyof typeof CHARGE_CATEGORY];

export const CHARGE_STATUS = {
  DUE: "DUE",
  PARTIAL: "PARTIAL",
  PAID: "PAID",
} as const;
export type ChargeStatus = (typeof CHARGE_STATUS)[keyof typeof CHARGE_STATUS];

export const INCOME_SOURCE = {
  ROOFTOP_RENT: "ROOFTOP_RENT",
  ROOFTOP_ELECTRICITY: "ROOFTOP_ELECTRICITY",
  CHARITY: "CHARITY",
  OTHER: "OTHER",
} as const;
export type IncomeSource = (typeof INCOME_SOURCE)[keyof typeof INCOME_SOURCE];

export const EXPENSE_STATUS = { PAID: "PAID", DUE: "DUE" } as const;
export type ExpenseStatus =
  (typeof EXPENSE_STATUS)[keyof typeof EXPENSE_STATUS];
