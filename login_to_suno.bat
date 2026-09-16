@echo off
REM Run this once before your first capture. It opens a completely normal
REM Chrome window (not automated, not controlled by Playwright) pointed at
REM the same profile folder the capture feature reuses later. Log into Suno
REM normally here — since Google can't tell this apart from any other Chrome
REM window, its "this browser may not be secure" block never triggers.
REM
REM Once you're logged in and can see your library, just close this Chrome
REM window. From then on, "python main.py capture" (or the GUI's Capture
REM button) reuses this same profile and skips straight to an already
REM logged-in session — Playwright only takes over after login is done.

set PROFILE_DIR=%~dp0browser_profile

where chrome >nul 2>nul
if %errorlevel%==0 (
    start chrome --user-data-dir="%PROFILE_DIR%" https://suno.com/me
    goto :done
)

REM 'chrome' isn't on PATH on most Windows installs — try the standard locations
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --user-data-dir="%PROFILE_DIR%" https://suno.com/me
    goto :done
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --user-data-dir="%PROFILE_DIR%" https://suno.com/me
    goto :done
)
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    start "" "%LocalAppData%\Google\Chrome\Application\chrome.exe" --user-data-dir="%PROFILE_DIR%" https://suno.com/me
    goto :done
)

echo Couldn't find chrome.exe automatically. Find it yourself (right-click your
echo Chrome shortcut -^> Properties -^> Target) and run this manually:
echo   "C:\path\to\chrome.exe" --user-data-dir="%PROFILE_DIR%" https://suno.com/me
pause
exit /b 1

:done
echo Chrome opened with a dedicated profile for this app. Log into Suno normally,
echo confirm you can see your library, then close this Chrome window.
echo After that, run "python main.py capture" or use the Capture button in the GUI.
