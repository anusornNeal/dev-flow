param(
  [Parameter(Mandatory = $true)]
  [string]$TriggerScript,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ForwardedArgs
)

& $TriggerScript @ForwardedArgs
exit $LASTEXITCODE
