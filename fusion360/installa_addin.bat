@echo off
setlocal
set "SRC=%~dp0CascadeBridge"
set "DST=%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\CascadeBridge"

if not exist "%SRC%\CascadeBridge.manifest" (
  echo ERRORE: non trovo "%SRC%\CascadeBridge.manifest".
  echo Estrai tutta la cartella fusion360 e rilancia questo file.
  pause
  exit /b 1
)

if not exist "%DST%" mkdir "%DST%"
xcopy "%SRC%\*" "%DST%\" /E /I /Y >nul
if errorlevel 1 (
  echo ERRORE durante la copia in "%DST%".
  pause
  exit /b 1
)

echo.
echo Cascade Bridge installato in:
echo   %DST%
echo.
echo In Fusion 360: Strumenti ^> Add-in ^> Script e Add-in
echo scheda "Add-in", seleziona Cascade Bridge e premi Run.
echo.
pause
