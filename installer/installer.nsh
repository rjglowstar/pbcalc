; Extra steps for the NSIS installer (electron-builder: nsis.include in package.json). Source file, NOT build output: keep it.
; PBCalc registers itself in Windows' Default apps from the program (electron/defaultBrowser.js, current user, no admin) the first
; time the installed copy runs. UNINSTALLING must take those entries away again, or Windows keeps listing a browser that is gone.
!macro customUnInstall
  DeleteRegValue HKCU "Software\RegisteredApplications" "PBCalc"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\PBCalc"
  DeleteRegKey HKCU "Software\Classes\PBCalcURL"
  DeleteRegKey HKCU "Software\Classes\PBCalcHTML"
  DeleteRegKey HKCU "Software\Classes\PBCalcPDF"
  DeleteRegKey HKCU "Software\Classes\PBCalcIMG"
  DeleteRegKey HKCU "Software\Classes\PBCalcTXT"
  DeleteRegKey HKCU "Software\Classes\PBCalcSVG"
!macroend
