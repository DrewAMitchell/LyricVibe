@echo off
setlocal
if defined LYRICVIBE_NATIVE_PYTHON (
  set "PYTHON_EXE=%LYRICVIBE_NATIVE_PYTHON%"
) else (
  if not defined LOCALAPPDATA exit /b 2
  set "PYTHON_EXE=%LOCALAPPDATA%\LyricVibe\analysis-venv\Scripts\python.exe"
)
if not "%PYTHON_EXE:~1,2%"==":\" if not "%PYTHON_EXE:~0,2%"=="\\" exit /b 5
for %%I in ("%~dp0native_host.py") do set "HOST_SCRIPT=%%~fI"
if not exist "%PYTHON_EXE%" exit /b 3
if not exist "%HOST_SCRIPT%" exit /b 4
"%PYTHON_EXE%" "%HOST_SCRIPT%" %*
exit /b %ERRORLEVEL%
