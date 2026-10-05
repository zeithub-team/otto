; zeithub.otto — standalone installer for local builds (npm run dist:local).
;
; electron-builder's NSIS target runs a freshly built, unsigned uninstaller stub while
; building, which Windows Smart App Control blocks. This script is compiled by makensis
; alone: nothing is executed at build time, the uninstaller is written during install.
;
; Defines passed by scripts/dist-local.mjs:
;   SRC      folder with the unpacked app (release\win-unpacked)
;   OUTFILE  the installer to write
;   VERSION  app version
;   ICON     app icon (.ico)
;   BUILD_RESOURCES_DIR  apps/desktop/build (wizard artwork)
;
; The setup wizard itself (stack, UI language, colour scheme -> setup.json) is the same
; installer.nsi the electron-builder installer uses: its macros are inserted here.

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "installer.nsi"

!define APP "zeithub.otto"
!define EXE "zeithub.otto.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "Software\${APP}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APP} ${VERSION}"
SetFont "Segoe UI" 9

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
; dark Otto look (see zhDarkPage in installer.nsi)
!define MUI_BGCOLOR 0b0f14
!define MUI_TEXTCOLOR e6edf3
!define MUI_HEADER_TRANSPARENT_TEXT
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\installerHeader.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${BUILD_RESOURCES_DIR}\installerSidebar.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${BUILD_RESOURCES_DIR}\installerSidebar.bmp"
; welcome / finish texts of the wizard
!insertmacro customHeader

; an update (see .onInit) skips welcome, folder, stack and look: straight to copying files
!define MUI_PAGE_CUSTOMFUNCTION_PRE zhSkipOnUpdate
!define MUI_PAGE_CUSTOMFUNCTION_SHOW zhDarkPage
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE zhSkipOnUpdate
!define MUI_PAGE_CUSTOMFUNCTION_SHOW zhDarkPage
!insertmacro MUI_PAGE_DIRECTORY
; stack (languages, Docker, Git, Ollama…) and look (UI language, colour scheme)
!insertmacro customPageAfterChangeDir
!define MUI_PAGE_CUSTOMFUNCTION_SHOW zhDarkPage
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_SHOW zhDarkPage
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductName" "${APP}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileDescription" "${APP} installer"
VIAddVersionKey /LANG=${LANG_ENGLISH} "LegalCopyright" "zeithub"

Var zhOldVersion

Function .onInit
  !insertmacro customInit
  ; already installed: offer an update into the same folder, keeping settings and projects
  StrCpy $zhUpdating 0
  ReadRegStr $zhOldVersion HKCU "${UNINST_KEY}" "DisplayVersion"
  ReadRegStr $0 HKCU "${UNINST_KEY}" "InstallLocation"
  ${If} $zhOldVersion != ""
  ${AndIf} $0 != ""
  ${AndIf} ${FileExists} "$0\${EXE}"
    StrCpy $INSTDIR $0
    StrCpy $zhUpdating 1
    IfSilent zh_update_go
    ${If} $LANGUAGE == ${LANG_RUSSIAN}
      MessageBox MB_YESNO|MB_ICONQUESTION "${APP} $zhOldVersion уже установлен.$\r$\n$\r$\nОбновить до ${VERSION}? Настройки, проекты и чаты сохранятся.$\r$\n$\r$\nНет — полная установка с выбором папки и параметров." IDYES zh_update_go
    ${Else}
      MessageBox MB_YESNO|MB_ICONQUESTION "${APP} $zhOldVersion is already installed.$\r$\n$\r$\nUpdate to ${VERSION}? Settings, projects and chats are kept.$\r$\n$\r$\nNo — full setup with folder and options." IDYES zh_update_go
    ${EndIf}
    StrCpy $zhUpdating 0
    zh_update_go:
  ${EndIf}
FunctionEnd

Function zhSkipOnUpdate
  ${If} $zhUpdating == 1
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  ; a running copy would lock its files
  nsExec::Exec 'taskkill /IM "${EXE}" /F'
  Sleep 500

  ; an update replaces the app code entirely, so files dropped in the new version do not linger
  ${If} $zhUpdating == 1
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
  ${EndIf}
  SetOutPath "$INSTDIR"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; /NOSHORTCUTS: used by the self-test of the build script
  ${GetParameters} $0
  ${GetOptions} $0 "/NOSHORTCUTS" $1
  ${If} ${Errors}
    CreateDirectory "$SMPROGRAMS\${APP}"
    CreateShortcut "$SMPROGRAMS\${APP}\${APP}.lnk" "$INSTDIR\${EXE}"
    CreateShortcut "$SMPROGRAMS\${APP}\Uninstall ${APP}.lnk" "$INSTDIR\Uninstall.exe"
    CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}"
  ${EndIf}

  WriteRegStr HKCU "Software\${APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "zeithub"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0

  ; the wizard's choices -> %APPDATA%\zeithub.otto\setup.json, applied on first launch
  !insertmacro customInstall
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM "${EXE}" /F'
  Sleep 500
  ; the app files only: projects, chats and settings live in %APPDATA%\${APP} and stay
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\${APP}.lnk"
  RMDir /r "$SMPROGRAMS\${APP}"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP}"
SectionEnd
