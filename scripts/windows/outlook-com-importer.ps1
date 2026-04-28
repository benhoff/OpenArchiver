<#
.SYNOPSIS
    Imports mail from classic Outlook for Windows into OpenArchiver.

.DESCRIPTION
    Uses Outlook COM under the current Windows user. Supports:
    - Backfill: scan selected folders and upload missing messages.
    - Reconcile: scan selected folders on demand, typically from Task Scheduler.
    - Daemon: periodic recent scans plus one daily reconciliation scan.

    Requires classic Outlook for Windows. New Outlook does not expose the COM object model.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OpenArchiverUrl,

    [Parameter(Mandatory = $true)]
    [string]$SourceId,

    [Parameter(Mandatory = $true)]
    [string]$ApiKey,

    [string]$ApiBasePath = "/v1",

    [ValidateSet("Backfill", "Reconcile", "Daemon")]
    [string]$Mode = "Daemon",

    [string[]]$Folders = @("Inbox", "Sent Items"),
    [bool]$IncludeSubfolders = $true,

    # 0 means all available messages. Use with care on large mailboxes.
    [int]$BackfillDaysBack = 0,
    [int]$ReconcileDaysBack = 30,
    [int]$RecentDaysBack = 3,

    [int]$PollSeconds = 300,
    [int]$DailyReconcileHour = 2,
    [int]$CheckBatchSize = 500,
    [int]$UploadBatchSize = 20,
    [int]$MaxMessages = 0,

    [string]$MailboxEmail = "",
    [string]$LogPath = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $logDir = Join-Path $env:LOCALAPPDATA "OpenArchiver"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $LogPath = Join-Path $logDir "outlook-com-importer.log"
}

$script:OutlookApp = $null
$script:OutlookNs = $null
$script:BaseUrl = $OpenArchiverUrl.TrimEnd("/")
$script:ApiBasePath = "/" + $ApiBasePath.Trim("/")

function Write-Log {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR", "DEBUG")][string]$Level = "INFO"
    )

    $line = "{0} [{1}] {2}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff"), $Level, $Message
    try { Add-Content -Path $LogPath -Value $line } catch {}
    Write-Host $line
}

function Reset-OutlookCom {
    if ($script:OutlookNs) {
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($script:OutlookNs) } catch {}
        $script:OutlookNs = $null
    }
    if ($script:OutlookApp) {
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($script:OutlookApp) } catch {}
        $script:OutlookApp = $null
    }
    try {
        [System.GC]::Collect()
        [System.GC]::WaitForPendingFinalizers()
    } catch {}
}

function Ensure-OutlookCom {
    if ($script:OutlookApp -and $script:OutlookNs) { return $true }
    try {
        $script:OutlookApp = New-Object -ComObject Outlook.Application
        $script:OutlookNs = $script:OutlookApp.GetNamespace("MAPI")
        Write-Log "Outlook COM initialized."
        return $true
    } catch {
        Write-Log "Failed to initialize Outlook COM: $($_.Exception.Message)" "ERROR"
        Reset-OutlookCom
        return $false
    }
}

