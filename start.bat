@echo off
setlocal

cd /d "%~dp0"

set "SCRIPT_DIR=%~dp0"
set "VENV_DIR=%SCRIPT_DIR%.venv-desktop"
set "REQ_FILE=%SCRIPT_DIR%requirements-desktop.txt"
set "STAMP_FILE=%VENV_DIR%\.deps-ready"
set "CHECK_ONLY=0"
set "DEBUG_MODE=0"

if /i "%~1"=="--check" set "CHECK_ONLY=1"
if /i "%~1"=="--debug" set "DEBUG_MODE=1"

if not exist "%REQ_FILE%" (
    echo requirements-desktop.txt not found.
    goto :fail
)

if not exist "%SCRIPT_DIR%desktop_launcher.py" (
    echo desktop_launcher.py not found.
    goto :fail
)

call :detect_python
if errorlevel 1 goto :fail

if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo [1/4] Creating virtual environment...
    call %PYTHON_BOOTSTRAP% -m venv "%VENV_DIR%"
    if errorlevel 1 goto :fail
)

call "%VENV_DIR%\Scripts\activate.bat"
if errorlevel 1 goto :fail

set "NEED_INSTALL=1"
if exist "%STAMP_FILE%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$stamp = Get-Item -LiteralPath '%STAMP_FILE%';" ^
        "$deps = @('requirements-desktop.txt','requirements.txt','desktop_launcher.py') | ForEach-Object { Get-Item -LiteralPath (Join-Path '%SCRIPT_DIR%' $_) };" ^
        "if (($deps | Where-Object { $_.LastWriteTimeUtc -gt $stamp.LastWriteTimeUtc }).Count -eq 0) { exit 0 } else { exit 1 }" >nul 2>&1
    if not errorlevel 1 set "NEED_INSTALL=0"
)

if "%NEED_INSTALL%"=="1" (
    echo [2/4] Installing desktop dependencies...
    python -m pip install --disable-pip-version-check -U pip
    if errorlevel 1 goto :fail
    python -m pip install --disable-pip-version-check -r "%REQ_FILE%"
    if errorlevel 1 goto :fail
    >"%STAMP_FILE%" echo ready
) else (
    echo [2/4] Dependencies are ready.
)

if "%CHECK_ONLY%"=="1" (
    echo [3/4] Environment check passed.
    echo You can now double-click start.bat to launch the desktop app.
    goto :success
)

echo [3/4] Launching Workflow Desktop...
if "%DEBUG_MODE%"=="1" (
    echo Running in debug mode. Console output will stay visible.
    "%VENV_DIR%\Scripts\python.exe" "%SCRIPT_DIR%desktop_launcher.py"
    if errorlevel 1 goto :fail
) else (
    if exist "%VENV_DIR%\Scripts\pythonw.exe" (
        start "" "%VENV_DIR%\Scripts\pythonw.exe" "%SCRIPT_DIR%desktop_launcher.py"
    ) else (
        start "" "%VENV_DIR%\Scripts\python.exe" "%SCRIPT_DIR%desktop_launcher.py"
    )
)
if "%DEBUG_MODE%"=="0" if errorlevel 1 goto :fail

echo [4/4] Workflow Desktop started.
goto :success

:detect_python
set "PYTHON_BOOTSTRAP="

where py >nul 2>&1
if not errorlevel 1 (
    py -3.10 -c "import sys" >nul 2>&1
    if not errorlevel 1 (
        set "PYTHON_BOOTSTRAP=py -3.10"
        exit /b 0
    )
    py -3 -c "import sys" >nul 2>&1
    if not errorlevel 1 (
        set "PYTHON_BOOTSTRAP=py -3"
        exit /b 0
    )
)

where python >nul 2>&1
if not errorlevel 1 (
    python -c "import sys" >nul 2>&1
    if not errorlevel 1 (
        set "PYTHON_BOOTSTRAP=python"
        exit /b 0
    )
)

echo Python 3.10+ was not found. Install Python, then run start.bat again.
exit /b 1

:fail
echo.
echo Startup failed.
pause
exit /b 1

:success
exit /b 0
