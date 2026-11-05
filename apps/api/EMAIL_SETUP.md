# Email Setup

The API's central email service uses SMTP through Nodemailer. SMTP (Simple Mail Transfer
Protocol) is the standard protocol for submitting outgoing email to a mail server.

## Architecture

`src/core/email/email-service.ts` owns SMTP transport reuse, message validation, and department
sender selection. The existing user-facing email route delegates to this service. Other backend
services should import the central function directly; do not make internal HTTP calls to the email
route. The email service does not depend on business modules, resolve recipients, or create
workflow triggers.

## Outlook and Microsoft 365

For Microsoft 365 work or school mailboxes, the commonly documented SMTP submission endpoint is
`smtp.office365.com` on port `587` with STARTTLS. Port `587` is STARTTLS: in this API, set
`SMTP_SECURE=false`, and Nodemailer requires STARTTLS before sending credentials. Port `465` is
implicit TLS: set `SMTP_SECURE=true` to establish TLS immediately. The service defaults to port
`587` when `SMTP_SECURE=false` and port `465` when `SMTP_SECURE=true`; an explicitly configured
`SMTP_PORT` takes precedence.

Microsoft 365 SMTP AUTH may be disabled by tenant or mailbox policy. Basic username/password
authentication is not available in every organization, especially where security defaults or
multifactor authentication policies prohibit it. The SMTP authentication policy and supported
method must be confirmed with company IT before configuring credentials. This service currently
supports username/password SMTP AUTH (or an unauthenticated relay when explicitly approved); it
does not implement OAuth 2.0. Do not treat successful local tests as proof that Microsoft 365 SMTP
AUTH is enabled or that a mailbox can send as every department identity.

If IT requires OAuth 2.0, implementation needs the approved Entra tenant/application setup,
client identity and secret/certificate handling, SMTP OAuth permission/consent model, mailbox
permissions, and token acquisition/refresh approach. These are external decisions; do not put
tokens or application secrets in source code. OAuth 2.0 over SMTP can be added to the transport
without switching to Microsoft Graph once IT confirms those requirements.

These settings are an example of a Microsoft 365 connection, not a confirmed company configuration.
The company SMTP provider, host, port, TLS mode, authentication method, sending identity, and
department sender addresses must be confirmed by company IT.

## Environment variables

Email is disabled when the SMTP settings are unset. When configured, set:

| Variable                    | Purpose                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `SMTP_HOST`                 | SMTP server hostname                                                               |
| `SMTP_PORT`                 | SMTP server port; defaults to `465` for implicit TLS, `587` for STARTTLS           |
| `SMTP_SECURE`               | `true` for port 465 implicit TLS, or `false` for port 587 required STARTTLS        |
| `SMTP_AUTH_METHOD`          | `password` for username/password SMTP AUTH, `none` only for an approved relay      |
| `SMTP_USER`                 | SMTP authentication username; optional only when the relay needs no authentication |
| `SMTP_PASSWORD`             | SMTP authentication password; must be supplied with `SMTP_USER`                    |
| `EMAIL_FROM_ADMINISTRATION` | Official Administration sender address                                             |
| `EMAIL_FROM_SALES`          | Official Sales sender address                                                      |
| `EMAIL_FROM_PURCHASE`       | Official Purchase sender address                                                   |
| `EMAIL_FROM_FINANCE`        | Official Finance sender address                                                    |
| `EMAIL_FROM_HR`             | Official HR sender address                                                         |
| `EMAIL_FROM_PRODUCTION`     | Official Production sender address                                                 |
| `EMAIL_FROM_QUALITY`        | Official Quality sender address                                                    |
| `EMAIL_FROM_MAINTENANCE`    | Official Maintenance sender address                                                |
| `EMAIL_FROM_WAREHOUSE`      | Official Warehouse sender address                                                  |
| `EMAIL_FROM_PROJECTS`       | Official Projects sender address                                                   |
| `EMAIL_FROM_SERVICE`        | Official Service sender address                                                    |

