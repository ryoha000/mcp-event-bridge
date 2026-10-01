param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
$encrypted=(Get-Content -Raw -LiteralPath $Path).Trim()
$secure=ConvertTo-SecureString $encrypted
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
