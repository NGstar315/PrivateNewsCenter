@echo off
chcp 65001 >nul
echo ============================================
echo   实时新闻中心 —— 一键打包成 Windows 安装程序
echo ============================================
echo.
echo [1/2] 正在安装依赖（仅首次需要，可能耗时几分钟）...
call npm install
if errorlevel 1 (
  echo.
  echo 安装依赖失败，请检查网络后重试。
  pause
  exit /b 1
)
echo.
echo [2/2] 正在打包 exe 安装程序（输出到 dist\ 目录）...
call npm run dist
if errorlevel 1 (
  echo.
  echo 打包失败，请查看上方报错信息。
  pause
  exit /b 1
)
echo.
echo 完成！安装包已生成在 dist\ 目录下，双击即可安装使用。
echo.
pause
