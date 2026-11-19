# Administration

## Instance administrators

Instance administrators are listed in `INSTANCE_ADMINS` (`deploy/.env`, usernames, comma-separated). On every start
the server sets the admin flag for exactly these accounts; there is no way to grant it through the UI or the API.
Server owners and roles inside a server are separate — they are managed in the server settings.

To change admins: edit `.env` and restart the server (`docker compose up -d relay`).

## First administrator

`install.sh` creates the admin account itself. Manually: put your username into `INSTANCE_ADMINS` and register with it
right after the first start (in open mode anyone could take the name first).

## Registration mode

By default registration is open. `REGISTRATION=invite` in `deploy/.env` makes the instance invite-only: every account
needs a single-use invite code, and the sections below apply.

## Invite codes (invite-only mode)

- **Create** — in the app: **Settings → Invites (admin) → Codes → Create code** (note, validity 1–90 days,
  optionally a server the new user joins automatically). The code is shown once; only its hash is stored.
  On the server: `./noxvc-admin invite create [--days N] [--note TEXT] [--guild ID] [--count N] [--quiet]`.
- **List / revoke** — the **Codes** tab (state: active, used — by whom and when, expired, revoked) or
  `./noxvc-admin invite list [--all]`, `./noxvc-admin invite revoke ID`.
- **Link format** — `https://<APP_URL>/register?code=<CODE>`; the code is filled in automatically.
- Registration with a missing, invalid, used, expired or revoked code fails with the same message
  ("invite code is invalid").

## Invite requests (invite-only mode)

Members can ask for an invite for someone (**Settings → Invites**): who, a comment, and one of their servers where
they have the **Create invite** permission. Up to 3 pending requests per member; a request that is not decided in
14 days expires.

The admin sees new requests in **Settings → Invites (admin) → Requests** (badge with the number of pending ones):
- **Approve** (choose validity) — a code bound to the request and its server is created; the requester gets a
  notification and sees the link with a **Copy link** button until it is used or expires.
- **Reject** with an optional reason — the requester is notified.

`./noxvc-admin requests list [--all]` lists them on the server. The **History** tab shows who invited whom, who
approved it, and when the account was registered.

## Server invites

Invite links to a server (`/invite/<code>` or `#invite/<code>`) work for registered users as usual. A visitor without
an account sees the login form (in invite-only mode: "NoxVC is invite-only", no registration).

## Backlog (bug reports and ideas)

Users send bug reports, ideas and questions from the app (feedback button). Admins manage them in
**Settings → Reports (admin)**: filters, status, priority, duplicates, replies, CSV/Markdown export.

## Rate limits

Registration attempts, invalid codes, failed logins, invite requests and feedback are rate-limited per IP or per
user (defaults and variables: [configuration.md](configuration.md)). Limits are kept in memory and reset on restart.

## Sessions

Every user sees their active sessions and a security log (logins, password changes, revoked sessions) in
**Settings → My account** and can sign out other devices.
