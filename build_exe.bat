@echo off
REM Builds gui.py into a single Windows .exe. Run this from the project folder
REM on Windows (PyInstaller doesn't cross-compile, so this can't be run from
REM anywhere else — has to be a real Windows machine).

pip install pyinstaller
pyinstaller --onefile --windowed --name "Suno Distributor" ^
    --hidden-import PIL._tkinter_finder ^
    gui.py

echo.
echo Done. Your exe is in dist\Suno Distributor.exe
echo Settings are saved to your Windows user profile, not this folder, so
echo they carry over automatically. Just keep client_secret.json (if using
echo YouTube) in the same folder as the exe.
echo.
echo NOTE on the Capture feature: bundling Playwright's browser automation
echo into a frozen exe is untested from where this was built and can be
echo unreliable with PyInstaller. If Capture doesn't work from the exe,
echo run "python main.py capture" or "python gui.py" from source instead
echo (with the venv/requirements installed) — everything else works fine
echo either way, this is specific to that one feature.
pause
