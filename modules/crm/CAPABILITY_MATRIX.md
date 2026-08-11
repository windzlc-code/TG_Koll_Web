# CRM legacy capability migration matrix

This file is the release gate for the native CRM module. `blocked` means the
legacy route remains deliberately unavailable in production; the SPA reads the
same runtime capability registry and does not expose a write control for it.
There is no `deferred` state.

## Product capability gate

| Capability | State | Native target | Verification |
|---|---|---|---|
| Data workspace, pools, leads, tags and snapshots | equivalent | `/api/crm/v1/{pools,leads,events,...}` and `crm_*` | `CRM-BE-resource-tenant` |
| Collection through existing browser tasks | adapted | CRM workflow -> `browse_feed` / `browse_profile` | `CRM-INT-child-atomic` |
| Public comments, replies and nurture actions | adapted | CRM ledger -> existing comment/reply tasks | `CRM-INT-billing-evidence` |
| Threads community invitation post | adapted | CRM ledger -> `publish_post` | `CRM-INT-group-threads` |
| Parent workflow, confirmation and recovery | equivalent | `/api/crm/v1/tasks*` | `CRM-BE-workflow-state` |
| Schedules and leader lease | adapted | `crm_schedules`, `crm_scheduler_leases` | `CRM-INT-scheduler-lease` |
| Templates and media | equivalent | `/api/crm/v1/templates`, `/media` | `CRM-BE-media` |
| Analytics and secure tracking | adapted | `/analytics`, `/crm/go/{token}` | `CRM-SEC-tracking` |
| Account verification and browser takeover | adapted | CRM action -> existing live browser/Kasm | `CRM-E2E-open-login` |
| Legacy JSON/image import | adapted | admin dry-run/staging/activate | `CRM-INT-import` |
| AI demand analysis and draft generation | adapted | native Python demand/comment port -> existing TG LLM with deterministic local fallback | `CRM-EVAL-ai-parity` |
| Live OPC history/search adapter | adapted | tenant history query plus existing TG live persona-hot browser lane, no history fill | `CRM-INT-opc-live` |
| Direct-message batch | adapted | CRM ledger -> native Python direct-message worker with evidence and rotation lock | `CRM-E2E-direct-message` |
| Instagram group create/member management | adapted | CRM ledger -> native Instagram Direct workers with evidence and no-retry unknown state | `CRM-E2E-instagram-group` |
| Live relationship verification | adapted | CRM parent workflow -> read-only Instagram relationship verifier | `CRM-E2E-relationship` |

## Extracted 83-route inventory

The inventory below was extracted from the two legacy production services.
Dynamic item routes are covered by the parent route row and by the native task
or resource contract tests.

### Legacy orchestrator (41)

