; Хуки установщика (tauri.conf.json → bundle.windows.nsis.installerHooks).
; Название продукта для пользователя — NoxVC, а productName остаётся «Relay»: от него зависят папка установки,
; ключи реестра и автообновление (иначе обновление поставило бы второе приложение рядом). Поэтому после установки:
; ярлык «Relay» → «NoxVC» (тот же AppUserModelID — уведомления подписаны NoxVC), запись в «Приложениях» — NoxVC.

!macro NSIS_HOOK_POSTINSTALL
  Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  CreateShortcut "$SMPROGRAMS\NoxVC.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\NoxVC.lnk"
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\NoxVC.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\NoxVC.lnk"
  ${EndIf}
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "NoxVC"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; при обновлении ярлыки остаются (их пересоздаст новая версия), при удалении — убираем
  ${If} $UpdateMode <> 1
    Delete "$SMPROGRAMS\NoxVC.lnk"
    Delete "$DESKTOP\NoxVC.lnk"
  ${EndIf}
!macroend