function Invoke-OpenArchiverJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Body
    )

    $url = "{0}{1}/ingestion-sources/{2}{3}" -f $script:BaseUrl, $script:ApiBasePath, $SourceId, $Path
    $headers = @{ "x-api-key" = $ApiKey }
    $json = $Body | ConvertTo-Json -Depth 20 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)

    return Invoke-RestMethod `
        -Uri $url `
        -Method Post `
        -Headers $headers `
        -ContentType "application/json; charset=utf-8" `
        -Body $bytes
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($Bytes)
        return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
    } finally {
        $sha.Dispose()
    }
}

function Get-Sha256HexFromString {
    param([Parameter(Mandatory = $true)][string]$Value)
    return Get-Sha256Hex -Bytes ([System.Text.Encoding]::UTF8.GetBytes($Value))
}

function Get-PropSafe {
    param(
        [Parameter(Mandatory = $true)]$Item,
        [Parameter(Mandatory = $true)][string]$DaslName
    )
    try {
        $value = $Item.PropertyAccessor.GetProperty($DaslName)
        if ($null -eq $value) { return $null }
        $text = "$value".Trim()
        if ([string]::IsNullOrWhiteSpace($text)) { return $null }
        return $text
    } catch {
        return $null
    }
}

function Get-InternetMessageId {
    param($MailItem)

    $value = Get-PropSafe -Item $MailItem -DaslName "http://schemas.microsoft.com/mapi/proptag/0x1035001F"
    if ($value) { return $value }
    $value = Get-PropSafe -Item $MailItem -DaslName "http://schemas.microsoft.com/mapi/proptag/0x1035001E"
    if ($value) { return $value }
    return $null
}

function Normalize-EmailAddress {
    param([string]$Email)
    if ([string]::IsNullOrWhiteSpace($Email)) { return $null }
    $normalized = "$Email".Trim()
    if ($normalized -match "@") { return $normalized }
    return $null
}

function Get-SmtpFromAddressEntry {
    param($AddressEntry)
    if (-not $AddressEntry) { return $null }

    try {
        $exchangeUser = $AddressEntry.GetExchangeUser()
        if ($exchangeUser) {
            $email = Normalize-EmailAddress "$($exchangeUser.PrimarySmtpAddress)"
            if ($email) { return $email }
        }
    } catch {}

    try {
        $exchangeDl = $AddressEntry.GetExchangeDistributionList()
        if ($exchangeDl) {
            $email = Normalize-EmailAddress "$($exchangeDl.PrimarySmtpAddress)"
            if ($email) { return $email }
        }
    } catch {}

    try {
        $email = Normalize-EmailAddress "$($AddressEntry.Address)"
        if ($email) { return $email }
    } catch {}

    return $null
}

function Get-SenderAddress {
    param($MailItem)

    try {
        $sender = $MailItem.Sender
        if ($sender -and $sender.AddressEntry) {
            $email = Get-SmtpFromAddressEntry $sender.AddressEntry
            if ($email) { return $email }
        }
    } catch {}

    try {
        $email = Normalize-EmailAddress "$($MailItem.SenderEmailAddress)"
        if ($email) { return $email }
    } catch {}

    return "unknown@outlook.local"
}

function Get-RecipientAddress {
    param($Recipient)

    try {
        $email = Normalize-EmailAddress "$($Recipient.Address)"
        if ($email) { return $email }
    } catch {}

    try { [void]$Recipient.Resolve() } catch {}

    try {
        if ($Recipient.AddressEntry) {
            $email = Get-SmtpFromAddressEntry $Recipient.AddressEntry
            if ($email) { return $email }
        }
    } catch {}

    return $null
}

function Encode-MimeHeader {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    $clean = ($Value -replace "[`r`n]+", " ").Trim()
    $ascii = $true
    foreach ($ch in $clean.ToCharArray()) {
        if ([int][char]$ch -gt 127) {
            $ascii = $false
            break
        }
    }
    if ($ascii) { return $clean }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($clean)
    return "=?UTF-8?B?$([Convert]::ToBase64String($bytes))?="
}

function Format-Mailbox {
    param(
        [string]$Name,
        [string]$Email
    )

    if ([string]::IsNullOrWhiteSpace($Email)) { return Encode-MimeHeader $Name }
    if ([string]::IsNullOrWhiteSpace($Name)) { return $Email }
    return "{0} <{1}>" -f (Encode-MimeHeader $Name), $Email
}

function Get-RecipientHeader {
    param(
        $MailItem,
        [int]$RecipientType
    )

    $values = @()
    try {
        foreach ($recipient in $MailItem.Recipients) {
            if ([int]$recipient.Type -ne $RecipientType) { continue }
            $email = Get-RecipientAddress $recipient
            $name = ""
            try { $name = "$($recipient.Name)" } catch {}
            $formatted = Format-Mailbox -Name $name -Email $email
            if (-not [string]::IsNullOrWhiteSpace($formatted)) {
                $values += $formatted
            }
        }
    } catch {}

    return ($values -join ", ")
}

function ConvertTo-Base64Lines {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $b64 = [Convert]::ToBase64String($Bytes)
    $matches = [regex]::Matches($b64, ".{1,76}")
    return (($matches | ForEach-Object { $_.Value }) -join "`r`n")
}

function Get-MailDirection {
    param(
        [string]$FolderPath,
        $MailItem
    )

    $path = ""
    if (-not [string]::IsNullOrWhiteSpace($FolderPath)) {
        $path = "$FolderPath".ToLowerInvariant()
    }
    if ($path -match "(^|/)(sent|sent items|sent mail)(/|$)") { return "sent" }
    if ($path -match "(^|/)(outbox|drafts)(/|$)") { return "outgoing" }

    if (-not [string]::IsNullOrWhiteSpace($MailboxEmail)) {
        try {
            $sender = (Get-SenderAddress $MailItem).ToLowerInvariant()
            if ($sender -eq $MailboxEmail.ToLowerInvariant()) { return "sent" }
        } catch {}
    }

    return "received"
}

function Get-MailItemDate {
    param(
        $MailItem,
        [string]$Direction = "received"
    )

    $fieldOrder = @("ReceivedTime", "SentOn", "CreationTime", "LastModificationTime")
    if ($Direction -eq "sent" -or $Direction -eq "outgoing") {
        $fieldOrder = @("SentOn", "ReceivedTime", "CreationTime", "LastModificationTime")
    }

    foreach ($name in $fieldOrder) {
        try {
            $value = $MailItem.$name
            if ($value) {
                $date = [DateTime]$value
                if ($date.Year -gt 1900 -and $date.Year -lt 3000) { return $date }
            }
        } catch {}
    }

    return Get-Date
}

function Get-StableSyntheticMessageId {
    param(
        $MailItem,
        [string]$Direction = "received"
    )

    $subject = ""
    $sender = ""
    $bodyLength = 0
    $htmlLength = 0
    $attachmentCount = 0

    try { $subject = "$($MailItem.Subject)" } catch {}
    try { $sender = Get-SenderAddress $MailItem } catch {}
    try { $bodyLength = "$($MailItem.Body)".Length } catch {}
    try { $htmlLength = "$($MailItem.HTMLBody)".Length } catch {}
    try { $attachmentCount = [int]$MailItem.Attachments.Count } catch {}

    $date = (Get-MailItemDate -MailItem $MailItem -Direction $Direction).ToUniversalTime().ToString("o")
    $seed = "$sender|$date|$subject|$bodyLength|$htmlLength|$attachmentCount"
    return "<outlook-stable-$((Get-Sha256HexFromString $seed))@outlook-com.local>"
}

function Get-AttachmentMimeType {
    param($Attachment)

    try {
        $mime = $Attachment.PropertyAccessor.GetProperty("http://schemas.microsoft.com/mapi/proptag/0x370E001F")
        if (-not [string]::IsNullOrWhiteSpace("$mime")) { return "$mime" }
    } catch {}

    return "application/octet-stream"
}

function New-GeneratedEmlBytes {
    param(
        [Parameter(Mandatory = $true)]$MailItem,
        [Parameter(Mandatory = $true)][string]$ClientId,
        [string]$Direction = "received"
    )

    $messageId = Get-InternetMessageId $MailItem
    if ([string]::IsNullOrWhiteSpace($messageId)) {
        $messageId = Get-StableSyntheticMessageId -MailItem $MailItem -Direction $Direction
    } elseif (-not $messageId.Trim().StartsWith("<")) {
        $messageId = "<$($messageId.Trim())>"
    }

    $subject = ""
    try { $subject = "$($MailItem.Subject)" } catch {}

    $senderName = ""
    try { $senderName = "$($MailItem.SenderName)" } catch {}
    $senderEmail = Get-SenderAddress $MailItem
    $from = Format-Mailbox -Name $senderName -Email $senderEmail

    $to = Get-RecipientHeader -MailItem $MailItem -RecipientType 1
    $cc = Get-RecipientHeader -MailItem $MailItem -RecipientType 2
    $bcc = Get-RecipientHeader -MailItem $MailItem -RecipientType 3

    $date = (Get-MailItemDate -MailItem $MailItem -Direction $Direction).ToUniversalTime().ToString("r")
    $headers = New-Object System.Collections.Generic.List[string]
    $headers.Add("From: $from")
    if (-not [string]::IsNullOrWhiteSpace($to)) { $headers.Add("To: $to") }
    if (-not [string]::IsNullOrWhiteSpace($cc)) { $headers.Add("Cc: $cc") }
    if (-not [string]::IsNullOrWhiteSpace($bcc)) { $headers.Add("Bcc: $bcc") }
    $headers.Add("Subject: $(Encode-MimeHeader $subject)")
    $headers.Add("Date: $date")
    $headers.Add("Message-ID: $messageId")
    $headers.Add("MIME-Version: 1.0")
    $headers.Add("X-OpenArchiver-Source: outlook_com")
    $headers.Add("X-OpenArchiver-Provider-Message-Id: $ClientId")

    $html = ""
    $text = ""
    try { $html = "$($MailItem.HTMLBody)" } catch {}
    try { $text = "$($MailItem.Body)" } catch {}

    $hasHtml = -not [string]::IsNullOrWhiteSpace($html)
    $bodyContentType = "text/plain"
    $bodyText = $text
    if ($hasHtml) {
        $bodyContentType = "text/html"
        $bodyText = $html
    }
    if ([string]::IsNullOrWhiteSpace($bodyText)) { $bodyText = "" }
    $bodyBase64 = ConvertTo-Base64Lines ([System.Text.Encoding]::UTF8.GetBytes($bodyText))

    $attachmentCount = 0
    try { $attachmentCount = [int]$MailItem.Attachments.Count } catch {}

    if ($attachmentCount -le 0) {
        $headers.Add("Content-Type: $bodyContentType; charset=utf-8")
        $headers.Add("Content-Transfer-Encoding: base64")
        $eml = (($headers.ToArray()) -join "`r`n") + "`r`n`r`n" + $bodyBase64 + "`r`n"
        return [System.Text.Encoding]::UTF8.GetBytes($eml)
    }

    $boundary = "oa-mixed-$([guid]::NewGuid().ToString('N'))"
    $headers.Add("Content-Type: multipart/mixed; boundary=`"$boundary`"")

    $parts = New-Object System.Collections.Generic.List[string]
    $parts.Add("--$boundary")
    $parts.Add("Content-Type: $bodyContentType; charset=utf-8")
    $parts.Add("Content-Transfer-Encoding: base64")
    $parts.Add("")
    $parts.Add($bodyBase64)

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("oa-outlook-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

    try {
        for ($i = 1; $i -le $attachmentCount; $i++) {
            $attachment = $MailItem.Attachments.Item($i)
            $fileName = "attachment-$i"
            try {
                if (-not [string]::IsNullOrWhiteSpace("$($attachment.FileName)")) {
                    $fileName = "$($attachment.FileName)"
                }
            } catch {}

            $safeName = ($fileName -replace '[\\/:*?"<>|]', '_')
            $attachmentPath = Join-Path $tmpDir ("$i-$safeName")
            $attachment.SaveAsFile($attachmentPath)
            $attachmentBytes = [System.IO.File]::ReadAllBytes($attachmentPath)
            $mimeType = Get-AttachmentMimeType $attachment
            $encodedName = Encode-MimeHeader $fileName

            $parts.Add("--$boundary")
            $parts.Add("Content-Type: $mimeType; name=`"$encodedName`"")
            $parts.Add("Content-Disposition: attachment; filename=`"$encodedName`"")
            $parts.Add("Content-Transfer-Encoding: base64")
            $parts.Add("")
            $parts.Add((ConvertTo-Base64Lines $attachmentBytes))
        }
    } finally {
        try { Remove-Item -Recurse -Force -Path $tmpDir } catch {}
    }

    $parts.Add("--$boundary--")
    $eml = (($headers.ToArray()) -join "`r`n") + "`r`n`r`n" + (($parts.ToArray()) -join "`r`n") + "`r`n"
    return [System.Text.Encoding]::UTF8.GetBytes($eml)
}

function Get-ProviderMessageId {
    param($MailItem)

    $entryId = ""
    $storeId = ""
    try { $entryId = "$($MailItem.EntryID)" } catch {}
    try { $storeId = "$($MailItem.Parent.StoreID)" } catch {}

    $internetMessageId = Get-InternetMessageId $MailItem
    $seed = "$storeId|$entryId|$internetMessageId"
    return "outlook-com-" + (Get-Sha256HexFromString $seed)
}

function Get-MailFingerprint {
    param(
        $MailItem,
        [string]$Direction = "received"
    )

    $providerMessageId = Get-ProviderMessageId $MailItem
    $internetMessageId = Get-InternetMessageId $MailItem
    if ([string]::IsNullOrWhiteSpace($internetMessageId)) {
        $internetMessageId = Get-StableSyntheticMessageId -MailItem $MailItem -Direction $Direction
    }
    $entryId = ""
    $storeId = ""
    try { $entryId = "$($MailItem.EntryID)" } catch {}
    try { $storeId = "$($MailItem.Parent.StoreID)" } catch {}

    return [ordered]@{
        clientId = $providerMessageId
        providerMessageId = $providerMessageId
        internetMessageId = $internetMessageId
        outlookEntryId = $entryId
        storeId = $storeId
    }
}

function Get-FolderPath {
    param($Folder)
    try {
        $path = "$($Folder.FolderPath)"
        if (-not [string]::IsNullOrWhiteSpace($path)) {
            return ($path -replace "^\\\\", "" -replace "\\", "/")
        }
    } catch {}
    return "Outlook"
}

function Find-FolderRecursive {
    param(
        [Parameter(Mandatory = $true)]$Folder,
        [Parameter(Mandatory = $true)][string]$Name
    )

    try {
        if ("$($Folder.Name)" -eq $Name) { return $Folder }
        foreach ($child in $Folder.Folders) {
            $found = Find-FolderRecursive -Folder $child -Name $Name
            if ($found) { return $found }
        }
    } catch {}
    return $null
}

function Resolve-OutlookFolder {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Ensure-OutlookCom)) { return $null }

    switch ($Name.ToLowerInvariant()) {
        "inbox" { return $script:OutlookNs.GetDefaultFolder(6) }
        "sent" { return $script:OutlookNs.GetDefaultFolder(5) }
        "sent items" { return $script:OutlookNs.GetDefaultFolder(5) }
        "deleted items" { return $script:OutlookNs.GetDefaultFolder(3) }
        "drafts" { return $script:OutlookNs.GetDefaultFolder(16) }
    }

    foreach ($root in $script:OutlookNs.Folders) {
        $found = Find-FolderRecursive -Folder $root -Name $Name
        if ($found) { return $found }
    }

    return $null
}

