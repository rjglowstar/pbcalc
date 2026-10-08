; Extra steps for the NSIS installer (electron-builder: nsis.include in package.json). Source file, NOT build output: keep it.
;
; UNINSTALL does two different things:
;  1. ALWAYS: takes PBCalc out of Windows - the Default apps entries (electron/defaultBrowser.js writes them from the running program)
;     and the "Opens with" entries / file icons PBCalc put on file types - so Windows does not keep listing a browser that is gone.
;  2. ONLY IF THE USER SAYS YES in the question below: deletes PBCalc's data folder (saved passwords, the password for them,
;     bookmarks, settings, cache, cookies, crash reports). Downloaded files are the user's own and are never touched.
; A silent uninstall (/S - which is also how an update replaces the old version) never deletes data and never asks.
; ===== INSTALL PASSWORD + FIRST QUESTIONS ======================================================================================
; Right after the install-folder page the installer asks for the installation password (3 tries, then it quits and nothing is installed),
; then asks two questions: make PBCalc the default browser, and start PBCalc on the calculator screen. The answers are written to
; "$INSTDIR\install-choices.json" and applied by the program at its first start (electron/installChoices.js).
; The password is NOT in this file: only a salted PBKDF2-SHA256 hash (100000 rounds) that PowerShell recomputes from what was typed.
; (To change the password: node scripts/make-install-hash.js "<new password>" and paste its two lines below.)
; A silent install (/S) skips every page, so it must prove the password too: PBCalc Setup.exe /S /PW=<password>.
!define PBC_SALT "pbcalc-setup-v1:Au--pEw5d1gX"
!define PBC_HASH "e5288c4b2b7bac9601752e42743bd2f74b99bebda2af0e38ec92d9062f213fd9"

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !include nsDialogs.nsh
    !include LogicLib.nsh
    Var PbcPwBox
    Var PbcPwTries
    Var PbcOptDefault
    Var PbcOptCalc
    Var PbcOptDefaultState
    Var PbcOptCalcState

    ; in: $0 = typed password   out: $0 = "1" when it is the installation password, "0" otherwise
    Function PbcCheckPassword
      System::Call 'Kernel32::SetEnvironmentVariable(t "PBC_PW", t r0)i.r1'
      nsExec::ExecToStack `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$b=[Text.Encoding]::UTF8.GetBytes($$env:PBC_PW); $$k=New-Object Security.Cryptography.Rfc2898DeriveBytes($$b,[Text.Encoding]::UTF8.GetBytes('${PBC_SALT}'),100000,[Security.Cryptography.HashAlgorithmName]::SHA256); if ((($$k.GetBytes(32)|ForEach-Object{$$_.ToString('x2')}) -join '') -eq '${PBC_HASH}') {'PBC_OK'} else {'PBC_NO'}"`
      Pop $1
      Pop $2
      System::Call 'Kernel32::SetEnvironmentVariable(t "PBC_PW", n)i.r1'
      ; only the printed word counts: the exit code reaches the installer as 1 even for the right password (measured), so it is not used
      StrCpy $0 "0"
      StrCpy $3 $2 6
      ${If} $3 == "PBC_OK"
        StrCpy $0 "1"
      ${EndIf}
    FunctionEnd

    Function PbcPasswordPage
      ; an UPDATE (the program's own updater starts the installer with --updated) never asks for the password: it is already installed
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "Installation password" "Enter the password to install PBCalc."
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateLabel} 0 0 100% 24u "This installation is protected. Type the installation password to continue."
      Pop $0
      ${NSD_CreatePassword} 0 32u 100% 12u ""
      Pop $PbcPwBox
      ${NSD_SetFocus} $PbcPwBox
      nsDialogs::Show
    FunctionEnd

    Function PbcPasswordLeave
      ${NSD_GetText} $PbcPwBox $0
      Call PbcCheckPassword
      ${If} $0 == "1"
        Return
      ${EndIf}
      IntOp $PbcPwTries $PbcPwTries + 1
      ${If} $PbcPwTries >= 3
        MessageBox MB_OK|MB_ICONSTOP "Wrong password three times. The installation is cancelled and nothing was installed."
        Quit
      ${EndIf}
      IntOp $0 3 - $PbcPwTries
      MessageBox MB_OK|MB_ICONEXCLAMATION "Wrong password. $0 attempt(s) left."
      Abort
    FunctionEnd

    Function PbcOptionsPage
      ; an update keeps what the user chose at the first install (settings.json / the Default apps entries stay), so it asks nothing
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "Choose your setup" "Two quick questions."
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateCheckbox} 0 8u 100% 12u "Make PBCalc my default browser"
      Pop $PbcOptDefault
      ${NSD_CreateLabel} 12u 22u 95% 20u "Windows opens its Default apps page when PBCalc first starts, so you can pick it there."
      Pop $0
      ${NSD_CreateCheckbox} 0 52u 100% 12u "Start PBCalc on the calculator screen"
      Pop $PbcOptCalc
      ${NSD_CreateLabel} 12u 66u 95% 20u "PBCalc then opens as a calculator; the browser opens from it when you press + five times."
      Pop $0
      ${If} $PbcOptDefaultState == ${BST_CHECKED}
        ${NSD_Check} $PbcOptDefault
      ${EndIf}
      ${If} $PbcOptCalcState == ${BST_CHECKED}
        ${NSD_Check} $PbcOptCalc
      ${EndIf}
      nsDialogs::Show
    FunctionEnd

    Function PbcOptionsLeave
      ${NSD_GetState} $PbcOptDefault $PbcOptDefaultState
      ${NSD_GetState} $PbcOptCalc $PbcOptCalcState
      ; the owner's rule: at least one of the two must be ticked, otherwise the installation does not move on
      ${If} $PbcOptDefaultState != ${BST_CHECKED}
      ${AndIf} $PbcOptCalcState != ${BST_CHECKED}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Please tick at least one option to continue the installation."
        Abort
      ${EndIf}
    FunctionEnd
  !endif
