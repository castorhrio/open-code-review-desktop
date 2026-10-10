@echo off
cd /d "%~dp0"
if not exist "out\index.html" (
  echo 首次运行，正在构建界面，请稍候…
  call npm run build
  if errorlevel 1 (
    echo 构建失败，请先确认已执行过 npm install
    pause
    exit /b 1
  )
)
start "" node_modules\.bin\electron.cmd .
