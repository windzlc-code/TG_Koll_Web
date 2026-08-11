# Native CRM container runbook

## Runtime contract

The production image runs one Uvicorn process on port `8001`. React CRM files
are compiled during the image build and served by FastAPI. No Vinext,
`crm-orchestrator.mjs`, `social-automation.mjs`, port `3000`, `8090`, or `8091`
is started.

Required durable layout under the existing `/data` volume:

```text
/data/webapp_data/app.db
/data/webapp_data/crm_imports/
/data/webapp_data/crm_media/
/data/webapp_data/crm_evidence/
/data/webapp_data/crm_logs/
```

The entrypoint creates the CRM-owned directories. It never deletes or imports
browser profiles, cookies, sessions, cache directories, or another module's
data.

## Required configuration

| Variable | Required value / purpose |
|---|---|
| `CRM_ENABLED` | Hard gate. Keep `0` during schema rollout; set `1` only for the controlled migration/grey release. |
| `CRM_TRACKING_SECRET` | Stable random secret of at least 32 characters. Rotating it invalidates outstanding signed links. |
| `WEBAPP_DATA_DIR` | `/data/webapp_data` in the image. |
| `CRM_MIN_FREE_BYTES` | Default `536870912`; new uploads/imports/tasks stop below this threshold. |
| `CRM_MEDIA_MAX_BYTES` | Default 20 MiB per image. |
| `CRM_MEDIA_USER_QUOTA_BYTES` | Default 500 MiB per user. |
| `CRM_EVIDENCE_RETENTION_DAYS` | Default 90, minimum 1. |
| `CRM_LOG_RETENTION_DAYS` | Default 180, minimum 1. |
| `CRM_SCHEDULER_LEASE_SECONDS` | Default 30; database leader lease. |

Keep the tracking secret in the existing server secret store, not in source or
the imported CRM package.

## Build and controlled start

```powershell
docker build -t tg-koll-web:crm-v2 .
docker run -d --name tg-koll-web-crm `
  -p 8001:8001 `
  -v tg_koll_data:/data `
  -e CRM_ENABLED=0 `
  -e CRM_TRACKING_SECRET='<server-secret-at-least-32-characters>' `
  tg-koll-web:crm-v2
```

Only host port `8001` is published. Preserve the existing production reverse
proxy and cookie/HTTPS settings.

## Migration sequence

1. Start the new image with `CRM_ENABLED=0`; verify the existing console and
   social tasks first.
2. Upload the read-only snapshot directory or JSON file beneath
   `/data/webapp_data/crm_imports/`. Do not copy legacy profiles or cookies.
3. Set `CRM_ENABLED=1`, leave the database global CRM switch off, and open the
   administrator `CRM 模块` page.
4. Run dry-run for the super administrator. Resolve every missing-media and
   ambiguous-account row in the report.
5. Activate the verified batch. Activation creates an SQLite backup before
   staging writes and makes the batch visible only after staging completes.
6. Enable the global switch, grant only the super administrator, and check
   `/api/admin/modules/crm/health` until every readiness item is healthy.
7. Execute controlled read actions, open-login takeover, one owned public
   interaction, evidence confirmation, restart recovery, and tracking-link
   tests.
8. Grant ordinary users individually.

The image defaults to safe-off. A capability marked `blocked` in
`CAPABILITY_MATRIX.md` remains read-only even when the module is enabled.

## Rollback

Rollback the image/code independently from data. Keep the current `/data`
volume and current `app.db`; an older image must never restore an old database
automatically. Restore the pre-import SQLite backup only after an explicit data
rollback decision and only if no newer production writes need to be retained.