!macroend

!macro customPageAfterChangeDir
  Page custom PbcPasswordPage PbcPasswordLeave
  Page custom PbcOptionsPage PbcOptionsLeave
!macroend

; silent installs show no page: they must give /PW=<password> or they stop here
!macro customInit
  ${IfNot} ${Silent}
    Goto pbcalc_init_ok
  ${EndIf}
  ; a silent UPDATE of a copy that is really installed here needs no password (the in-app updater runs the installer this way)
  ${If} ${isUpdated}
  ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Goto pbcalc_init_ok
  ${EndIf}
  ${GetParameters} $R0
  ${GetOptions} $R0 "/PW=" $R1
  StrCpy $0 $R1
  Call PbcCheckPassword
  ${If} $0 != "1"
    Abort
  ${EndIf}
  pbcalc_init_ok:
!macroend

!macro customInstall
  ; the two answers, for the program's first start (JSON, written once; a silent install and an UPDATE write none, so an update never
  ; changes what the user chose: calculator start lives on in settings.json, the Default apps entries stay)
  ${IfNot} ${isUpdated}
  ${AndIfNot} ${Silent}
    StrCpy $R0 "false"
    StrCpy $R1 "false"
    ${If} $PbcOptDefaultState == ${BST_CHECKED}
      StrCpy $R0 "true"
    ${EndIf}
    ${If} $PbcOptCalcState == ${BST_CHECKED}
      StrCpy $R1 "true"
    ${EndIf}
    FileOpen $R2 "$INSTDIR\install-choices.json" w
    FileWrite $R2 '{"defaultBrowser":$R0,"calculatorStart":$R1}'
    FileClose $R2
  ${EndIf}
!macroend

!macro customUnInstall
  ; An UPDATE runs the OLD version's uninstaller first (silently, with --updated). It must leave Windows alone: removing the Default apps
  ; entries would take away a default browser the user picked. The new version (same folder, same exe path) keeps them, and the program
  ; re-registers itself at its next start if the layout changed.
  ${If} ${isUpdated}
    Goto pbcalc_keep_registration
  ${EndIf}
  ; --- 1. Windows registration -------------------------------------------------------------------------------------------------
  DeleteRegValue HKCU "Software\RegisteredApplications" "PBCalc"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\PBCalc"
  DeleteRegKey HKCU "Software\Classes\PBCalcURL"
  DeleteRegKey HKCU "Software\Classes\PBCalcHTML"
  DeleteRegKey HKCU "Software\Classes\PBCalcPDF"
  DeleteRegKey HKCU "Software\Classes\PBCalcIMG"
  DeleteRegKey HKCU "Software\Classes\PBCalcTXT"
  DeleteRegKey HKCU "Software\Classes\PBCalcSVG"
  DeleteRegKey HKCU "Software\Classes\Applications\PBCalc.exe"
  ; When a file type was given to PBCalc through "Opens with > Change", Windows made its own ProgId (e.g. pdf_auto_file) holding
  ; PBCalc's open command, and PBCalc added its icon to it (defaultBrowser.repairOpenWithIcons). Remove every such ProgId (open
  ; command inside this install) and every DefaultIcon that points into this install, so no file type is left pointing at a program
  ; that is gone. (A double dollar is NSIS's way to write one literal dollar.)
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-ChildItem 'HKCU:\Software\Classes' | ForEach-Object { $$p = $$_.PSPath; $$c = Join-Path $$p 'shell\open\command'; $$i = Join-Path $$p 'DefaultIcon'; if ((Test-Path $$c) -and ((Get-Item $$c).GetValue('') -like '*$INSTDIR\PBCalc.exe*')) { Remove-Item $$p -Recurse -Force } elseif (Test-Path $$i) { if ((Get-Item $$i).GetValue('') -like '$INSTDIR\resources\file-icons\*') { Remove-Item $$i -Recurse -Force } } }"`
  Pop $0
  pbcalc_keep_registration:

  ; --- 2. the user's data, only on request -------------------------------------------------------------------------------------
  IfSilent pbcalc_keep_data
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete all of your PBCalc data?$\r$\n$\r$\nYES - remove saved passwords, bookmarks, settings and everything PBCalc stored on this computer.$\r$\nNO - uninstall the program only and keep that data.$\r$\n$\r$\nYour downloaded files are never deleted." IDYES pbcalc_delete_data IDNO pbcalc_keep_data
  pbcalc_delete_data:
    ReadEnvStr $0 LOCALAPPDATA
    ${If} $0 != ""
      RMDir /r "$0\PBCalc"
    ${EndIf}
    ReadEnvStr $0 APPDATA
    ${If} $0 != ""
      RMDir /r "$0\PBCalc"
    ${EndIf}
  pbcalc_keep_data:
!macroend
