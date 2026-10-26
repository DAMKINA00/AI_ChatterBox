; Never let installation or removal kill an active agent task.
!macro customCheckAppRunning
  StrCpy $R1 0
  chatterbox_wait_for_exit:
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 603
    ${nsProcess::FindProcess} "AIUsageMonitor.exe" $R0
  ${EndIf}
  ${If} $R0 != 603
    ${If} ${isUpdated}
      ${If} $R1 < 180
        Sleep 500
        IntOp $R1 $R1 + 1
        Goto chatterbox_wait_for_exit
      ${EndIf}
    ${EndIf}
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "AI ChatterBox와 AI Usage Monitor를 종료한 후 다시 실행해 주세요. 진행 중인 마스터와 에이전트 작업은 자동으로 종료하지 않습니다."
    ${EndIf}
    SetErrorLevel 1618
    Quit
  ${EndIf}
!macroend
