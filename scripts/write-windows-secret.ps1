param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
$plain=[Console]::In.ReadToEnd()
if(-not $plain){throw 'Empty credential refused'}
$secure=ConvertTo-SecureString $plain -AsPlainText -Force
$plain=$null
& (Join-Path $PSScriptRoot 'save-windows-secret.ps1') -Path $Path -SecureValue $secure
