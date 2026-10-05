; zeithub.otto — custom NSIS include for electron-builder.
;
; Saved as UTF-8 WITH BOM: Unicode NSIS needs it to read Cyrillic correctly.
; Artwork lives in ../build (regenerate: `npm run installer-assets -w @otto/desktop`).
;
; What this adds to the wizard
;   customHeader              welcome / finish page texts
;   customInit                defaults + fade-in splash + extracts wizard icons
;   customPageAfterChangeDir  page 1 "stack" (preset, languages, tools) and
;                             page 2 "look" (UI language, color scheme + preview)
;   customInstall             writes %APPDATA%\zeithub.otto\setup.json, which the
;                             app applies on first launch (see src/server/setup.ts)
;
; Nothing is installed by the wizard itself: the app installs the chosen tools
; on first launch with visible progress, so the installer stays small and fast.

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

; The uninstaller pass never uses this state — declaring it there is a fatal warning.
!ifndef BUILD_UNINSTALLER
; ---------------------------------------------------------------- state ----
Var zhTmp
Var zhDlg
Var zhImg
Var zhPresetCb
Var zhLangCb
Var zhThemeCb
Var zhThemeImgCtl
Var zhThemeImgHandle
Var zhPresetIdx
Var zhLangIdx
Var zhThemeIdx
Var zhLangId
Var zhThemeId
Var zhTools
; 1 = an existing install is being updated: the wizard pages and setup.json are skipped
Var zhUpdating

; one control handle + one checked-state per stack item
!macro zhDeclare ID
  Var zhH_${ID}
  Var zhS_${ID}
!macroend

!macro zhForEach M
  !insertmacro ${M} js
  !insertmacro ${M} py
  !insertmacro ${M} php
  !insertmacro ${M} go
  !insertmacro ${M} rust
  !insertmacro ${M} java
  !insertmacro ${M} net
  !insertmacro ${M} git
  !insertmacro ${M} gh
  !insertmacro ${M} ollama
  !insertmacro ${M} docker
!macroend

!macro zhForEachTheme M
  !insertmacro ${M} emerald
  !insertmacro ${M} ocean
  !insertmacro ${M} violet
  !insertmacro ${M} amber
  !insertmacro ${M} light
  !insertmacro ${M} dracula
  !insertmacro ${M} nord
  !insertmacro ${M} tokyo
  !insertmacro ${M} onedark
  !insertmacro ${M} gruvbox
  !insertmacro ${M} catppuccin
  !insertmacro ${M} solarized
  !insertmacro ${M} solarized-light
!macroend

!insertmacro zhForEach zhDeclare
!endif

!macro zhExtract ID
  File "/oname=$PLUGINSDIR\zh-${ID}.bmp" "${BUILD_RESOURCES_DIR}\wizard\${ID}.bmp"
!macroend

!macro zhExtractTheme ID
  File "/oname=$PLUGINSDIR\zh-theme-${ID}.bmp" "${BUILD_RESOURCES_DIR}\wizard\theme-${ID}.bmp"
!macroend

!macro zhRead ID
  ${NSD_GetState} $zhH_${ID} $zhS_${ID}
!macroend

; icon + checkbox row.  XI = icon x, XC = checkbox x, Y = row y (dialog units)
!macro zhItem ID XI XC Y LABEL
  ${NSD_CreateBitmap} ${XI}u ${Y}u 16u 13u ""
  Pop $zhTmp
  ${NSD_SetImage} $zhTmp "$PLUGINSDIR\zh-${ID}.bmp" $zhImg
  ${NSD_CreateCheckbox} ${XC}u ${Y}u 124u 12u "${LABEL}"
  Pop $zhH_${ID}
  ${If} $zhS_${ID} == 1
    ${NSD_Check} $zhH_${ID}
  ${EndIf}
!macroend

; preset: js py php go rust java net git gh ollama docker (1 = checked)
!macro zhP JS PY PHP GO RS JV NET GIT GH OL DK
  ${NSD_SetState} $zhH_js ${JS}
  ${NSD_SetState} $zhH_py ${PY}
  ${NSD_SetState} $zhH_php ${PHP}
  ${NSD_SetState} $zhH_go ${GO}
  ${NSD_SetState} $zhH_rust ${RS}
  ${NSD_SetState} $zhH_java ${JV}
  ${NSD_SetState} $zhH_net ${NET}
  ${NSD_SetState} $zhH_git ${GIT}
  ${NSD_SetState} $zhH_gh ${GH}
  ${NSD_SetState} $zhH_ollama ${OL}
  ${NSD_SetState} $zhH_docker ${DK}
