// The Phase 2 permission vocabulary (CONTRACT §2.1–2.2): the 7 actions, the 3 data scopes, the
// resource string format, and the role-default table from §2.4. Shared by access.ts, the seed,
// the permissions module and the tests so the names exist exactly once.
import type { RoleCode } from './role-rules';

export const ACTIONS = ['view', 'add', 'edit', 'delete', 'approve', 'export', 'controls'] as const;
export type Action = (typeof ACTIONS)[number];

export const SCOPES = ['OWN', 'DEPARTMENT', 'ALL'] as const;
export type Scope = (typeof SCOPES)[number];

export type ActionFlags = Record<Action, boolean>;

/** Actions that a module control's allow_* switch can veto (for SUPER_ADMIN too). */
export const ALLOW_FLAG_FOR: Partial<
  Record<Action, 'allowAdd' | 'allowEdit' | 'allowDelete' | 'allowExport'>
> = {
  add: 'allowAdd',
  edit: 'allowEdit',
  delete: 'allowDelete',
  export: 'allowExport',
};

/** Roles that can have role_permissions rows; SUPER_ADMIN is always allowed everything. */
export const PERMISSION_ROLES = ['ADMIN', 'MANAGER', 'LEAD', 'MEMBER'] as const;
export type PermissionRole = (typeof PERMISSION_ROLES)[number];

export const DEFAULT_RESOURCE = '*';
export const EMAIL_SEND_PERMISSION = 'email.send';
export const familyResource = (family: string): string => `family:${family}`;
export const pageResource = (pageId: string): string => `page:${pageId}`;

export function noActions(): ActionFlags {
  return {
    view: false,
    add: false,
    edit: false,
    delete: false,
    approve: false,
    export: false,
    controls: false,
  };
}

export function allActions(): ActionFlags {
  return {
    view: true,
    add: true,
    edit: true,
    delete: true,
    approve: true,
    export: true,
    controls: true,
  };
}

/** §2.4 role defaults (the `*` rows). */
export const DEFAULT_ROLE_ROWS: Record<PermissionRole, ActionFlags & { scope: Scope }> = {
  ADMIN: { ...allActions(), scope: 'ALL' },
  MANAGER: { ...allActions(), controls: false, scope: 'DEPARTMENT' },
  LEAD: { ...allActions(), delete: false, approve: false, controls: false, scope: 'DEPARTMENT' },
  MEMBER: {
    ...noActions(),
    view: true,
    add: true,
    edit: true,
    scope: 'OWN',
  },
};

export function isPermissionRole(role: RoleCode): role is PermissionRole {
  return (PERMISSION_ROLES as readonly string[]).includes(role);
}