| # | Legacy route | State | Native target / release gate |
|---:|---|---|---|
| 1 | `GET /api/track/click` | equivalent | `GET /crm/go/{token}`; `CRM-SEC-tracking` |
| 2 | `GET /api/health` | adapted | `GET /api/admin/modules/crm/health`; `CRM-BE-health` |
| 3 | `POST /api/template-media` | equivalent | `POST /api/crm/v1/media`; `CRM-BE-media` |
| 4 | `GET /api/state` | adapted | `GET /api/crm/v1/bootstrap`; `CRM-BE-bootstrap` |
| 5 | `GET /api/tasks` | equivalent | `GET /api/crm/v1/tasks`; `CRM-BE-task-list` |
| 6 | `GET /api/pools` | equivalent | `GET /api/crm/v1/pools`; `CRM-BE-resource-tenant` |
| 7 | `POST /api/relationships/verify` | adapted | `POST /api/crm/v1/relationships/verify`; `CRM-E2E-relationship` |
| 8 | `GET /api/templates` | equivalent | `GET /api/crm/v1/templates`; `CRM-BE-resource-tenant` |
| 9 | `GET /api/events` | equivalent | `GET /api/crm/v1/events`; `CRM-BE-resource-tenant` |
| 10 | `GET /api/opc/summary` | adapted | imported counts in bootstrap/analytics; `CRM-INT-import` |
| 11 | `GET /api/accounts` | adapted | `GET /api/crm/v1/accounts`; `CRM-BE-account-tenant` |
| 12 | `GET /api/ai/config` | blocked | central TG AI config only after `CRM-EVAL-ai-parity` |
| 13 | `GET /api/analytics` | adapted | `GET /api/crm/v1/analytics`; `CRM-BE-analytics` |
| 14 | `GET /api/schedule` | adapted | `GET /api/crm/v1/schedules`; `CRM-INT-scheduler-lease` |
| 15 | `GET /api/schedule/tasks` | adapted | `GET /api/crm/v1/tasks`; `CRM-BE-task-list` |
| 16 | `POST /api/collections` | adapted | `POST /api/crm/v1/tasks` with collection action; `CRM-INT-child-atomic` |
| 17 | `POST /api/demand/analyze` | adapted | `POST /api/crm/v1/demand/analyze`; existing TG LLM plus deterministic local fallback |
| 18 | `POST /api/hotspots/search` | adapted | `POST /api/crm/v1/hotspots/search`; tenant account and live-only evidence required |
| 19 | `POST /api/opc/history/query` | adapted | `POST /api/crm/v1/opc/history/query`; tenant-scoped realtime database history |
| 20 | `POST /api/opc/history/import` | adapted | `POST /api/crm/v1/opc/history/import`; tenant-safe pool/event import |
| 21 | `POST /api/templates` | equivalent | `POST /api/crm/v1/templates`; `CRM-BE-resource-create` |
| 22 | `POST /api/ai/config` | blocked | old AI secret/config is not migrated |
| 23 | `POST /api/schedule` | adapted | `POST /api/crm/v1/schedules`; `CRM-INT-scheduler-lease` |
| 24 | `POST /api/schedule/run` | adapted | create CRM parent workflow; `CRM-INT-scheduler-run` |
| 25 | `POST /api/schedule/stop` | adapted | `POST /api/crm/v1/schedules/{id}/stop`; unsafe submits preserved |
| 26 | `POST /api/outreach/preflight` | adapted | `POST /api/crm/v1/preflight`; account, dedupe, billing and policy decisions |
| 27 | `POST /api/outreach` | adapted | `direct_message` CRM action -> native Python worker |
| 28 | `GET /api/comments/progress` | adapted | workflow/task state plus analytics; `CRM-BE-task-detail` |
| 29 | `POST /api/comments/followup-draft` | adapted | `POST /api/crm/v1/comments/followup-draft`; platform evidence required |
| 30 | `POST /api/comments/followup` | adapted | `public_reply` CRM action; `CRM-INT-billing-evidence` |
| 31 | `POST /api/comments/drafts` | adapted | `POST /api/crm/v1/comments/drafts`; per-lead source validation and safe fallback |
| 32 | `POST /api/comments/outreach` | adapted | `public_comment` CRM action; `CRM-INT-billing-evidence` |
| 33 | `POST /api/engagement/nurture` | adapted | `nurture_reply` CRM action; `CRM-INT-billing-evidence` |
| 34 | `POST /api/groups` | adapted | Threads invitation post or confirmed Instagram Direct group workflow |
| 35 | `POST /api/platform/public-comments` | adapted | child result -> action evidence; `CRM-CRITICAL-unknown` |
| 36 | `POST /api/platform/group-status` | adapted | `instagram_group_status_inspect` read action with screenshot evidence |
| 37 | `POST /api/platform/instagram/group-members` | adapted | add/inspect member CRM actions; approved writes use group SKU |
| 38 | `POST /api/accounts/verify` | adapted | CRM `account_check` -> existing `check_login` |
| 39 | `POST /api/accounts/open-login` | adapted | `POST /api/crm/v1/accounts/{id}/open-login`; `CRM-E2E-open-login` |
| 40 | `POST /api/accounts/reset-rotation` | adapted | `POST /api/crm/v1/accounts/{id}/rotation/reset`; explicit follow-action confirmation |
| 41 | `POST /api/tasks/stop` | equivalent | `POST /api/crm/v1/tasks/{id}/cancel`; `CRM-CRITICAL-policy-stop` |

### Legacy social automation service (42)