!macroend

!macro zhCollect ID TOOL
  ${If} $zhS_${ID} == 1
    StrCpy $zhTools "$zhTools${TOOL},"
  ${EndIf}
!macroend

; ------------------------------------------------------------- functions ----
!macro zhFunctions

Function zhOnPreset
  Pop $0
  SendMessage $zhPresetCb ${CB_GETCURSEL} 0 0 $zhPresetIdx
  ${Switch} $zhPresetIdx
    ${Case} 0
      !insertmacro zhP 1 0 0 0 0 0 0 1 0 1 1
      ${Break}
    ${Case} 1
      !insertmacro zhP 1 0 1 0 0 0 0 1 0 1 1
      ${Break}
    ${Case} 2
      !insertmacro zhP 0 1 0 0 0 0 0 1 0 1 1
      ${Break}
    ${Case} 3
      !insertmacro zhP 0 0 0 1 1 0 0 1 0 1 1
      ${Break}
    ${Case} 4
      !insertmacro zhP 0 0 0 0 0 1 1 1 0 1 1
      ${Break}
    ${Case} 5
      !insertmacro zhP 0 0 0 0 0 0 0 0 0 0 0
      ${Break}
  ${EndSwitch}
FunctionEnd

; ----------------------------------------------------------- dark theme ----
; Otto look on every page: dark window, light text, green accent. Themed (visual-style)
; checkboxes ignore text colours, so their theme is switched off first.
!define ZH_BG 0x0b0f14
!define ZH_FG 0xe6edf3
!define ZH_FIELD 0x161b22

; $R9 = window whose direct children are recoloured
Function zhDarkChildren
  StrCpy $R8 0
  loop:
    FindWindow $R8 "" "" $R9 $R8
    StrCmp $R8 0 done
    System::Call 'user32::GetClassNameW(p R8, w .R7, i 64)'
    ${If} $R7 == "Button"
      System::Call 'user32::GetWindowLongW(p R8, i -16) i .R6'
      IntOp $R6 $R6 & 0xF
      ${If} $R6 < 2
        System::Call 'uxtheme::#133(p R8, i 1)'
        System::Call 'uxtheme::SetWindowTheme(p R8, w "DarkMode_Explorer", p 0)'
      ${ElseIf} $R6 != 11
        ; checkbox / radio / group box
        System::Call 'uxtheme::SetWindowTheme(p R8, w " ", w " ")'
        SetCtlColors $R8 ${ZH_FG} ${ZH_BG}
      ${EndIf}
    ${ElseIf} $R7 == "ComboBox"
      System::Call 'uxtheme::#133(p R8, i 1)'
      System::Call 'uxtheme::SetWindowTheme(p R8, w "DarkMode_CFD", p 0)'
    ${ElseIf} $R7 == "Edit"
      SetCtlColors $R8 ${ZH_FG} ${ZH_FIELD}
    ${ElseIf} $R7 == "Static"
      SetCtlColors $R8 ${ZH_FG} ${ZH_BG}
    ${ElseIf} $R7 == "msctls_progress32"
      System::Call 'uxtheme::SetWindowTheme(p R8, w " ", w " ")'
      SendMessage $R8 0x2001 0 0x00221b16 ; PBM_SETBKCOLOR (BGR)
      SendMessage $R8 0x0409 0 0x00a0f500 ; PBM_SETBARCOLOR: #00f5a0
    ${ElseIf} $R7 == "SysListView32"
      SendMessage $R8 0x1001 0 0x00140f0b ; LVM_SETBKCOLOR
      SendMessage $R8 0x1026 0 0x00140f0b ; LVM_SETTEXTBKCOLOR
      SendMessage $R8 0x1024 0 0x00f3ede6 ; LVM_SETTEXTCOLOR
    ${EndIf}
    Goto loop
  done:
FunctionEnd

