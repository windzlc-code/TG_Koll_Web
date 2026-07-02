@echo off
setlocal

cd /d "%~dp0"

if not exist ".venv-desktop" (
    py -3.10 -m venv .venv-desktop
    if errorlevel 1 py -3 -m venv .venv-desktop
)

call ".venv-desktop\Scripts\activate.bat"
python -m pip install -U pip
python -m pip install -r requirements-desktop.txt
python desktop_assets\generate_desktop_icon.py
python -m PyInstaller --clean --noconfirm desktop_app.spec

echo.
echo Build finished:
echo dist\WorkflowDesktop\WorkflowDesktop.exe
pause
