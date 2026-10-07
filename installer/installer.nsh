; Extra steps for the NSIS installer (electron-builder: nsis.include in package.json). Source file, NOT build output: keep it.
;
; UNINSTALL does two different things:
;  1. ALWAYS: takes PBCalc out of Windows - the Default apps entries (electron/defaultBrowser.js writes them from the running program)
;     and the "Opens with" entries / file icons PBCalc put on file types - so Windows does not keep listing a browser that is gone.
;  2. ONLY IF THE USER SAYS YES in the question below: deletes PBCalc's data folder (saved passwords, the password for them,
;     bookmarks, settings, cache, cookies, crash reports). Downloaded files are the user's own and are never touched.
; A silent uninstall (/S - which is also how an update replaces the old version) never deletes data and never asks.
!macro customUnInstall
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