; recolour the wizard frame and the current inner page
Function zhDarkPage
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  Push $R5
  ; app-wide dark mode (SetPreferredAppMode ForceDark) and a dark title bar
  System::Call 'uxtheme::#135(i 2)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  SetCtlColors $HWNDPARENT ${ZH_FG} ${ZH_BG}
  StrCpy $R9 $HWNDPARENT
  Call zhDarkChildren
  StrCpy $R5 0
  pages:
    FindWindow $R5 "#32770" "" $HWNDPARENT $R5
    StrCmp $R5 0 pagesDone
    SetCtlColors $R5 ${ZH_FG} ${ZH_BG}
    StrCpy $R9 $R5
    Call zhDarkChildren
    Goto pages
  pagesDone:
  Pop $R5
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
FunctionEnd

Function zhStackCreate
  ${If} $zhUpdating == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Ваш стек разработки" "Отметьте, что поставить. Позже: Сервисы → Инструменты."
  nsDialogs::Create 1018
  Pop $0
  StrCpy $zhDlg $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0u 2u 44u 10u "Профиль:"
  Pop $0
  ${NSD_CreateDropList} 46u 0u 170u 90u ""
  Pop $zhPresetCb
  ${NSD_CB_AddString} $zhPresetCb "Веб-разработка (JS / TS)"
  ${NSD_CB_AddString} $zhPresetCb "PHP / Laravel"
  ${NSD_CB_AddString} $zhPresetCb "Python / данные"
  ${NSD_CB_AddString} $zhPresetCb "Go / Rust (системное)"
  ${NSD_CB_AddString} $zhPresetCb "Java / .NET"
  ${NSD_CB_AddString} $zhPresetCb "Только приложение (без установок)"
  ${NSD_CB_AddString} $zhPresetCb "Свой выбор"
  SendMessage $zhPresetCb ${CB_SETCURSEL} $zhPresetIdx 0

  ${NSD_CreateLabel} 0u 15u 130u 9u "Языки и рантаймы"
  Pop $0
  ${NSD_CreateLabel} 152u 15u 140u 9u "Инструменты"
  Pop $0

  !insertmacro zhItem js 0 18 26 "JavaScript / TypeScript"
  !insertmacro zhItem py 0 18 39 "Python"
  !insertmacro zhItem php 0 18 52 "PHP (Laravel)"
  !insertmacro zhItem go 0 18 65 "Go"
  !insertmacro zhItem rust 0 18 78 "Rust"
  !insertmacro zhItem java 0 18 91 "Java (JDK)"
  !insertmacro zhItem net 0 18 104 "C# / .NET"

  !insertmacro zhItem git 152 170 26 "Git"
  !insertmacro zhItem gh 152 170 39 "GitHub CLI"
  !insertmacro zhItem ollama 152 170 52 "Ollama (локальные модели)"
  !insertmacro zhItem docker 152 170 65 "Docker Desktop"

  ${NSD_CreateLabel} 152u 84u 142u 40u "Docker — для баз данных и сервисов (без него вкладка «Сервисы» недоступна). Ollama — локальные модели и чат."
  Pop $0

  ${NSD_OnChange} $zhPresetCb zhOnPreset
  Call zhDarkPage
  SetCtlColors $zhDlg ${ZH_FG} ${ZH_BG}
  StrCpy $R9 $zhDlg
  Call zhDarkChildren
  nsDialogs::Show
FunctionEnd

Function zhStackLeave
  !insertmacro zhForEach zhRead
  SendMessage $zhPresetCb ${CB_GETCURSEL} 0 0 $zhPresetIdx
FunctionEnd

Function zhResolveLang
  ${Switch} $zhLangIdx
    ${Case} 0
      StrCpy $zhLangId "ru"
      ${Break}
    ${Case} 1
      StrCpy $zhLangId "en"
      ${Break}
    ${Case} 2
      StrCpy $zhLangId "az"
      ${Break}
    ${Case} 3
      StrCpy $zhLangId "ge"
      ${Break}
    ${Case} 4
      StrCpy $zhLangId "it"
      ${Break}
    ${Case} 5
      StrCpy $zhLangId "sp"
      ${Break}
    ${Default}
      StrCpy $zhLangId "ru"
  ${EndSwitch}
