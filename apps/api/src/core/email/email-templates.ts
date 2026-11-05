export type EmailTemplateDraft = {
  status: 'pending_client_copy';
  subject: string;
  text: string;
};

export const emailTemplateDrafts = {
  departmentNotification: {
    status: 'pending_client_copy',
    subject: '[CLIENT-APPROVED DEPARTMENT NOTIFICATION SUBJECT REQUIRED]',
    text: '[CLIENT-APPROVED DEPARTMENT NOTIFICATION CONTENT REQUIRED]',
  },
  purchaseNotification: {
    status: 'pending_client_copy',
    subject: '[CLIENT-APPROVED PURCHASE NOTIFICATION SUBJECT REQUIRED]',
    text: '[CLIENT-APPROVED PURCHASE NOTIFICATION CONTENT REQUIRED]',
  },
  financeNotification: {
    status: 'pending_client_copy',
    subject: '[CLIENT-APPROVED FINANCE NOTIFICATION SUBJECT REQUIRED]',
    text: '[CLIENT-APPROVED FINANCE NOTIFICATION CONTENT REQUIRED]',
  },
} as const satisfies Record<string, EmailTemplateDraft>;

export type EmailTemplateName = keyof typeof emailTemplateDrafts;