| # | Legacy route | State | Native target / release gate |
|---:|---|---|---|
| 42 | `GET /ai/config` | blocked | TG AI config plus parity gate |
| 43 | `POST /ai/config` | blocked | old AI keys are explicitly not migrated |
| 44 | `GET /health` | adapted | CRM health plus existing worker health |
| 45 | `GET /track/click` | equivalent | signed `/crm/go/{token}` |
| 46 | `GET /go/*` | adapted | compatibility `/go/{code}/{username}/{lead_id}` |
| 47 | `GET /track/clicks` | adapted | `/api/crm/v1/analytics` and tracking events |
| 48 | `DELETE /track/clicks` | adapted | tenant campaign delete plus durable CRM audit event |
| 49 | `POST /outreach/events` | adapted | `POST /api/crm/v1/events` |
| 50 | `DELETE /outreach/events` | adapted | tenant-scoped soft delete plus durable CRM audit event |
| 51 | `GET /outreach/performance` | adapted | `/api/crm/v1/analytics` |
| 52 | `POST /outreach/duplicates` | adapted | durable unique action-ledger keys |
| 53 | `GET /daily/config` | adapted | `/api/crm/v1/schedules` |
| 54 | `POST /daily/config` | adapted | `POST /api/crm/v1/schedules` |
| 55 | `POST /daily/run` | adapted | schedule materializes a parent workflow only |
| 56 | `POST /social/layered-collect` | adapted | `browse_feed` / `browse_profile` child tasks |
| 57 | `POST /social/public-comment-batch` | adapted | `public_comment` action ledger |
| 58 | `POST /social/inspect-public-comment` | adapted | platform evidence reconciliation |
| 59 | `POST /social/group-post` | adapted | Threads `publish_post` child task |
| 60 | `POST /social/group-status` | adapted | native `instagram_group_status_inspect` worker |
| 61 | `POST /social/create-threads-community` | adapted | `threads_group_invite_post` |
| 62 | `POST /social/inspect-threads-profile` | adapted | `collect_profile` read action |
| 63 | `POST /social/create-instagram-group` | adapted | native `instagram_group_create`; explicit confirmation, proof or `unknown` |
| 64 | `POST /social/inspect-instagram-group-candidates` | adapted | native read-only candidate inspector |
| 65 | `POST /social/inspect-instagram-recent-conversations` | adapted | native read-only conversation inspector |
| 66 | `POST /social/inspect-instagram-conversation-controls` | adapted | native read-only control inspector |
| 67 | `POST /social/update-instagram-group-settings` | adapted | confirmed native worker; proof or `unknown` |
| 68 | `POST /social/add-instagram-group-members` | adapted | approved batches of up to three; proof or `unknown` |
| 69 | `POST /social/inspect-instagram-group-members` | adapted | native read-only member evidence inspector |
| 70 | `POST /batch/stop` | equivalent | CRM workflow cancel and policy gate |
| 71 | `POST /daily/stop` | adapted | atomic schedule stop and parent-flow pause |
| 72 | `GET /daily/runs` | adapted | `/api/crm/v1/tasks` |
| 73 | `DELETE /daily/runs` | adapted | terminal-run soft delete, active-run rejection, durable audit |
| 74 | `POST /sender/session` | adapted | existing account/session infrastructure |
| 75 | `POST /sender/verify-login` | adapted | `account_check` child task |
| 76 | `POST /sender/open-login` | adapted | CRM open-login plus Kasm polling |
| 77 | `POST /sender/verify-relationships` | adapted | native read-only Instagram verifier and evidence persistence |
| 78 | `POST /sender/evaluate-rotation` | adapted | `/api/crm/v1/accounts/{id}/rotation/evaluate` |
| 79 | `POST /sender/rotation-status` | adapted | `/api/crm/v1/accounts/{id}/rotation` |
| 80 | `POST /sender/reset-rotation` | adapted | `/api/crm/v1/accounts/{id}/rotation/reset` |
| 81 | `POST /sender/verify-message` | adapted | native outbound-bubble evidence verification; ambiguous submit becomes `unknown` |
| 82 | `POST /sender/send-batch` | adapted | CRM direct-message workflow, batch billing and no-retry platform submit |
| 83 | `POST /threads/search` | adapted | `POST /api/crm/v1/threads/search`; live-only TG browser executor, no cache/history fill |

## Release rule

The CRM module defaults to off (`CRM_ENABLED=0`). A blocked capability may move
to `adapted` or `equivalent` only when its Python handler, tenant isolation,
idempotency, billing boundary, platform evidence, restart recovery and named
test above are all present. Merely rendering the old screen is not sufficient.