FunctionEnd

Function zhResolveTheme
  ${Switch} $zhThemeIdx
    ${Case} 0
      StrCpy $zhThemeId "emerald"
      ${Break}
    ${Case} 1
      StrCpy $zhThemeId "ocean"
      ${Break}
    ${Case} 2
      StrCpy $zhThemeId "violet"
      ${Break}
    ${Case} 3
      StrCpy $zhThemeId "amber"
      ${Break}
    ${Case} 4
      StrCpy $zhThemeId "light"
      ${Break}
    ${Case} 5
      StrCpy $zhThemeId "dracula"
      ${Break}
    ${Case} 6
      StrCpy $zhThemeId "nord"
      ${Break}
    ${Case} 7
      StrCpy $zhThemeId "tokyo"
      ${Break}
    ${Case} 8
      StrCpy $zhThemeId "onedark"
      ${Break}
    ${Case} 9
      StrCpy $zhThemeId "gruvbox"
      ${Break}
    ${Case} 10
      StrCpy $zhThemeId "catppuccin"
      ${Break}
    ${Case} 11
      StrCpy $zhThemeId "solarized"
      ${Break}
    ${Case} 12
      StrCpy $zhThemeId "solarized-light"
      ${Break}
    ${Default}
      StrCpy $zhThemeId "emerald"
  ${EndSwitch}
FunctionEnd

Function zhShowTheme
  Call zhResolveTheme
  ${If} $zhThemeImgHandle != 0
    System::Call 'gdi32::DeleteObject(i $zhThemeImgHandle)'
  ${EndIf}
  ${NSD_SetImage} $zhThemeImgCtl "$PLUGINSDIR\zh-theme-$zhThemeId.bmp" $zhThemeImgHandle
FunctionEnd

Function zhOnTheme
  Pop $0
  SendMessage $zhThemeCb ${CB_GETCURSEL} 0 0 $zhThemeIdx
  Call zhShowTheme
FunctionEnd

Function zhLookCreate
  ${If} $zhUpdating == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Оформление" "Язык интерфейса и цветовая схема. Их можно изменить позже в Настройках."
  nsDialogs::Create 1018
  Pop $0
  StrCpy $zhDlg $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0u 0u 200u 9u "Язык интерфейса приложения:"
  Pop $0
  ${NSD_CreateDropList} 0u 11u 140u 90u ""
  Pop $zhLangCb
  ${NSD_CB_AddString} $zhLangCb "Русский"
  ${NSD_CB_AddString} $zhLangCb "English"
  ${NSD_CB_AddString} $zhLangCb "Azərbaycanca"
  ${NSD_CB_AddString} $zhLangCb "ქართული"
  ${NSD_CB_AddString} $zhLangCb "Italiano"
  ${NSD_CB_AddString} $zhLangCb "Español"
  SendMessage $zhLangCb ${CB_SETCURSEL} $zhLangIdx 0

  ${NSD_CreateLabel} 0u 34u 200u 9u "Цветовая схема:"
  Pop $0
  ${NSD_CreateDropList} 0u 45u 140u 120u ""
  Pop $zhThemeCb
  ${NSD_CB_AddString} $zhThemeCb "Emerald (по умолчанию)"
  ${NSD_CB_AddString} $zhThemeCb "Ocean"
  ${NSD_CB_AddString} $zhThemeCb "Violet"
  ${NSD_CB_AddString} $zhThemeCb "Amber"
  ${NSD_CB_AddString} $zhThemeCb "Light"
  ${NSD_CB_AddString} $zhThemeCb "Dracula"
  ${NSD_CB_AddString} $zhThemeCb "Nord"
  ${NSD_CB_AddString} $zhThemeCb "Tokyo Night"
  ${NSD_CB_AddString} $zhThemeCb "One Dark"
  ${NSD_CB_AddString} $zhThemeCb "Gruvbox"
  ${NSD_CB_AddString} $zhThemeCb "Catppuccin"
  ${NSD_CB_AddString} $zhThemeCb "Solarized Dark"
  ${NSD_CB_AddString} $zhThemeCb "Solarized Light"
  SendMessage $zhThemeCb ${CB_SETCURSEL} $zhThemeIdx 0

  ${NSD_CreateBitmap} 152u 34u 136u 34u ""
  Pop $zhThemeImgCtl
  Call zhShowTheme

  ${NSD_CreateLabel} 0u 76u 288u 30u "Схема применится при первом запуске. В приложении доступно 13 цветовых схем: Settings → Color scheme."
  Pop $0

  ${NSD_OnChange} $zhThemeCb zhOnTheme
  Call zhDarkPage
  SetCtlColors $zhDlg ${ZH_FG} ${ZH_BG}
  StrCpy $R9 $zhDlg
  Call zhDarkChildren
  nsDialogs::Show
