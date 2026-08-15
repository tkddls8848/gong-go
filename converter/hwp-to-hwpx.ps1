param([Parameter(Mandatory = $true)][string]$InputPath, [Parameter(Mandatory = $true)][string]$OutputPath)

$hwp = $null
try {
  $hwp = New-Object -ComObject HWPFrame.HwpObject
  $null = $hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
  try { $hwp.XHwpWindows.Item(0).Visible = $false } catch {}
  if (-not $hwp.Open($InputPath, "", "forceopen:true")) { throw "HWP 파일을 열지 못했습니다: $InputPath" }
  $ok = $hwp.SaveAs($OutputPath, "HWPX", "")
  if (-not $ok) { throw "HWPX 저장에 실패했습니다: $OutputPath" }
} finally {
  if ($null -ne $hwp) {
    try { $hwp.Clear(1) } catch {}
    try { $hwp.Quit() } catch {}
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($hwp) } catch {}
  }
}