function Get-FolderAndChildren {
    param([Parameter(Mandatory = $true)]$Folder)

    $foldersToScan = @($Folder)
    if (-not $IncludeSubfolders) { return $foldersToScan }

    try {
        foreach ($child in $Folder.Folders) {
            $foldersToScan += @(Get-FolderAndChildren -Folder $child)
        }
    } catch {}

    return $foldersToScan
}

function Test-MailItemInWindow {
    param(
        $MailItem,
        [int]$DaysBack,
        [string]$Direction = "received"
    )

    if ($DaysBack -le 0) { return $true }
    $cutoff = (Get-Date).AddDays(-1 * $DaysBack)
    return ((Get-MailItemDate -MailItem $MailItem -Direction $Direction) -ge $cutoff)
}

function Submit-PendingBatch {
    param(
        [Parameter(Mandatory = $true)][object[]]$Pending
    )

    if ($Pending.Count -eq 0) { return @{ imported = 0; existing = 0; failed = 0 } }

    $fingerprints = @($Pending | ForEach-Object { $_.fingerprint })
    $checkResponse = Invoke-OpenArchiverJson -Path "/emails/check" -Body @{ messages = $fingerprints }
    $missingIds = @{}
    foreach ($id in @($checkResponse.missing)) {
        $missingIds["$id"] = $true
    }

    $uploadMessages = @()
    $existingCount = $Pending.Count - $missingIds.Count
    $importedCount = 0
    $failedCount = 0

    foreach ($entry in $Pending) {
        $fingerprint = $entry.fingerprint
        $clientId = "$($fingerprint.clientId)"
        if (-not $missingIds.ContainsKey($clientId)) { continue }

        try {
            $direction = "$($entry.direction)"
            $emlBytes = New-GeneratedEmlBytes -MailItem $entry.item -ClientId $clientId -Direction $direction
            $contentHash = Get-Sha256Hex $emlBytes

            $uploadMessages += [ordered]@{
                clientId = $clientId
                providerMessageId = $fingerprint.providerMessageId
                internetMessageId = $fingerprint.internetMessageId
                outlookEntryId = $fingerprint.outlookEntryId
                storeId = $fingerprint.storeId
                contentHashSha256 = $contentHash
                mailboxEmail = $MailboxEmail
                folderPath = $entry.folderPath
                emlBase64 = [Convert]::ToBase64String($emlBytes)
                tags = @("outlook-com", "outlook-direction:$direction")
            }

            if ($uploadMessages.Count -ge $UploadBatchSize) {
                $response = Invoke-OpenArchiverJson -Path "/emails/bulk" -Body @{ messages = $uploadMessages }
                $importedCount += [int]$response.imported
                $existingCount += [int]$response.existing
                $failedCount += [int]$response.failed
                Write-Log "Uploaded batch: imported=$($response.imported) existing=$($response.existing) failed=$($response.failed)"
                $uploadMessages = @()
            }
        } catch {
            $failedCount += 1
            Write-Log "Failed to prepare message ${clientId}: $($_.Exception.Message)" "ERROR"
        }
    }

    if ($uploadMessages.Count -gt 0) {
        $response = Invoke-OpenArchiverJson -Path "/emails/bulk" -Body @{ messages = $uploadMessages }
        $importedCount += [int]$response.imported
        $existingCount += [int]$response.existing
        $failedCount += [int]$response.failed
        Write-Log "Uploaded batch: imported=$($response.imported) existing=$($response.existing) failed=$($response.failed)"
    }

    return @{ imported = $importedCount; existing = $existingCount; failed = $failedCount }
}

