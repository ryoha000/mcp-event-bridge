param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][Security.SecureString]$SecureValue)
$ErrorActionPreference='Stop'
$target=[IO.Path]::GetFullPath($Path)
$root=Split-Path -Parent $target
New-Item -ItemType Directory -Path $root -Force | Out-Null
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
$directory=[IO.DirectoryInfo]::new($root)
$acl=[IO.FileSystemAclExtensions]::GetAccessControl($directory,[Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true,$false)
foreach($rule in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))){$acl.RemoveAccessRuleSpecific($rule)}
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
[IO.FileSystemAclExtensions]::SetAccessControl($directory,$acl)
$fileAcl=[Security.AccessControl.FileSecurity]::new()
$fileAcl.SetAccessRuleProtection($true,$false)
$fileAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user,'FullControl','Allow'))
if(Test-Path -LiteralPath $target){[IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($target),$fileAcl)}
$temporary=Join-Path $root ([IO.Path]::GetRandomFileName())
try {
  $bytes=[Text.Encoding]::ASCII.GetBytes((ConvertFrom-SecureString $SecureValue))
  $stream=[IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
  [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($temporary),$fileAcl)
  if(Test-Path -LiteralPath $target){[IO.File]::Replace($temporary,$target,[System.Management.Automation.Language.NullString]::Value)}else{[IO.File]::Move($temporary,$target)}
} finally {if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force}}
