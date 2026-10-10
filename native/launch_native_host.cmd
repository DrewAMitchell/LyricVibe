@echo off
setlocal
if not defined LOCALAPPDATA exit /b 2
set "PYTHON_EXE=%LOCALAPPDATA%\LyricVibe\analysis-venv\Scripts\python.exe"
for %%I in ("%~dp0native_host.py") do set "HOST_SCRIPT=%%~fI"
if not exist "%PYTHON_EXE%" exit /b 3
if not exist "%HOST_SCRIPT%" exit /b 4
"%PYTHON_EXE%" "%HOST_SCRIPT%" %*
exit /b %ERRORLEVEL%