FunctionEnd

Function zhLookLeave
  SendMessage $zhLangCb ${CB_GETCURSEL} 0 0 $zhLangIdx
  SendMessage $zhThemeCb ${CB_GETCURSEL} 0 0 $zhThemeIdx
FunctionEnd

!macroend

; ------------------------------------------------------- electron-builder ----
!macro customHeader
  !define MUI_WELCOMEPAGE_TITLE "Добро пожаловать в zeithub.otto"
  !define MUI_WELCOMEPAGE_TEXT "Локальная AI-студия для разработки на базе Ollama: чат с контекстом проекта, редактор, задачи по этапам и терминал.$\r$\n$\r$\nДальше вы выберете свой стек (языки, Docker, Git), язык интерфейса и цветовую схему.$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
  !define MUI_FINISHPAGE_TITLE "zeithub.otto установлен"
  !define MUI_FINISHPAGE_TEXT "Готово. Выбранные инструменты приложение установит при первом запуске — с прогрессом и без лишних окон.$\r$\n$\r$\nВаш код и модели остаются на вашем компьютере."
!macroend

!macro customPageAfterChangeDir
  !insertmacro zhFunctions
  Page custom zhStackCreate zhStackLeave
  Page custom zhLookCreate zhLookLeave
!macroend

!macro customInit
  ; defaults (also used by silent installs): the "web developer" preset, Russian, Emerald
  StrCpy $zhPresetIdx 0
  StrCpy $zhLangIdx 0
  StrCpy $zhThemeIdx 0
  StrCpy $zhThemeImgHandle 0
  StrCpy $zhS_js 1
  StrCpy $zhS_py 0
  StrCpy $zhS_php 0
  StrCpy $zhS_go 0
  StrCpy $zhS_rust 0
  StrCpy $zhS_java 0
  StrCpy $zhS_net 0
  StrCpy $zhS_git 1
  StrCpy $zhS_gh 0
  StrCpy $zhS_ollama 1
  StrCpy $zhS_docker 1

  IfSilent zeithub_init_done
  InitPluginsDir
  File "/oname=$PLUGINSDIR\zeithub-splash.bmp" "${BUILD_RESOURCES_DIR}\installer-splash.bmp"
  ; delay(ms) fade-in(ms) fade-out(ms) transparent-colour(-1 = none) image
  advsplash::show 1500 600 500 -1 "$PLUGINSDIR\zeithub-splash"
  Pop $0
  !insertmacro zhForEach zhExtract
  !insertmacro zhForEachTheme zhExtractTheme
  zeithub_init_done:
!macroend

!macro customInstall
  IfSilent zeithub_setup_skip
  StrCmp $zhUpdating 1 zeithub_setup_skip ; an update keeps the user's settings
  Call zhResolveLang
  Call zhResolveTheme
  StrCpy $zhTools ""
  !insertmacro zhCollect js node
  !insertmacro zhCollect py python
  !insertmacro zhCollect php php
  !insertmacro zhCollect go go
  !insertmacro zhCollect rust rust
  !insertmacro zhCollect java java
  !insertmacro zhCollect net dotnet
  !insertmacro zhCollect git git
  !insertmacro zhCollect gh gh
  !insertmacro zhCollect ollama ollama
  !insertmacro zhCollect docker docker
  CreateDirectory "$APPDATA\zeithub.otto"
  FileOpen $0 "$APPDATA\zeithub.otto\setup.json" w
  FileWrite $0 '{"version":1,"locale":"$zhLangId","theme":"$zhThemeId","tools":"$zhTools"}'
  FileClose $0
  zeithub_setup_skip:
!macroend
