import atexit
import os
import shutil
import tempfile
from pathlib import Path


# Test modules import webapp.server at collection time. Isolate those imports
# before the application can initialize the live local database or persona data.
_TEST_ROOT = Path(tempfile.mkdtemp(prefix="tg-koll-web-tests-"))
_TEST_DATA_DIR = _TEST_ROOT / "webapp_data"
_TEST_RUNTIME_DIR = _TEST_ROOT / "tool_r18_runtime"
_TEST_UPLOAD_DIR = _TEST_ROOT / "tool_r18_uploads"
for _directory in (_TEST_DATA_DIR, _TEST_RUNTIME_DIR, _TEST_UPLOAD_DIR):
    _directory.mkdir(parents=True, exist_ok=True)

os.environ["WEBAPP_DATA_DIR"] = str(_TEST_DATA_DIR)
os.environ["APP_DB_PATH"] = str(_TEST_DATA_DIR / "app.db")
os.environ["APP_RUNTIME_CONFIG_PATH"] = str(_TEST_DATA_DIR / "runtime_config.json")
os.environ["TOOL_R18_RUNTIME_DIR"] = str(_TEST_RUNTIME_DIR)
os.environ["TOOL_R18_UPLOAD_HOST_DIR"] = str(_TEST_UPLOAD_DIR)
os.environ["ADMIN_BOOTSTRAP_PASSWORD"] = "tests-only-admin-password"

atexit.register(shutil.rmtree, _TEST_ROOT, ignore_errors=True)
