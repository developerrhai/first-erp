// Zod schemas for PUT /permissions/:role. Rows are strict; cells may be null (inherit) except on
// "*". Resource format and existence are checked in the service, including the dedicated email.send resource.
import { z } from 'zod';
import { SCOPES } from '../../core/rbac/permission-model';
import { ROLES } from '../../core/rbac/role-rules';

/** On family/page rows a null cell means "inherit"; the "*" row must be complete (service check). */
export const permissionRowSchema = z
  .object({
    resource: z.string().trim().min(1).max(120),
    view: z.boolean().nullable(),
    add: z.boolean().nullable(),
    edit: z.boolean().nullable(),
    delete: z.boolean().nullable(),
    approve: z.boolean().nullable(),
    export: z.boolean().nullable(),
    controls: z.boolean().nullable(),
    scope: z.enum(SCOPES).nullable(),
  })
  .strict();
export type PermissionRowInput = z.output<typeof permissionRowSchema>;

export const putPermissionsSchema = z
  .object({ rows: z.array(permissionRowSchema).min(1).max(400) })
  .strict();
export type PutPermissionsInput = z.output<typeof putPermissionsSchema>;

export const roleParamsSchema = z.object({ role: z.enum(ROLES) }).strict();
