!define APPNAME "实时新闻中心"
!define APPVERSION "1.1.7"
!define EXE "NewsCenter.exe"
!define SRC "F:\MyPython\PrivateNewsCenter\dist\NewsCenter"

Unicode true
SilentInstall silent
AutoCloseWindow true
RequestExecutionLevel user

OutFile "F:\MyPython\PrivateNewsCenter\dist\实时新闻中心.exe"
SetCompressor /SOLID zlib

Section "main" SEC01
  SetOutPath "$TEMP\PrivateNewsCenter"
  File /r /x "data" "${SRC}\*.*"
  ExecWait "$TEMP\PrivateNewsCenter\${EXE}"
  RMDir /r "$TEMP\PrivateNewsCenter"
SectionEnd
