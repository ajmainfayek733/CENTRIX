# Password recovery

Dashboard users reset a forgotten password from `/forgot-password`. Recovery uses Better Auth's
native flow (`emailAndPassword.sendResetPassword`, `auth.api.requestPasswordReset`,
`auth.api.resetPassword`). Better Auth issues, expires, and single-use-consumes the token; this
API only delivers it as an emailed link through the official EmailJS Node.js SDK (`@emailjs/nodejs`).

Source: `Backend/src/config/auth.ts`, `Backend/src/modules/auth/passwordReset.ts`,
`Backend/src/modules/auth/authService.ts`, `Backend/src/lib/email/emailjs.ts`,
`Frontend/src/app/forgot-password/ForgotPasswordForm.tsx`.

---

## 1. Flow

```text
/forgot-password (email)
  -> POST /api/auth/forgot-password          Next.js proxy
     -> POST /v1/dashboard/auth/forgot-password
        - auth.api.requestPasswordReset: same body for known and unknown emails
        - token stored by Better Auth as `reset-password:<token>` in `verifications`
        - sendResetPassword dispatches the EmailJS send without awaiting it
  <- { expiresInMinutes }

Email
  link: FRONTEND_URL/reset-password?token=..  -> /forgot-password, token captured into
        state and removed from the address bar

POST /api/auth/reset-password { token, newPassword }
  -> auth.api.resetPassword: validates length, consumes the token once, writes the credential,
     revokes every session of the user (revokeSessionsOnPasswordReset)
```

## 2. Security properties

| Property | How |
|---|---|
| No secret in any HTTP response | The token only travels by email (except the documented `browser` transport). |
| No account enumeration | Better Auth returns an identical body and simulates the lookup for unknown emails; the email send is not awaited, so provider latency does not leak which addresses exist. |
| Deactivated users | `sendResetPassword` sends nothing when `isActive` is false. |
| Token strength | Better Auth generates a 24-character random id; expiry is `PASSWORD_RESET_TTL_MINUTES`. Requests are also rate limited (5 / 15 min per IP). |
| Replay / race | Better Auth consumes the token atomically; two concurrent submissions cannot both succeed. |
| Session hijack after reset | `revokeSessionsOnPasswordReset: true` deletes every session of the user. |
| Referer leakage of the link token | `/forgot-password` sets `referrer: no-referrer` and strips the token from history on load. |

Numeric codes and the per-recovery attempt counter of the previous custom flow were removed:
the token is high-entropy, so there is nothing short to brute-force. Old custom rows in
`verifications` (`pwd_reset_*`) are ignored and expire unused.

## 3. EmailJS setup

1. Create an email service in EmailJS and note its **Service ID**.
2. Create a template and note its **Template ID**. Set **To Email** to `{{to_email}}`.
3. In **Account > General** copy the **Public Key** and **Private Key**.
4. In **Account > Security** enable **Allow EmailJS API for non-browser applications**. Without it
   every server-side send returns 403.
5. Set the variables in section 4 and restart the API.

Template parameters sent on every email:

| Parameter | Value |
|---|---|
| `email` / `to_email` | Recipient address. Bind the template's **To Email** to either one. |
| `link` | Same as `reset_link` |
| `code` | Always empty (kept so older templates render) |
| `to_name` | User's name, or the address when no name is set |
| `app_name` | `APP_NAME` |
| `reset_link` | One-click reset link |
| `reset_code` | Always empty |
| `expires_in_minutes` | `PASSWORD_RESET_TTL_MINUTES` |

Example template body:

```html
<p>Hello {{to_name}},</p>
<p>We received a request to reset your {{app_name}} password.</p>
<p><a href="{{reset_link}}">Reset your password</a></p>
<p>This expires in {{expires_in_minutes}} minutes. If you did not request it, ignore this email.</p>
```

## 4. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EMAILJS_SERVICE_ID` | - | EmailJS service |
| `EMAILJS_PASSWORD_RESET_TEMPLATE_ID` | - | Template described above |
| `EMAILJS_PUBLIC_KEY` | - | Sent as `user_id` |
| `EMAILJS_PRIVATE_KEY` | - | Sent as `accessToken`; required for server-side calls |
| `EMAILJS_TIMEOUT_MS` | `10000` | Abort bound on one send |
| `PASSWORD_RESET_EMAIL_TRANSPORT` | `server` | `server` sends with `@emailjs/nodejs`. `browser` makes the dashboard send with `@emailjs/browser`; see section 6 |
| `APP_NAME` | `CENTRIX` | `{{app_name}}` |
| `PASSWORD_RESET_TTL_MINUTES` | `30` | Lifetime of a reset token (`resetPasswordTokenExpiresIn`), max 1440 |

`FRONTEND_URL` must be the public dashboard URL, because reset links are built from it.

The EmailJS credentials are all-or-nothing: a partial set fails startup. With none set:

- **Development**: the link is logged to the API console instead of emailed.
- **Production**: the API starts, logs a warning, and `/forgot-password` returns 503.

## 5. Troubleshooting

| Symptom | Cause |
|---|---|
| `forgot-password` returns 503 in production | EmailJS credentials not set |
| API log: `EmailJS rejected the request with status 403` | Non-browser API access is disabled in EmailJS account security |
| API log: status 400 or 422 with a template or recipient message | Template ID wrong, or **To Email** not bound to `{{email}}` or `{{to_email}}` |
| No email and no error in the browser | Expected: the send runs in the background. The failure is only in the API console, prefixed `passwordReset:` |
| API log: status 429 | EmailJS plan quota or rate limit reached |
| Link opens the wrong host | `FRONTEND_URL` still points at localhost |
| "invalid, has expired, or has already been used" | Token expired or consumed; request a new email |

## 6. Browser transport

Set `PASSWORD_RESET_EMAIL_TRANSPORT=browser` when the EmailJS account cannot enable
"Allow EmailJS API for non-browser applications". The flow becomes:

```text
POST /forgot-password
  <- { ..., emailDispatch: { serviceId, templateId, publicKey, templateParams } }
     (only for an existing, active account; the private key is never included)
ForgotPasswordForm
  -> @emailjs/browser send(serviceId, templateId, templateParams, { publicKey, blockHeadless })
     Frontend/src/lib/emailjs.ts
```

`EMAILJS_PRIVATE_KEY` is not required in this mode. `sendResetPassword` hands the payload to the
request through an `AsyncLocalStorage` collector (`collectResetDispatch` in `passwordReset.ts`).

> **Security warning.** `templateParams` carries the reset link, so the caller of
> `/forgot-password` receives it. Anyone can reset any account's password, including a
> `super_admin`, without access to its mailbox. The response also differs for known and unknown
> emails, which reveals which addresses have accounts. The API logs a warning at startup in this
> mode. Switch back to `server` as soon as non-browser API access can be enabled.

## Related

- [security.md](security.md) - auth, RBAC, rate limiting
- [../frontend/session-and-auth.md](../frontend/session-and-auth.md) - dashboard auth proxy
- [../reference/dashboard-api.md](../reference/dashboard-api.md) - endpoint table
