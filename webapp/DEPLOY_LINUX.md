# Linux Deployment

## 1. Install dependencies

```bash
cd /path/to/工作流接单
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt
```

## 2. Start service

```bash
cd /path/to/工作流接单
source .venv/bin/activate
export ADMIN_BOOTSTRAP_USERNAME=admin
export ADMIN_BOOTSTRAP_PASSWORD='replace-with-a-unique-password-of-at-least-12-characters'
export SESSION_COOKIE_SECURE=1
export FORCE_HTTPS=1
export HTTPS_CANONICAL_ORIGIN='https://<server-ip-or-domain>'
uvicorn webapp.server:app --host 0.0.0.0 --port 8000
```

Open:

- `https://<server-ip-or-domain>/?login=1` (shared public login dialog)
- User page: `https://<server-ip-or-domain>/console.html`
- Admin page: `https://<server-ip-or-domain>/admin`

## 3. Initial admin account

- Username comes from `ADMIN_BOOTSTRAP_USERNAME` (defaults to `admin`).
- Password must be supplied through `ADMIN_BOOTSTRAP_PASSWORD` and must contain at least 12 characters.

The service refuses to initialize an empty database without a secure bootstrap password. Existing databases are not reseeded.

## 4. Data location

- Default: `./webapp_data`
- Override: environment variable `WEBAPP_DATA_DIR`

Includes:

- SQLite DB: users/sessions/tasks/ledger
- Uploaded source files
- Generated outputs (video/audio/image/zip)
