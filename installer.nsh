; Hekpixle installer — extra options for the Windows setup wizard.
; Last wizard page: "Create a desktop shortcut" (checked by default) + "Run Hekpixle".

!ifndef BUILD_UNINSTALLER
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION HekCreateDesktopShortcut

  Function HekCreateDesktopShortcut
    CreateShortCut "$DESKTOP\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\${PRODUCT_FILENAME}.exe" 0
  FunctionEnd
!endif

!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_FILENAME}.lnk"
!macroend