Each department sender is optional in local configuration so email can remain disabled or be
configured incrementally. A send or verification for a department without a valid matching
`EMAIL_FROM_*` value fails; there is no shared/default sender fallback. When any SMTP setting is
configured, the API requires `SMTP_HOST` and at least one department sender. SMTP username and
password must either both be present or both be omitted.
When credentials are omitted, `SMTP_AUTH_METHOD=none` is required to make an explicitly approved
unauthenticated relay configuration intentional. If both credentials are present but the method
is omitted, password authentication is inferred for compatibility. The only supported methods
currently are `password` and `none`; OAuth 2.0 is not implemented.

The current implementation uses one reusable SMTP transport and one SMTP authentication identity
for the configured department sender addresses. Company IT must confirm that this identity is
authorized to send as every configured department address. If different departments require
separate authentication identities, the transport profile design must be extended; do not put
another department's sender address in a profile as a workaround.

SMTP settings are checked for a hostname-only host, a valid port, a boolean TLS mode, paired
username/password credentials, and at least one valid department sender. At runtime,
`diagnoseSmtpConfiguration(config)` reports only `disabled`, `incomplete`, `invalid`, or `ready`,
with variable names and safe issue text; it never includes configured values. A diagnostic status
of `ready` means the settings are structurally complete, not that the server is reachable or
authorized.

## Local configuration

Use the existing API environment file at `apps/api/.env`. If creating it for local development,
copy `apps/api/.env.example` to that path, then set the normal required API environment values,
the SMTP settings, and each approved department sender address confirmed by company IT. For
example, with Microsoft 365 **only if confirmed for the company**:

```dotenv
# Microsoft 365 client submission uses STARTTLS on port 587, if confirmed by company IT.
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_AUTH_METHOD=password
SMTP_USER=confirmed-sending-mailbox@example.com
SMTP_PASSWORD=replace-with-secret
EMAIL_FROM_ADMINISTRATION=confirmed-administration-address@example.com
EMAIL_FROM_SALES=confirmed-sales-address@example.com
EMAIL_FROM_PURCHASE=confirmed-purchase-address@example.com
EMAIL_FROM_FINANCE=confirmed-finance-address@example.com
EMAIL_FROM_HR=confirmed-hr-address@example.com
EMAIL_FROM_PRODUCTION=confirmed-production-address@example.com
EMAIL_FROM_QUALITY=confirmed-quality-address@example.com
EMAIL_FROM_MAINTENANCE=confirmed-maintenance-address@example.com
EMAIL_FROM_WAREHOUSE=confirmed-warehouse-address@example.com
EMAIL_FROM_PROJECTS=confirmed-projects-address@example.com
EMAIL_FROM_SERVICE=confirmed-service-address@example.com
```

Keep the real `.env` untracked and do not paste credentials into source code, tests, tickets, or
logs. Use the organization's approved secret manager in deployed environments.
The example addresses are placeholders, not approved company mailboxes. Do not copy them as real
configuration.

## Verify SMTP connectivity

`verifySmtpConnection(department)` checks SMTP connectivity and authentication using Nodemailer's
`transporter.verify()`. It does not send an email. A configured sender profile is required for the
requested department. From `apps/api`, run:

```powershell
npm exec -- tsx -e "import { verifySmtpConnection } from './src/core/email/email-service'; verifySmtpConnection('Sales').then(() => console.log('SMTP verified')).catch(() => { console.error('SMTP verification failed'); process.exitCode = 1; });"
```

The verification function returns `true` on success. On connection or authentication failure it
rejects with a generic error; it intentionally does not expose raw SMTP error details or credentials.
This verifies the shared SMTP connection, not that Microsoft 365 authorizes the profile's sender
address. That authorization is enforced by the SMTP provider when a message is sent.

`npm run test:email` includes a configuration preflight test for disabled, incomplete, invalid, and
ready examples. All transport tests use a mock and do not send email. Do not use
`verifySmtpConnection` in automated tests or local development unless company IT has provided
authorized configuration and you explicitly intend to make a real network connection.

## Send an email

Trusted backend code may import the stable `sendEmail()` function from
`src/core/email/email-service`. From a service under `src/modules/<module>/`, use
`../../core/email/email-service`. It requires a server-selected department, one or more valid To
addresses, a non-empty subject, and at least one of plain text or HTML content. Optional CC and BCC
values accept one address or an array of addresses. The sender is looked up from that department's
`EMAIL_FROM_*` profile and cannot be supplied in the message.

