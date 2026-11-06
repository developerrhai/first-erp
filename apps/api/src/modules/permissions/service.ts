// Permission Master (Phase 2 §2.3, §2.6): read every role's rows; replace one role's rows as a
// whole. Hierarchy: only roles the caller can manage (never their own or higher). If-Match is the
// role-level version = the highest row version of that role; a PUT writes every row at that + 1.
// ADMIN's `*` controls cannot be switched off (409 PROTECTED). Audited with before/after rows.
import type { Prisma, RolePermission } from '@prisma/client';
import type { AuthContext, RequestMeta } from '../../core/auth/auth-context';
import { recordAudit } from '../../core/audit/audit-service';
import { prisma } from '../../core/db/prisma';
import { Errors } from '../../core/http/errors';
import { invalidateAccessCache } from '../../core/rbac/access';
import {
  ACTIONS,
  DEFAULT_RESOURCE,
  EMAIL_SEND_PERMISSION,
  PERMISSION_ROLES,
  familyResource,
  isPermissionRole,
  noActions,
} from '../../core/rbac/permission-model';
import type { PermissionRole, Scope } from '../../core/rbac/permission-model';
import { canManage } from '../../core/rbac/role-rules';
import type { RoleCode } from '../../core/rbac/role-rules';
import { ADMIN_FAMILY, isFamily, pageInfo, registry } from '../../core/registry';
import { permissionRepository } from './repository';
import type { PermissionRowInput, PutPermissionsInput } from './schemas';

/** null = inherited from the next less specific row (never null on "*"). */
export interface PermissionRowDto {
  resource: string;
  view: boolean | null;
  add: boolean | null;
  edit: boolean | null;
  delete: boolean | null;
  approve: boolean | null;
  export: boolean | null;
  controls: boolean | null;
  scope: Scope | null;
  version: number;
}

export interface RolePermissionsDto {
  role: PermissionRole;
  editable: boolean;
  /** Role-level version used for If-Match on PUT /permissions/:role (max row version). */
  version: number;
  rows: PermissionRowDto[];
}

/** "*" first, then families in registry order, then pages in menu order. */
function resourceOrder(resource: string): number {
  if (resource === DEFAULT_RESOURCE) return -1;
  if (resource === EMAIL_SEND_PERMISSION) return 999;
  if (resource.startsWith('family:')) {
    const index = registry.familyNames.indexOf(resource.slice('family:'.length));
    return index < 0 ? 10_000 : index;
  }
  const page = pageInfo(resource.slice('page:'.length));
  return 1_000 + (page?.order ?? 9_000);
}

function toRowDto(r: RolePermission): PermissionRowDto {
  return {
    resource: r.resource,
    view: r.view,
    add: r.add,
    edit: r.edit,
    delete: r.delete,
    approve: r.approve,
    export: r.export,
    controls: r.controls,
    scope: r.scope,
    version: r.version,
  };
}

function roleDto(
  role: PermissionRole,
  rows: RolePermission[],
  actorRole: RoleCode,
): RolePermissionsDto {
  const sorted = [...rows].sort((a, b) => resourceOrder(a.resource) - resourceOrder(b.resource));
  return {
    role,
    editable: canManage(actorRole, role),
    version: rows.reduce((max, r) => Math.max(max, r.version), 0),
    rows: sorted.map(toRowDto),
  };
}

export function validateRows(role: PermissionRole, rows: PermissionRowInput[]): void {
  const fields: Record<string, string> = {};
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const key = `rows.${i}.resource`;
    if (seen.has(row.resource)) fields[key] = 'Duplicate resource.';
    seen.add(row.resource);
    if (row.resource === DEFAULT_RESOURCE) return;
    if (row.resource === EMAIL_SEND_PERMISSION) {
      if (row.add === null) fields[`rows.${i}.add`] = 'Set the email.send permission explicitly.';
      for (const action of ACTIONS) {
        if (action !== 'add' && row[action] !== false) {
          fields[`rows.${i}.${action}`] = 'The email.send resource only supports add.';
        }
      }
      if (row.scope !== null) fields[`rows.${i}.scope`] = 'The email.send resource has no scope.';
      return;
    }
    if (row.resource.startsWith('family:')) {
      if (!isFamily(row.resource.slice('family:'.length))) fields[key] = 'Unknown family.';
      return;
    }
    if (row.resource.startsWith('page:')) {
      if (!pageInfo(row.resource.slice('page:'.length))) fields[key] = 'Unknown page.';
      return;
    }
    fields[key] = 'Resource must be "*", "family:<name>", "page:<id>", or "email.send".';
  });
  if (!seen.has(DEFAULT_RESOURCE)) fields.rows = 'A "*" (role default) row is required.';
  rows.forEach((row, i) => {
    if (row.resource !== DEFAULT_RESOURCE) return;
    for (const cell of [...ACTIONS, 'scope'] as const) {
      if (row[cell] === null)
        fields[`rows.${i}.${cell}`] = 'The "*" row cannot inherit; set a value.';
    }
  });
  if (Object.keys(fields).length > 0) throw Errors.validation(fields);
  const star = rows.find((r) => r.resource === DEFAULT_RESOURCE);
  if (role === 'ADMIN' && star && star.controls !== true) {
    throw Errors.protectedResource("An Admin's controls permission on * cannot be turned off.");
  }
  for (const row of rows) {
    if (!isAdministrationResource(row.resource)) continue;
    if (role === 'ADMIN') {
      if (row.controls === false) {
        throw Errors.protectedResource(
          "An Admin's controls permission on Administration pages cannot be turned off.",
        );
      }
    } else if (ACTIONS.some((a) => row[a] === true)) {
      throw Errors.protectedResource('Only Admin and above may use Administration pages.');
    }
  }
}

