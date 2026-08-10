!define APPNAME "实时新闻中心"
!define APPVERSION "1.1.8"
!define PUBLISHER "PrivateNewsCenter"
!define EXE "NewsCenter.exe"
!define SRC "F:\MyPython\PrivateNewsCenter\dist\NewsCenter"

Unicode true
SetCompressor /SOLID lzma

Name "${APPNAME}"
OutFile "F:\MyPython\PrivateNewsCenter\dist-installer\实时新闻中心-Setup-${APPVERSION}.exe"
; 安装目录使用 ASCII 名，避免不同机器上的非 ASCII 路径兼容问题；
; 开始菜单/桌面/卸载项等用户可见名称仍为中文（见 APPNAME）。
InstallDir "$PROGRAMFILES64\NewsCenter"
RequestExecutionLevel admin

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "主程序" SEC01
  SetOutPath "$INSTDIR"
  ; 排除开发机本地缓存 data/（含个人收藏/设置/图片缓存），
  ; 安装版运行在 Program Files，首次启动会自动在用户目录（AppData）重建数据。
  File /r /x "data" "${SRC}\*.*"

  ; 开始菜单 + 桌面快捷方式
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXE}"

  ; 卸载程序
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; 写入注册表，使“控制面板-程序和功能”可正常卸载
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayVersion" "${APPVERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayIcon" "$\"$INSTDIR\${EXE}$\""
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
SectionEnd
