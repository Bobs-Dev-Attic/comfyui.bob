@echo off
rem Bob Studio launcher: sets up .venv on first run, checks the system, starts the app.
rem   start.bat               check, start, open the browser
rem   start.bat --no-browser  don't open the browser
rem   start.bat --skip-check  start without the system check
rem   start.bat --no-comfyui  don't start ComfyUI (BOB_COMFYUI_DIR in .env) when it isn't running
setlocal EnableExtensions
title Bob Studio
cd /d "%~dp0"

set "OPEN=--open"
set "CHECK=1"
set "COMFY=1"
:args
if "%~1"=="" goto args_done
if /i "%~1"=="--no-browser" set "OPEN="
if /i "%~1"=="--skip-check" set "CHECK=0"
if /i "%~1"=="--no-comfyui" set "COMFY=0"
shift
goto args
:args_done

set "PY=.venv\Scripts\python.exe"

rem ---------------------------------------------------------------- 1. Python environment
if exist "%PY%" goto venv_ready
echo Creating the Python environment in .venv ...
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 -m venv .venv
) else (
    python -m venv .venv
)
if not exist "%PY%" (
    echo.
    echo [FAIL] Could not create .venv. Install Python 3.11 or newer from https://www.python.org/
    echo        and tick "Add python.exe to PATH", then run start.bat again.
    goto fail
)
"%PY%" -m pip install --upgrade pip --quiet
:venv_ready

rem Reinstall packages when requirements.txt is newer than the last install.
"%PY%" -c "import os,sys; s='.venv/.requirements-installed'; sys.exit(0 if os.path.exists(s) and os.path.getmtime(s) >= os.path.getmtime('requirements.txt') else 1)"
if %errorlevel%==0 goto deps_ready
echo Installing Python packages ...
"%PY%" -m pip install -r requirements.txt --quiet
if errorlevel 1 (
    echo.
    echo [FAIL] Package install failed. Check your internet connection and try again.
    goto fail
)
type nul > ".venv\.requirements-installed"
:deps_ready

rem ---------------------------------------------------------------- 2. Already running?
"%PY%" -c "import run, sys; sys.exit(0 if run.running_version() else 1)"
if %errorlevel%==0 (
    "%PY%" run.py %OPEN%
    goto end
)

rem ---------------------------------------------------------------- 3. ComfyUI
rem Starts BOB_COMFYUI_DIR in its own window when ComfyUI isn't answering.
rem Exit 2 means it isn't configured, which is fine: the check below reports it.
if "%COMFY%"=="0" goto check
"%PY%" -m app.comfylaunch --wait 180

rem ---------------------------------------------------------------- 4. System check
:check
if "%CHECK%"=="0" goto start
"%PY%" -m app.syscheck --wait 30 --no-port
if %errorlevel%==0 goto start
echo Some checks failed. The app may not work until they are fixed.
choice /c YN /n /m "Start anyway? [Y/N] "
if errorlevel 2 goto end

rem ---------------------------------------------------------------- 5. Start
:start
"%PY%" run.py %OPEN%
if errorlevel 1 goto fail
goto end

:fail
echo.
pause
exit /b 1

:end
endlocal
