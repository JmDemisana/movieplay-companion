@echo off
echo Installing dependencies...
call npm install
echo Building executable with pkg...
call npm run build
echo Build complete. The executable is MoviePlayCompanion.exe.
pause