```ts
import { sendEmail } from '../../core/email/email-service';
import type { EmailSubmissionResult } from '../../core/email/email-service';

async function sendDepartmentNotice(recipientEmail: string): Promise<EmailSubmissionResult> {
  return sendEmail('Administration', {
    to: recipientEmail,
    subject: 'ERP Notification',
    text: 'Your request has been updated.',
    html: '<p>Your request has been updated.</p>',
  });
}
```

For compatibility, the service also retains the existing
`sendEmail({ department, to, subject, body, ... })` signature. Both forms resolve the sender from
the trusted department and return a typed Nodemailer SMTP submission result on success. Failures
reject with sanitized errors; SMTP acceptance is not confirmation of recipient delivery. Handle
the rejection at the workflow boundary. For a notification sent after a database commit, do not
undo or report failure for the committed ERP action solely because SMTP failed, and do not retry
blindly because a retry may duplicate a message.

Other backend services should import `sendEmail` directly from `src/core/email/email-service`.
They must pass a department from trusted server-side event context; for example, purchase
functionality uses the backend department identifier `Purchase` (the Procurement / SCM department
in the ERP department-family mapping). Do not call an HTTP endpoint for internal service-to-service
email communication.

For manually initiated sends, use `sendEmailForAuthenticatedUser(req.auth.user, message)` after the
route has applied the existing authentication and an explicitly approved RBAC permission. This
helper derives the sender department from the active authenticated user's database-backed
department; it does not accept a department or sender address from the request body. For automated
notifications, use `sendEmail(department, message)` only with the department responsible for a
verified backend event, not merely the acting user's department.

The central service does not infer a recipient or business trigger. It validates recipient
addresses and the required subject/content; it drops any caller-supplied `from`. Attachments are
limited to in-memory string/Buffer content with a filename (no paths or URLs), at most 10 files,
10 MiB each and 20 MiB total. The send endpoint accepts request-scoped base64 content only; there
is no separate persistent upload/storage API or malware scanner. Treat client-provided attachments
as untrusted and do not send confidential files unless the caller is authorized to access and
disclose them.

`sendEmail()` rejects if the department sender profile or SMTP is not configured, or if delivery
fails. Delivery errors are sanitized; SMTP acceptance is not proof of mailbox delivery or reading.
A future workflow integration must send only after commit and must not report a committed ERP
action as failed because SMTP failed. Reliable deduplication/retry across process failures needs
an approved event/outbox design; no outbox or email-history database schema is included here.

## Isolated Gmail compatibility testing

The service factory accepts an explicit SMTP configuration, so a Gmail-shaped test profile can be
kept separate from the process-wide Outlook/company profile. The focused service test uses
`smtp.gmail.com`, port `587`, `SMTP_SECURE=false` (required STARTTLS), password authentication, and
one Administration sender matching the test mailbox. It injects a mocked transport: no credentials
are real, and the test cannot connect to Gmail or send mail.

Run this safe check with `npm run test:email`. For a future authorized live test, create a separate
service instance with a single approved test mailbox and supply its credentials through a
dedicated local secret source; do not replace the company `.env`, add credentials to the test, or
use the exported process-wide `emailService`. Google account and organization security policies
may require an App Password or a different approved authentication method. This implementation
supports SMTP username/password only; it does not implement Gmail OAuth. No live Gmail connection
or send is part of the automated test suite.

## Template drafts and business workflow status

`src/core/email/email-templates.ts` holds structural Purchase, Finance, and general department
drafts. Each draft is explicitly marked `pending_client_copy` and contains a placeholder, not
sendable approved wording. Replace the placeholders only after the client approves the subject,
content, links, and required record details. Templates are separate from transport and do not
select recipients or trigger sends.

The current backend has the explicit authenticated `POST /api/v1/email/send` operation. No backend
Move Forward/movement handler or post-commit event hook is available in the inspected modules, so
there is currently no automatic Move Forward integration point to connect. Receive, Accept,
Approval, Reject, and Return are not email triggers. A future Move Forward integration requires
the actual backend movement service and its successful post-commit boundary; SMTP failures must
then be handled without reversing or misreporting that committed movement.

## Authenticated email API

