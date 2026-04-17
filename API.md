# PNH Lead Management System — API Documentation

Base URL: `http://localhost:5000/api` (development) / `https://lms.pnh.com/api` (production)

---

## Conventions

### Authentication
Most endpoints require a JSON Web Token in the `Authorization` header:

```
Authorization: Bearer <JWT_TOKEN>
```

Tokens are obtained from `POST /api/auth/login` and expire in 7 days.

### Role-Based Access
Three roles: `admin`, `manager`, `sales`. Role requirements are noted per endpoint.

### Response Format
All responses are JSON unless noted.

**Error shape:**
```json
{ "message": "Human-readable error description" }
```

### Standard Status Codes
| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Resource created |
| 400 | Missing required field / invalid input |
| 401 | Missing or invalid JWT |
| 403 | Insufficient permissions / deactivated account |
| 404 | Resource not found |
| 409 | Conflict (duplicate email, duplicate phone+project, etc.) |
| 500 | Internal server error |

---

## 1. Auth

### POST /api/auth/register
Self-registration. Always creates a `sales` role user.

**Auth:** None

**Body:**
```json
{
  "name": "Priya Kapoor",
  "email": "priya@example.com",
  "password": "secret123",
  "phone": "9876543210"
}
```
Required: `name`, `email`, `password`.

**200/201 Response:**
```json
{
  "token": "eyJhbGc...",
  "user": { "id": "...", "name": "Priya Kapoor", "email": "...", "role": "sales" }
}
```

**Errors:** 400 (missing fields, email already registered).

---

### POST /api/auth/login
**Auth:** None

**Body:** `{ "email": "...", "password": "..." }`

**200 Response:** Same shape as register.

**Errors:** 400 (missing), 401 (invalid credentials), 403 (account deactivated).

**Side effects:** Logs `login` activity (success or failed).

---

### GET /api/auth/me
Returns the current authenticated user profile (without password hash).

**Auth:** JWT required

---

## 2. Leads

### GET /api/leads
Paginated list of leads with role-based filtering.

**Auth:** JWT required

**Query params (all optional):**
| Param | Description |
|-------|-------------|
| `search` | Case-insensitive match against name, phone, email |
| `status` | Exact match: `New`, `Called`, `Interested`, `Site Visit`, `Closed` |
| `source` | Exact match: `Instagram`, `Ads`, `Referral`, `Walk-in`, `Website`, `Other` |
| `project` | Project ObjectId |
| `assignedTo` | User ObjectId |
| `createdFrom`, `createdTo` | ISO date strings (inclusive, full day for `To`) |
| `followUpFrom`, `followUpTo` | ISO date strings |
| `page` | Default 1 |
| `limit` | Default 30, max 100 |

**200 Response:**
```json
{
  "leads": [ { /* populated lead */ }, ... ],
  "total": 245,
  "page": 1,
  "pages": 9
}
```

**Role-based behavior:** Sales users see only leads assigned to them. Admin/manager see all.

---

### GET /api/leads/:id
**Auth:** JWT required

**Response:** Full lead document with populated `assignedTo`, `createdBy`, `project`, `remarks.addedBy`.

**Errors:** 403 (sales user accessing a lead not assigned to them), 404.

---

### POST /api/leads
**Auth:** JWT required

**Body:**
```json
{
  "name": "Amit Sharma",
  "phone": "9876543210",
  "email": "amit@example.com",
  "source": "Ads",
  "status": "New",
  "notes": "Interested in 3BHK",
  "followUpDate": "2026-04-15T18:00",
  "assignedTo": "<userId>",
  "project": "<projectId>",
  "customFields": { "occupation": "Engineer", "budget": "50L" }
}
```
Required: `name`, `phone`.

**Response:**
```json
{ "lead": { /* populated */ }, "duplicate": false }
```
`duplicate: true` means the phone+project already existed — the existing lead was updated instead.

**Behavior:**
- Phone normalized (strips spaces/dashes/parentheses/+).
- Duplicate detection by `(phone, project)` pair.
- Agent assignment priority: `assignedTo` (body) → project round-robin → creator.
- Sends assignment email to agent.
- Logs `lead.create` activity.

