; Added to the NSIS installer by electron-builder (nsis.include in electron-builder.yml).

; A one-click install would go in <user programs>\polyscope, named after the package, where another app called
; Polyscope could go too: a first install goes in <user programs>\Ducttapeworks\Polyscope instead. An update, or
; an install given a folder with /D=, keeps the folder it has.
!macro customInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  !insertmacro GetDParameter $R0
  ${If} $0 == ""
  ${AndIf} $R0 == ""
    ${GetParent} $INSTDIR $1
    StrCpy $INSTDIR "$1\Ducttapeworks\Polyscope"
  ${EndIf}
!macroend
