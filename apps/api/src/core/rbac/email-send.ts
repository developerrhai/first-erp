import type { RequestHandler } from 'express';
import { prisma } from '../db/prisma';
import { asyncHandler } from '../http/async-handler';
import { Errors } from '../http/errors';
import type { PermissionRole } from './permission-model';
import { EMAIL_SEND_PERMISSION, isPermissionRole } from './permission-model';
import type { RoleCode } from './role-rules';

export type EmailSendPermissionLookup = (role: PermissionRole) => Promise<boolean>;

const hasStoredEmailSendPermission: EmailSendPermissionLookup = async (role) => {
  const permission = await prisma.rolePermission.findUnique({
    where: { role_resource: { role, resource: EMAIL_SEND_PERMISSION } },
    select: { add: true },
  });
  return permission?.add === true;
};

export function createRequireEmailSend(
  lookup: EmailSendPermissionLookup = hasStoredEmailSendPermission,
): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    if (!req.auth) throw Errors.unauthenticated();
    const role: RoleCode = req.auth.role;
    if (role === 'SUPER_ADMIN') {
      next();
      return;
    }
    if (!isPermissionRole(role) || !(await lookup(role))) throw Errors.forbidden();
    next();
  });
}

export const requireEmailSend = createRequireEmailSend();