/** `family:Administration` or `page:<id>` of a page in the Administration family. */
function isAdministrationResource(resource: string): boolean {
  if (resource === familyResource(ADMIN_FAMILY)) return true;
  return (
    resource.startsWith('page:') &&
    pageInfo(resource.slice('page:'.length))?.family === ADMIN_FAMILY
  );
}

/**
 * Non-admin roles always keep an explicit deny row on `family:Administration`: if the PUT omits it,
 * or leaves cells as "inherit" (which would inherit `*`), it is stored as all-false.
 */
function withAdministrationDeny(
  role: PermissionRole,
  rows: PermissionRowInput[],
): PermissionRowInput[] {
  if (role === 'ADMIN') return rows;
  const resource = familyResource(ADMIN_FAMILY);
  const existing = rows.find((r) => r.resource === resource);
  const deny: PermissionRowInput = { resource, ...noActions(), scope: existing?.scope ?? 'OWN' };
  return [...rows.filter((r) => r.resource !== resource), deny];
}

const snapshot = (rows: RolePermission[]): Prisma.InputJsonArray =>
  rows.map((r) => {
    const out: Record<string, string | boolean | null> = { resource: r.resource, scope: r.scope };
    for (const a of ACTIONS) out[a] = r[a];
    return out;
  });

export const permissionService = {
  async list(actorRole: RoleCode): Promise<{ roles: RolePermissionsDto[]; families: string[] }> {
    const rows = await permissionRepository.all();
    return {
      roles: PERMISSION_ROLES.map((role) =>
        roleDto(
          role,
          rows.filter((r) => r.role === role),
          actorRole,
        ),
      ),
      families: [...registry.familyNames],
    };
  },

  async replace(
    actor: AuthContext,
    role: RoleCode,
    expectedVersion: number,
    input: PutPermissionsInput,
    meta: RequestMeta,
  ): Promise<RolePermissionsDto> {
    if (!isPermissionRole(role)) {
      throw Errors.forbidden('Super Admin permissions are fixed and cannot be edited.');
    }
    if (!canManage(actor.role, role)) {
      throw Errors.forbidden('You cannot edit the permissions of your own role or a higher role.');
    }
    validateRows(role, input.rows);
    // An override row whose cells are all "inherit" carries no information: it is not stored.
    const rows = withAdministrationDeny(role, input.rows).filter(
      (r) =>
        r.resource === DEFAULT_RESOURCE || r.scope !== null || ACTIONS.some((a) => r[a] !== null),
    );

    const result = await prisma.$transaction(async (tx) => {
      await permissionRepository.lockRole(role, tx);
      const before = await permissionRepository.forRole(role, tx);
      const current = before.reduce((max, r) => Math.max(max, r.version), 0);
      if (current !== expectedVersion) throw Errors.versionConflict();
      const nextVersion = current + 1;
      await permissionRepository.replace(
        role,
        rows.map((r) => ({ ...r, version: nextVersion, updatedById: actor.userId })),
        tx,
      );
      const after = await permissionRepository.forRole(role, tx);
      await recordAudit(
        {
          action: 'PERMISSIONS_UPDATED',
          actorId: actor.userId,
          targetType: 'RolePermissions',
          targetId: role,
          meta,
          detail: { role, before: snapshot(before), after: snapshot(after) },
        },
        tx,
      );
      return after;
    });
    invalidateAccessCache();
    return roleDto(role, result, actor.role);
  },
};