The backend exposes `POST /api/v1/email/send`. It requires an authenticated user who has completed
the required password change and the dedicated `email.send` permission. The sender department is
read from the active user's database-backed authentication context. `from` and `department` are
not accepted in the JSON body.

Example request:

```json
{
  "to": ["recipient@example.com"],
  "cc": ["copy@example.com"],
  "bcc": ["private-copy@example.com"],
  "subject": "Example message",
  "text": "Plain-text message",
  "html": "<p>HTML message</p>",
  "attachments": [
    {
      "filename": "report.pdf",
      "contentType": "application/pdf",
      "contentBase64": "JVBERi0xLjQK..."
    }
  ]
}
```

At least one non-empty `text` or `html` body is required. `attachments` is optional and accepts
base64-encoded in-memory content only: no paths, URLs, or caller-selected Nodemailer options. Each
attachment is limited to 10 MiB, all attachments together to 20 MiB, and at most 10 attachments.
The API decodes base64 before using the central service's attachment validation. The email route's
JSON parser allows the encoded request size needed for those limits; other API routes retain their
existing smaller JSON body limit.

Successful requests return HTTP 202 with `{ "data": { "status": "accepted_by_smtp" } }`. This means
the SMTP server accepted the submission; it does not confirm delivery to the recipient or that it
was read. Validation errors use the API's standard 422 response, missing permission returns 403,
and missing sender/SMTP configuration or send failure returns a sanitized 503 response. SMTP error
details and message data are not included in the response.

### Assigning `email.send`

There is no email-specific grant by default. The RBAC guard requires an explicit row in the existing
`role_permissions` model with `resource: "email.send"` and `add: true`; it does not inherit the
role's wildcard (`*`) permission. The existing permission-management API is
`PUT /api/v1/permissions/:role`; include the dedicated row when replacing that role's complete
permission set:

```json
{
  "resource": "email.send",
  "view": false,
  "add": true,
  "edit": false,
  "delete": false,
  "approve": false,
  "export": false,
  "controls": false,
  "scope": null
}
```

Permission assignment remains subject to existing role-management rules. The configurable roles
are `ADMIN`, `MANAGER`, `LEAD`, and `MEMBER`; an authorized Admin may manage subordinate roles, and
Super Admin may manage all of them. `SUPER_ADMIN` retains the existing system-wide authorization
bypass. No role receives `email.send` from the default role rows or seed.

## Isolated tests

From the repository root, run:

```powershell
npm --prefix apps/api run test:email
```

These tests inject a mocked transport and do not connect to SMTP, PostgreSQL, or run database
migrations/resets.

## Security precautions

- Never commit SMTP credentials or put them in frontend configuration.
- Configure only company-approved department sender addresses; never use another department's
  address as a fallback.
- Confirm with company IT that the SMTP authentication identity is authorized to send as every
  configured department address.
- Keep TLS enabled; do not disable certificate validation.
- Do not log SMTP configuration, credentials, message bodies, or unfiltered SMTP errors.
- Do not pass untrusted file paths, URLs, or attachment options to Nodemailer.
- Encode untrusted values before placing them in HTML content.
- Use only approved recipients and sender addresses when integrating a specific ERP workflow.

## Company details still required

Before real SMTP credentials are added, confirm the provider and endpoint, port and TLS mode,
whether SMTP AUTH is enabled, the permitted authentication method, the authorized SMTP identity,
each official department sender address and its Send As permissions, and the organization's
secret-storage procedure. The current service uses one shared SMTP authentication identity; no
company credentials or actual department addresses are included in this setup.

For Microsoft 365 OAuth 2.0, IT must additionally confirm the Entra tenant/application IDs,
credential type and secret-manager location, SMTP OAuth consent/permission model, mailbox access,
and approved access-token acquisition and refresh process. Do not send tenant or application
secrets in chat or commit them.

## Client decisions still required

- Approved subject/body/HTML copy for each template and any approved ERP link format.
- Which backend event data may appear in messages, especially for HR, Finance, and other sensitive
  records.
- Recipient-resolution rules and authorized recipients for each approved business event.
- Whether attachments are allowed for a workflow and what authorization/scanning policy applies.
- Any retry or duplicate-notification expectations if durable delivery is required.

These are not inferred by the email service. No automatic movement or decision notification is
enabled without the corresponding verified backend event and approved recipient rules.