---

### PUT /api/leads/:id
**Auth:** JWT required

**Body:** Any subset of lead fields. Sales users can only edit `status`, `notes`, `followUpDate`, `lastContactedAt`.

**Errors:** 403 (sales user on another's lead), 404, 409 (changing project creates a duplicate `(phone, project)`).

**Side effects:** Sends assignment email if `assignedTo` changed. Logs `lead.update`.

---

### DELETE /api/leads/:id
**Auth:** JWT + role `admin` or `manager`

**Side effects:** Logs `lead.delete`.

---

### GET /api/leads/stats
Dashboard stats (role-scoped).

**Auth:** JWT required

**Response:**
```json
{
  "total": 120,
  "todayFollowups": 8,
  "overdue": 3,
  "closedMonth": 15,
  "byStatus": [{ "_id": "New", "count": 45 }, ...]
}
```

---

### GET /api/leads/today-followups
Leads with `followUpDate` today. Role-scoped.

**Auth:** JWT required

**Response:** Array of leads.

---

### GET /api/leads/overdue
Leads with `followUpDate < today` and `status != Closed`. Role-scoped.

**Auth:** JWT required

---

### POST /api/leads/:id/remarks
Append a remark.

**Auth:** JWT required (sales users can only add to own leads)

**Body:** `{ "text": "Called, not reachable" }` (required, non-empty)

**201 Response:** Updated lead with populated remarks.

**Side effects:** Logs `lead.remark`.

---

### GET /api/leads/:id/related
All other leads with the same phone number (different projects).

**Auth:** JWT required

**Response:** Array of leads with `name`, `status`, `project`, `assignedTo`, `followUpDate`, `createdAt`.

---

### POST /api/leads/bulk
CSV bulk upload.

**Auth:** JWT + role `admin` or `manager`

**Content-Type:** `multipart/form-data`

**Form field:** `file` (CSV, max 5 MB)

**Query param:** `project` (optional, applies to all rows unless row has `project_id`)

**CSV columns (case-insensitive):** `name`, `phone`, `email`, `source`, `notes`, `project_id`.

**Response:**
```json
{
  "total": 100,
  "added": 87,
  "updated": 10,
  "skipped": 3,
  "errors": [ "..." ]
}
```

**Behavior:** Same dedup as POST. Each new lead triggers an assignment email.

---

## 3. Users

### GET /api/users
List all users (active + inactive) with lead counts.

**Auth:** JWT required

**Response:**
```json
[
  { "_id": "...", "name": "Raj", "email": "...", "role": "sales",
    "phone": "...", "isActive": true, "createdAt": "...", "leadCount": 45 }
]
```

---

### GET /api/users/agent-performance
Per-agent stats for dashboards.

**Auth:** JWT + role `admin` or `manager`

**Response:**
```json
[
  {
    "_id": "...", "name": "Raj", "email": "...", "role": "sales",
    "total": 45, "new": 12, "called": 10, "interested": 8,
    "siteVisit": 5, "closed": 10, "overdue": 3, "closedThisMonth": 2
  }
]
```

Active users only.

---

### POST /api/users
**Auth:** JWT + role `admin` or `manager`

**Body:** `{ name, email, password, role, phone }` — `name`, `email`, `password` required.

**Restrictions:** Managers can only create `sales` users.

**Side effects:** Logs `user.create`.

---

### PUT /api/users/:id
**Auth:** JWT + role `admin` or `manager`

**Body:** Any of `name`, `phone`, `role` (admin only), `isActive`.

**Restrictions:** Managers can only edit sales users and cannot change roles.

---

### PUT /api/users/:id/reset-password
**Auth:** JWT + role `admin`

**Body:** `{ "password": "newsecret" }` (min 6 chars)

**Side effects:** Logs `user.resetPassword`.

---

## 4. Projects

### GET /api/projects
**Auth:** JWT required

**Response:** Array of projects with populated `assignedAgents`.

---

### GET /api/projects/:id
**Auth:** JWT required

---

### POST /api/projects
**Auth:** JWT + role `admin` or `manager`

**Body:** `{ name, developer, location, type, notes }` — `name` required. `type` is one of `Residential`, `Commercial`, `Plots`, `Villa`.

**Side effects:** Logs `project.create`.

---

### PUT /api/projects/:id
**Auth:** JWT + role `admin` or `manager`

**Body:** Any of `name`, `developer`, `location`, `type`, `notes`, `isActive`.

---

### DELETE /api/projects/:id
**Auth:** JWT + role `admin`

---

### PUT /api/projects/:id/assign-agents
Replace the full agent roster for a project. Resets round-robin cursor.

**Auth:** JWT + role `admin` or `manager`

**Body:** `{ "agentIds": ["<userId>", "<userId>", ...] }`

**Response:** Updated project with populated agents.

**Side effects:** Sets `nextAgentIndex = 0`; logs `project.assignAgents`.

---

## 5. Google Sheets Integration

### GET /api/sheets
**Auth:** JWT + role `admin` or `manager`

**Response:** Array of sheet configs.
```json
[
  {
    "_id": "...",
    "sheetId": "1aBcD...",
    "gid": "0",
    "sheetName": "",
    "label": "Godrej Aveline Leads",
    "project": { "_id": "...", "name": "...", "developer": "..." },
    "columnMap": { "name": "Full Name", "phone": "Phone", "email": "Email" },
    "customFieldMap": { "occupation": "Your Profession", "budget": "Budget" },
    "lastSyncedRow": 42,
    "isActive": true
  }
]
```

---

### POST /api/sheets
**Auth:** JWT + role `admin`

**Body:**
```json
{
  "sheetUrl": "https://docs.google.com/spreadsheets/d/.../edit#gid=123",
  "project": "<projectId>",
  "label": "Godrej FB Leads",
  "columnMap": { "name": "Full Name", "phone": "Phone Number" },
  "customFieldMap": { "budget": "Budget Range", "city": "City" }
}
```
Required: `sheetUrl`, `project`. `gid` auto-extracted from URL.

**Errors:** 400 (sheet not accessible), 409 (sheet tab already configured).

**Side effects:** Logs `sheet.create`.

---

### PUT /api/sheets/:id
**Auth:** JWT + role `admin`

**Body:** Any of `sheetName`, `project`, `columnMap`, `customFieldMap`, `label`, `isActive`.

---

### DELETE /api/sheets/:id
**Auth:** JWT + role `admin`

**Side effects:** Logs `sheet.delete`.

---

### POST /api/sheets/:id/sync
Manually trigger a sync for a specific sheet.

**Auth:** JWT + role `admin` or `manager`

**Response:**
```json
{ "message": "Sync complete", "added": 5, "updated": 2, "skipped": 0, "total": 7 }
```

---

### POST /api/sheets/incoming
Public endpoint used by Google Apps Script to push row-level events.

**Auth:** Secret token via header `X-Sheet-Secret` or body field `secret` (must match `SHEET_WEBHOOK_SECRET`).

**Body:**
```json
{
  "sheetId": "1aBcD...",
  "gid": "0",
  "row": { "Full Name": "Amit", "Phone": "9876543210", "Email": "..." },
  "secret": "<shared secret>"
}
```

**Response:** `{ "status": "success" | "duplicate" | "skipped" | "failed" }`

---

## 6. Meta Webhook & Mappings

### GET /api/webhook/meta
Verification handshake used by Meta during webhook setup.

**Auth:** None

**Query params:** `hub.mode`, `hub.verify_token`, `hub.challenge`

**Response:** Returns `hub.challenge` as plain text if `hub.verify_token` matches `META_VERIFY_TOKEN`.

---

### POST /api/webhook/meta
Meta sends lead events here. Validates `X-Hub-Signature-256` HMAC against `META_APP_SECRET`.

**Auth:** HMAC signature verification

**Response:** `200` immediately (processing is async).

**Behavior:**
- Calls Meta Graph API to fetch full lead_data.
- Dedup via `metaLeadId` (idempotent) and `(phone, project)`.
- Project resolution: DB `MetaMapping` first, then `META_PROJECT_MAP` env var.
- Logs each event to `WebhookLog` (success/duplicate/failed/skipped).

---

### GET /api/webhook/logs
View webhook audit trail.

**Auth:** JWT + role `admin` or `manager`

**Query params:** `status` (filter), `page`, `limit`

**Response:** `{ logs, total, page, pages }`

---

### GET /api/webhook/logs/stats
Webhook health summary.

**Auth:** JWT + role `admin` or `manager`

**Response:**
```json
{ "total": 250, "last24h": 12, "success": 200, "duplicate": 30, "failed": 15, "skipped": 5 }
```

---

### GET /api/webhook/mappings
Meta form/page → CRM project mappings.

**Auth:** JWT + role `admin` or `manager`

---

### POST /api/webhook/mappings
**Auth:** JWT + role `admin`

**Body:** `{ metaId, type, project, label }` — `type` is `"form"` or `"page"`.

**Errors:** 409 if `metaId` already mapped.

---

### DELETE /api/webhook/mappings/:id
**Auth:** JWT + role `admin`

---

## 7. Activity Logs

### GET /api/activity-logs
Audit trail.

**Auth:** JWT + role `admin`

**Query params:**
| Param | Description |
|-------|-------------|
| `user` | User ObjectId |
| `action` | e.g. `login`, `lead.create`, `user.resetPassword` |
| `status` | `success` or `failed` |
| `search` | Matches userName, userEmail, details |
| `from`, `to` | ISO date range |
| `page`, `limit` | Pagination (max limit 200) |

**Response:** `{ logs, total, page, pages }`

---

### GET /api/activity-logs/actions
Distinct list of action names (for filter dropdowns).

**Auth:** JWT + role `admin`

**Response:** `["lead.create", "lead.delete", "login", ...]`

---

## 8. Health Check

### GET /api/health
**Auth:** None

**Response:** `{ "status": "ok", "env": "development" }`

---

## Appendix: Role Capabilities Summary

| Action | Admin | Manager | Sales |
|--------|:---:|:---:|:---:|
| Login, view own profile | ✓ | ✓ | ✓ |
| View all leads | ✓ | ✓ | own only |
| Create leads | ✓ | ✓ | ✓ |
| Update any lead fully | ✓ | ✓ | restricted (own) |
| Delete lead | ✓ | ✓ | ✗ |
| Bulk upload CSV | ✓ | ✓ | ✗ |
| Add remarks | ✓ | ✓ | own only |
| View all users | ✓ | ✓ | ✓ |
| Create users (any role) | ✓ | ✓ (sales only) | ✗ |
| Edit users | ✓ | ✓ (sales only, no role change) | ✗ |
| Reset user password | ✓ | ✗ | ✗ |
| Manage projects | ✓ | ✓ | view only |
| Delete projects | ✓ | ✗ | ✗ |
| Assign agents to project | ✓ | ✓ | ✗ |
| Manage Meta mappings | ✓ | view only | ✗ |
| Manage Google Sheets configs | ✓ | view + sync | ✗ |
| View webhook logs | ✓ | ✓ | ✗ |
| View activity logs | ✓ | ✗ | ✗ |
| View agent performance | ✓ | ✓ | ✗ |

---

## Appendix: Lead Dedup Rules

- Unique constraint: `(phone, project)` — same phone can exist on multiple projects, each is a separate lead.
- On duplicate: existing lead is updated (fields merged, custom fields deep-merged), `lastContactedAt` bumped.
- Duplicate responses have `duplicate: true` in the payload.

## Appendix: Environment Variables

```
PORT=5000
MONGO_URI=...
JWT_SECRET=<strong random>
JWT_EXPIRES_IN=7d
NODE_ENV=development|production
CLIENT_URL=<client origin for CORS>

# Email
SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
EMAIL_FROM (or MAIL_FROM)

# Meta webhooks (optional)
META_VERIFY_TOKEN
META_APP_SECRET
META_ACCESS_TOKEN
META_DEFAULT_ASSIGNEE_EMAIL (optional)
META_INSTAGRAM_PAGE_ID (optional)
META_PROJECT_MAP (optional JSON)

# Google Sheets
SHEET_WEBHOOK_SECRET
SHEET_POLLING_INTERVAL_MINUTES=5
```
