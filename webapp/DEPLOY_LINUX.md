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
uvicorn webapp.server:app --host 0.0.0.0 --port 8000
```

Open:

- `http://<server-ip>:8000/login.html`
- User page: `http://<server-ip>:8000/index.html`
- Admin page: `http://<server-ip>:8000/admin.html`

## 3. Default admin account

- Username: `admin`
- Password: `admin123`

Change password by creating a new admin account or updating DB manually.

## 4. Data location

- Default: `./webapp_data`
- Override: environment variable `WEBAPP_DATA_DIR`

Includes:

- SQLite DB: users/sessions/tasks/ledger
- Uploaded source files
- Generated outputs (video/audio/image/zip)
