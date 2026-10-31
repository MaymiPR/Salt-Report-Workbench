@echo off
setlocal EnableExtensions
rem SPDX-License-Identifier: AGPL-3.0-only
rem
rem S.A.L.T. Report Workbench launcher. Double-click to start the sync server.
rem No install and no admin rights needed, only Python 3.11.8 or newer.
rem
rem If your machine needs a specific python.exe, put its full path between the
rem quotes on the PYTHON_EXE line below, for example:
rem
rem     set "PYTHON_EXE=C:\Tools\Python312\python.exe"
rem
rem Or set it once per user, without editing this file (no admin needed):
rem
rem     setx SALT_PYTHON "C:\Tools\Python312\python.exe"
rem
rem Left empty, the launcher looks for Python by itself. Anything typed after
rem the launcher's name goes to the server, for example --port 9090.

set "PYTHON_EXE="

title S.A.L.T. Report Workbench

rem pushd, not cd: it also works when the folder is on a network share.
pushd "%~dp0" || (
    echo [!] Could not open the folder "%~dp0".
    goto :fail
)
if not exist "salt_sync_server.py" (
    echo [!] salt_sync_server.py is missing. Keep this launcher in the same
    echo      folder as salt_sync_server.py and index.html.
    goto :fail
)

set "PY="

rem 1. An explicit choice wins, and a wrong one is reported, not skipped.
if not defined PYTHON_EXE if defined SALT_PYTHON set "PYTHON_EXE=%SALT_PYTHON%"
if defined PYTHON_EXE (
    call :try "%PYTHON_EXE%" && goto :run
    echo [!] Could not use "%PYTHON_EXE%".
    echo      Check that the path is right and that it is Python 3.11.8 or newer.
    goto :fail
)

rem 2. A portable Python unzipped into a "python" folder beside this launcher.
call :try "%~dp0python\python.exe" && goto :run

rem 3. The py launcher, then whatever "python" is on PATH. Each candidate is
rem    test-run, which also skips the Microsoft Store placeholder.
for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do (
    call :try "%%P" && goto :run
)
for /f "delims=" %%P in ('where python 2^>nul') do (
    call :try "%%P" && goto :run
)

rem 4. Per-user and all-users installs that were never added to PATH.
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*" "%ProgramFiles%\Python3*" "%SystemDrive%\Python3*") do (
    call :try "%%D\python.exe" && goto :run
)

echo [!] Python 3.11.8 or newer was not found.
echo.
echo      Open this file in Notepad and put the full path to python.exe on the
echo      PYTHON_EXE line near the top, for example:
echo.
echo          set "PYTHON_EXE=C:\Tools\Python312\python.exe"
goto :fail

:run
echo [*] Using Python: %PY%
"%PY%" salt_sync_server.py %*
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
    echo.
    echo [!] The server stopped with exit code %RC%.
    pause
)
exit /b %RC%

:fail
popd 2>nul
echo.
pause
exit /b 1

rem Sets PY to %1 if it runs and is Python 3.11.8 or newer.
:try
if "%~1"=="" exit /b 1
if not exist "%~1" exit /b 1
"%~1" -c "import sys; sys.exit(sys.version_info < (3, 11, 8))" >nul 2>&1 || exit /b 1
set "PY=%~1"
exit /b 0
