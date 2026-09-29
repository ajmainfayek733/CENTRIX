# Password recovery

Dashboard users reset a forgotten password from `/forgot-password`. The backend emails a
one-click link, a numeric verification code, or both, through the official EmailJS Node.js SDK (`@emailjs/nodejs`).

Source: `Backend/src/modules/auth/passwordReset.ts`, `Backend/src/modules/auth/authService.ts`,
`Backend/src/lib/email/emailjs.ts`, `Frontend/src/app/forgot-password/ForgotPasswordForm.tsx`.

---

## 1. Flow

```text
/forgot-password (email)
  -> POST /api/auth/forgot-password          Next.js proxy
     -> POST /v1/dashboard/auth/forgot-password
        - same 200 body for known, unknown, and deactivated emails
        - stores HMACs of link token + code in `verifications` (one row per email)
        - dispatches the EmailJS send without awaiting it
  <- { delivery, expiresInMinutes }

Email
  link:  FRONTEND_URL/reset-password?email=..&token=..  -> /forgot-password, token captured
         into state and removed from the address bar
  code:  typed into the "Verification code" field

POST /api/auth/reset-password { email, token, newPassword }   token = link token OR code
  -> verifies in constant time, counts failures, consumes + sets password + revokes sessions
     in one transaction
```

## 2. Security properties

| Property | How |
|---|---|
| No secret in any HTTP response | The previous scheme returned the token to the browser. Now it only travels by email. |
| No account enumeration | Identical response body; the email send is not awaited, so provider latency does not leak which addresses exist. |
| Secrets at rest | HMAC-SHA256 keyed with `BETTER_AUTH_SECRET`. Raw values are never stored or logged in production. |
| Brute force of short codes | `PASSWORD_RESET_MAX_ATTEMPTS` wrong guesses revoke the recovery, independent of IP. The per-IP limiter (5 / 15 min) sits in front. |
| One outstanding recovery | Requesting again replaces the row, invalidating the earlier link and code. |
| Replay / race | Consumption is a conditional delete on the exact value read, inside the password-write transaction. Two concurrent submissions cannot both succeed. |
| Session hijack after reset | Every session of the user is deleted in the same transaction. |
| Referer leakage of the link token | `/forgot-password` sets `referrer: no-referrer` and strips the token from history on load. |

Rows written by the old token-in-response scheme are not valid JSON records and are revoked on
first use.

## 3. EmailJS setup

1. Create an email service in EmailJS and note its **Service ID**.
2. Create a template and note its **Template ID**. Set **To Email** to `{{to_email}}`.
3. In **Account > General** copy the **Public Key** and **Private Key**.
4. In **Account > Security** enable **Allow EmailJS API for non-browser applications**. Without it
   every server-side send returns 403.
5. Set the variables in section 4 and restart the API.

Template parameters sent on every email. Unused ones are empty strings, so a single template
can serve every delivery mode with EmailJS conditional sections.

| Parameter | Value |
|---|---|
| `email` / `to_email` | Recipient address. Bind the template's **To Email** to either one. |
| `link` | Same as `reset_link` |
| `code` | Same as `reset_code` |
| `to_name` | User's name, or the address when no name is set |
| `app_name` | `APP_NAME` |
| `reset_link` | One-click link, empty in `code` mode |
| `reset_code` | Numeric code, empty in `link` mode |
| `expires_in_minutes` | `PASSWORD_RESET_TTL_MINUTES` |

Example template body:

```html
<p>Hello {{to_name}},</p>
<p>We received a request to reset your {{app_name}} password.</p>
{{#reset_link}}
<p><a href="{{reset_link}}">Reset your password</a></p>
{{/reset_link}}
{{#reset_code}}
<p>Or enter this verification code: <strong>{{reset_code}}</strong></p>
{{/reset_code}}
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
| `PASSWORD_RESET_DELIVERY` | `both` | `link`, `code`, or `both` |
| `PASSWORD_RESET_TTL_MINUTES` | `30` | Lifetime of a recovery, max 1440 |
| `PASSWORD_RESET_MAX_ATTEMPTS` | `5` | Wrong guesses before revocation, max 20 |
| `PASSWORD_RESET_CODE_LENGTH` | `6` | Code digits, 6 to 10 |

`FRONTEND_URL` must be the public dashboard URL, because reset links are built from it.

The four EmailJS credentials are all-or-nothing: a partial set fails startup. With none set:

- **Development**: the link and code are logged to the API console instead of emailed.
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
| "Too many incorrect attempts" | Attempt budget spent; request a new email |

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

`EMAILJS_PRIVATE_KEY` is not required in this mode.

> **Security warning.** `templateParams` carries the reset link and code, so the caller of
> `/forgot-password` receives them. Anyone can reset any account's password, including a
> `super_admin`, without access to its mailbox. The response also differs for known and unknown
> emails, which reveals which addresses have accounts. The API logs a warning at startup in this
> mode. Switch back to `server` as soon as non-browser API access can be enabled.

## Related

- [security.md](security.md) - auth, RBAC, rate limiting
- [../frontend/session-and-auth.md](../frontend/session-and-auth.md) - dashboard auth proxy
- [../reference/dashboard-api.md](../reference/dashboard-api.md) - endpoint table