function Invoke-MailScan {
    param(
        [Parameter(Mandatory = $true)][int]$DaysBack,
        [Parameter(Mandatory = $true)][string]$ScanName
    )

    if (-not (Ensure-OutlookCom)) { return }

    Write-Log "Starting $ScanName scan. daysBack=$DaysBack folders=$($Folders -join ', ')"
    $totalSeen = 0
    $totalImported = 0
    $totalExisting = 0
    $totalFailed = 0
    $pending = @()

    foreach ($folderName in $Folders) {
        $folder = Resolve-OutlookFolder $folderName
        if (-not $folder) {
            Write-Log "Folder not found: $folderName" "WARN"
            continue
        }

        foreach ($scanFolder in (Get-FolderAndChildren -Folder $folder)) {
            $folderPath = Get-FolderPath $scanFolder
            Write-Log "Scanning folder: $folderPath"

            $items = $null
            try {
                $items = $scanFolder.Items
                try { $items.Sort("[ReceivedTime]", $true) } catch {}
            } catch {
                Write-Log "Unable to read folder items for ${folderPath}: $($_.Exception.Message)" "WARN"
                continue
            }

            foreach ($item in $items) {
                if ($MaxMessages -gt 0 -and $totalSeen -ge $MaxMessages) { break }

                try {
                    $messageClass = "$($item.MessageClass)"
                    if (-not $messageClass.StartsWith("IPM.Note")) { continue }
                    $direction = Get-MailDirection -FolderPath $folderPath -MailItem $item
                    if (-not (Test-MailItemInWindow -MailItem $item -DaysBack $DaysBack -Direction $direction)) { continue }

                    $fingerprint = Get-MailFingerprint -MailItem $item -Direction $direction
                    $pending += [ordered]@{
                        item = $item
                        fingerprint = $fingerprint
                        folderPath = $folderPath
                        direction = $direction
                    }
                    $totalSeen += 1

                    if ($pending.Count -ge $CheckBatchSize) {
                        $result = Submit-PendingBatch -Pending $pending
                        $totalImported += [int]$result.imported
                        $totalExisting += [int]$result.existing
                        $totalFailed += [int]$result.failed
                        $pending = @()
                    }
                } catch {
                    $totalFailed += 1
                    Write-Log "Skipping message due to error: $($_.Exception.Message)" "WARN"
                }
            }
        }
    }

    if ($pending.Count -gt 0) {
        $result = Submit-PendingBatch -Pending $pending
        $totalImported += [int]$result.imported
        $totalExisting += [int]$result.existing
        $totalFailed += [int]$result.failed
    }

    Write-Log "$ScanName scan complete. seen=$totalSeen imported=$totalImported existing=$totalExisting failed=$totalFailed"
}

Write-Log "OpenArchiver Outlook COM importer starting. mode=$Mode url=$script:BaseUrl source=$SourceId"

try {
    switch ($Mode) {
        "Backfill" {
            Invoke-MailScan -DaysBack $BackfillDaysBack -ScanName "backfill"
        }
        "Reconcile" {
            Invoke-MailScan -DaysBack $ReconcileDaysBack -ScanName "reconcile"
        }
        "Daemon" {
            $lastReconcileDate = $null
            while ($true) {
                Invoke-MailScan -DaysBack $RecentDaysBack -ScanName "periodic"

                $now = Get-Date
                if ($now.Hour -ge $DailyReconcileHour) {
                    $today = $now.ToString("yyyy-MM-dd")
                    if ($lastReconcileDate -ne $today) {
                        Invoke-MailScan -DaysBack $ReconcileDaysBack -ScanName "daily-reconcile"
                        $lastReconcileDate = $today
                    }
                }

                Start-Sleep -Seconds $PollSeconds
            }
        }
    }
} finally {
    Reset-OutlookCom
}
