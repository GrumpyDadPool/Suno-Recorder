@echo off
REM DEPRECATED — prefer chrome_extension/ (Suno Recorder), which uses your
REM normal Chrome profile and needs no separate login step.
REM
REM Legacy helper for python main.py capture only: opens a non-automated
REM Chrome window pointed at browser_profile/ so you can log into Suno once
REM outside Playwright. Do not commit browser_profile/ (cookies / login state).

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
