<#
.SYNOPSIS
    Imports mail from classic Outlook for Windows into OpenArchiver.

.DESCRIPTION
    Uses Outlook COM under the current Windows user. Supports:
    - Backfill: scan selected folders and upload missing messages.
    - Reconcile: scan selected folders on demand, typically from Task Scheduler.
    - Daemon: periodic recent scans plus one daily reconciliation scan.
    - RepairSenders: scan selected folders and repair existing unknown sender metadata.
    - Meeting requests and calendar appointments: imports Outlook meeting items and adds a generated .ics part when Outlook exposes appointment details.

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

    [ValidateSet("Backfill", "Reconcile", "Daemon", "RepairSenders")]
    [string]$Mode = "Daemon",

    [string[]]$Folders = @("Inbox", "Sent Items"),
    $IncludeSubfolders = $true,

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

function ConvertTo-BooleanOption {
    param(
        $Value,
        [Parameter(Mandatory = $true)][string]$Name,
        [bool]$Default = $true
    )

    if ($null -eq $Value) { return $Default }
    if ($Value -is [bool]) { return $Value }

    $text = "$Value".Trim()
    if ($text.StartsWith('$')) {
        $text = $text.Substring(1)
    }

    switch -Regex ($text.ToLowerInvariant()) {
        '^(1|true|t|yes|y|on)$' { return $true }
        '^(0|false|f|no|n|off)$' { return $false }
        default {
            throw "$Name must be true or false. Received: $Value"
        }
    }
}

$IncludeSubfolders = ConvertTo-BooleanOption `
    -Value $IncludeSubfolders `
    -Name "IncludeSubfolders" `
    -Default $true

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
    param([AllowEmptyCollection()][byte[]]$Bytes)

    if ($null -eq $Bytes) { $Bytes = [byte[]]@() }

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($Bytes)
        return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
    } finally {
        $sha.Dispose()
    }
}

function Get-Sha256HexFromString {
    param([AllowEmptyString()][string]$Value)
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

function Get-OutlookMessageClass {
    param($Item)

    try {
        $messageClass = "$($Item.MessageClass)"
        if (-not [string]::IsNullOrWhiteSpace($messageClass)) { return $messageClass }
    } catch {}

    return ""
}

function Test-SupportedOutlookItem {
    param($Item)

    $messageClass = Get-OutlookMessageClass $Item
    return (
        $messageClass.StartsWith("IPM.Note", [System.StringComparison]::OrdinalIgnoreCase) -or
        $messageClass.StartsWith("IPM.Schedule.Meeting", [System.StringComparison]::OrdinalIgnoreCase) -or
        $messageClass.StartsWith("IPM.Appointment", [System.StringComparison]::OrdinalIgnoreCase)
    )
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

    if ($normalized.StartsWith("SMTP:", [System.StringComparison]::OrdinalIgnoreCase)) {
        $normalized = $normalized.Substring(5).Trim()
    }

    if ($normalized -match "<([^<>@\s]+@[^<>\s]+)>") { return $matches[1] }
    if ($normalized -match "(?i)([a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,})") { return $matches[1] }
    if ($normalized -match "@") { return $normalized }
    return $null
}

function Get-MailboxEmailFallback {
    param([string]$FolderPath)

    $email = Normalize-EmailAddress $MailboxEmail
    if ($email) { return $email }

    if (-not [string]::IsNullOrWhiteSpace($FolderPath)) {
        foreach ($segment in ("$FolderPath" -replace "\\", "/").Split("/")) {
            $email = Normalize-EmailAddress $segment
            if ($email) { return $email }
        }
    }

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

    $addressEntryProperties = @(
        "http://schemas.microsoft.com/mapi/proptag/0x39FE001F", # PR_SMTP_ADDRESS
        "http://schemas.microsoft.com/mapi/proptag/0x39FE001E",
        "http://schemas.microsoft.com/mapi/proptag/0x3003001F", # PR_EMAIL_ADDRESS
        "http://schemas.microsoft.com/mapi/proptag/0x3003001E"
    )
    foreach ($propertyName in $addressEntryProperties) {
        try {
            $email = Normalize-EmailAddress "$($AddressEntry.PropertyAccessor.GetProperty($propertyName))"
            if ($email) { return $email }
        } catch {}
    }

    try {
        $email = Normalize-EmailAddress "$($AddressEntry.Address)"
        if ($email) { return $email }
    } catch {}

    return $null
}

function Get-SmtpFromMailItemProperties {
    param($MailItem)

    $mailItemProperties = @(
        "http://schemas.microsoft.com/mapi/proptag/0x5D02001F", # PR_SENT_REPRESENTING_SMTP_ADDRESS
        "http://schemas.microsoft.com/mapi/proptag/0x5D02001E",
        "http://schemas.microsoft.com/mapi/proptag/0x5D01001F", # PR_SENDER_SMTP_ADDRESS
        "http://schemas.microsoft.com/mapi/proptag/0x5D01001E",
        "http://schemas.microsoft.com/mapi/proptag/0x0065001F", # PR_SENT_REPRESENTING_EMAIL_ADDRESS
        "http://schemas.microsoft.com/mapi/proptag/0x0065001E",
        "http://schemas.microsoft.com/mapi/proptag/0x0C1F001F", # PR_SENDER_EMAIL_ADDRESS
        "http://schemas.microsoft.com/mapi/proptag/0x0C1F001E"
    )

    foreach ($propertyName in $mailItemProperties) {
        $email = Normalize-EmailAddress (Get-PropSafe -Item $MailItem -DaslName $propertyName)
        if ($email) { return $email }
    }

    return $null
}

function Get-SenderAddress {
    param(
        $MailItem,
        [string]$FallbackEmail = ""
    )

    try {
        $email = Get-SmtpFromMailItemProperties $MailItem
        if ($email) { return $email }
    } catch {}

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

    try {
        if ($MailItem.SendUsingAccount) {
            $email = Normalize-EmailAddress "$($MailItem.SendUsingAccount.SmtpAddress)"
            if ($email) { return $email }
        }
    } catch {}

    $email = Normalize-EmailAddress $FallbackEmail
    if ($email) { return $email }

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
    param([AllowEmptyCollection()][byte[]]$Bytes)

    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return "" }

    $b64 = [Convert]::ToBase64String($Bytes)
    $matches = [regex]::Matches($b64, ".{1,76}")
    return (($matches | ForEach-Object { $_.Value }) -join "`r`n")
}

function Escape-IcsText {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    return "$Value" `
        -replace "\\", "\\\\" `
        -replace ";", "\;" `
        -replace ",", "\," `
        -replace "(`r`n|`n|`r)", "\n"
}

function Format-MessageHeaderValue {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
    return ("$Value" -replace "(`r`n|`n|`r)", " ").Trim()
}

function Format-IcsUtcDate {
    param($Value)

    try {
        $date = [DateTime]$Value
        if ($date.Year -le 1900 -or $date.Year -ge 3000) { return "" }
        return $date.ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
    } catch {
        return ""
    }
}

function Get-CalendarMethod {
    param([string]$MessageClass)

    if ($MessageClass.StartsWith("IPM.Appointment", [System.StringComparison]::OrdinalIgnoreCase)) {
        return "PUBLISH"
    }
    if ($MessageClass -match "(?i)\.Canceled|\.Cancel") { return "CANCEL" }
    if ($MessageClass -match "(?i)\.Resp\.") { return "REPLY" }
    return "REQUEST"
}

function Get-AssociatedAppointmentSafe {
    param($Item)

    try {
        if ((Get-OutlookMessageClass $Item).StartsWith("IPM.Schedule.Meeting", [System.StringComparison]::OrdinalIgnoreCase)) {
            return $Item.GetAssociatedAppointment($false)
        }
        if ((Get-OutlookMessageClass $Item).StartsWith("IPM.Appointment", [System.StringComparison]::OrdinalIgnoreCase)) {
            return $Item
        }
    } catch {}

    return $null
}

function Get-CalendarInviteIcs {
    param(
        [Parameter(Mandatory = $true)]$Item,
        [Parameter(Mandatory = $true)][string]$MessageClass
    )

    if (
        -not $MessageClass.StartsWith("IPM.Schedule.Meeting", [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $MessageClass.StartsWith("IPM.Appointment", [System.StringComparison]::OrdinalIgnoreCase)
    ) {
        return $null
    }

    $appointment = Get-AssociatedAppointmentSafe $Item
    if (-not $appointment) { return $null }

    $start = Format-IcsUtcDate $appointment.Start
    $end = Format-IcsUtcDate $appointment.End
    if ([string]::IsNullOrWhiteSpace($start) -or [string]::IsNullOrWhiteSpace($end)) {
        return $null
    }

    $method = Get-CalendarMethod $MessageClass
    $uid = ""
    try { $uid = "$($appointment.GlobalAppointmentID)" } catch {}
    if ([string]::IsNullOrWhiteSpace($uid)) {
        try { $uid = "$($appointment.EntryID)" } catch {}
    }
    if ([string]::IsNullOrWhiteSpace($uid)) {
        $uid = Get-StableSyntheticMessageId -MailItem $Item
    }
    $uid = ($uid.Trim("<>") -replace "\s+", "")

    $summary = ""
    $location = ""
    $organizerName = ""
    $organizerEmail = ""
    try { $summary = "$($appointment.Subject)" } catch {}
    if ([string]::IsNullOrWhiteSpace($summary)) {
        try { $summary = "$($Item.Subject)" } catch {}
    }
    try { $location = "$($appointment.Location)" } catch {}
    try { $organizerName = "$($appointment.Organizer)" } catch {}
    try { $organizerEmail = Get-SenderAddress $Item } catch {}

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("BEGIN:VCALENDAR")
    $lines.Add("VERSION:2.0")
    $lines.Add("PRODID:-//OpenArchiver//Outlook COM Importer//EN")
    $lines.Add("METHOD:$method")
    $lines.Add("BEGIN:VEVENT")
    $lines.Add("UID:$uid")
    $lines.Add("DTSTAMP:$(Format-IcsUtcDate (Get-Date))")
    $lines.Add("DTSTART:$start")
    $lines.Add("DTEND:$end")
    $lines.Add("SUMMARY:$(Escape-IcsText $summary)")

    if (-not [string]::IsNullOrWhiteSpace($location)) {
        $lines.Add("LOCATION:$(Escape-IcsText $location)")
    }

    if ($method -eq "CANCEL") {
        $lines.Add("STATUS:CANCELLED")
    }

    if (-not [string]::IsNullOrWhiteSpace($organizerEmail)) {
        $organizer = "ORGANIZER"
        if (-not [string]::IsNullOrWhiteSpace($organizerName)) {
            $organizer += ";CN=$(Escape-IcsText $organizerName)"
        }
        $organizer += ":MAILTO:$organizerEmail"
        $lines.Add($organizer)
    }

    try {
        foreach ($recipient in $appointment.Recipients) {
            $email = Get-RecipientAddress $recipient
            if ([string]::IsNullOrWhiteSpace($email)) { continue }

            $name = ""
            try { $name = "$($recipient.Name)" } catch {}
            $role = "REQ-PARTICIPANT"
            try {
                if ([int]$recipient.Type -eq 2) { $role = "OPT-PARTICIPANT" }
            } catch {}

            $attendee = "ATTENDEE;ROLE=$role"
            if (-not [string]::IsNullOrWhiteSpace($name)) {
                $attendee += ";CN=$(Escape-IcsText $name)"
            }
            $attendee += ":MAILTO:$email"
            $lines.Add($attendee)
        }
    } catch {}

    $lines.Add("END:VEVENT")
    $lines.Add("END:VCALENDAR")

    return [ordered]@{
        Method = $method
        FileName = "invite.ics"
        Content = (($lines.ToArray()) -join "`r`n") + "`r`n"
    }
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
    $messageClass = Get-OutlookMessageClass $MailItem
    if ($messageClass.StartsWith("IPM.Appointment", [System.StringComparison]::OrdinalIgnoreCase)) {
        return "calendar"
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

    $messageClass = Get-OutlookMessageClass $MailItem
    $fieldOrder = @("ReceivedTime", "SentOn", "CreationTime", "LastModificationTime")
    if ($Direction -eq "sent" -or $Direction -eq "outgoing") {
        $fieldOrder = @("SentOn", "ReceivedTime", "CreationTime", "LastModificationTime")
    }
    if ($messageClass.StartsWith("IPM.Appointment", [System.StringComparison]::OrdinalIgnoreCase)) {
        $fieldOrder = @("Start", "End", "CreationTime", "LastModificationTime")
    }
    if ($messageClass.StartsWith("IPM.Schedule.Meeting", [System.StringComparison]::OrdinalIgnoreCase)) {
        $fieldOrder = @("ReceivedTime", "SentOn", "CreationTime", "LastModificationTime")
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
        [string]$Direction = "received",
        [string]$FolderPath = ""
    )

    $messageClass = Get-OutlookMessageClass $MailItem
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
    if ([string]::IsNullOrWhiteSpace($senderName) -and $messageClass.StartsWith("IPM.Appointment", [System.StringComparison]::OrdinalIgnoreCase)) {
        try { $senderName = "$($MailItem.Organizer)" } catch {}
    }
    $fallbackSenderEmail = ""
    if ($Direction -eq "sent" -or $Direction -eq "outgoing") {
        $fallbackSenderEmail = Get-MailboxEmailFallback -FolderPath $FolderPath
    }
    if ($Direction -eq "calendar") {
        $fallbackSenderEmail = Get-MailboxEmailFallback -FolderPath $FolderPath
    }
    $senderEmail = Get-SenderAddress -MailItem $MailItem -FallbackEmail $fallbackSenderEmail
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
    if (-not [string]::IsNullOrWhiteSpace($messageClass)) {
        $headers.Add("X-OpenArchiver-Outlook-Message-Class: $messageClass")
    }
    $outlookEntryId = ""
    $storeId = ""
    $globalAppointmentId = ""
    try { $outlookEntryId = Format-MessageHeaderValue "$($MailItem.EntryID)" } catch {}
    try { $storeId = Format-MessageHeaderValue "$($MailItem.Parent.StoreID)" } catch {}
    if ([string]::IsNullOrWhiteSpace($storeId)) {
        try { $storeId = Format-MessageHeaderValue "$($MailItem.Parent.Store.StoreID)" } catch {}
    }
    try {
        $appointmentForHeaders = Get-AssociatedAppointmentSafe $MailItem
        if ($appointmentForHeaders) {
            $globalAppointmentId = Format-MessageHeaderValue "$($appointmentForHeaders.GlobalAppointmentID)"
        }
    } catch {}
    if (-not [string]::IsNullOrWhiteSpace($outlookEntryId)) {
        $headers.Add("X-OpenArchiver-Outlook-Entry-Id: $outlookEntryId")
    }
    if (-not [string]::IsNullOrWhiteSpace($storeId)) {
        $headers.Add("X-OpenArchiver-Outlook-Store-Id: $storeId")
    }
    if (-not [string]::IsNullOrWhiteSpace($globalAppointmentId)) {
        $headers.Add("X-OpenArchiver-Outlook-Global-Appointment-Id: $globalAppointmentId")
    }

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
    $calendarPart = Get-CalendarInviteIcs -Item $MailItem -MessageClass $messageClass

    if ($attachmentCount -le 0 -and -not $calendarPart) {
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

    if ($calendarPart) {
        $calendarBytes = [System.Text.Encoding]::UTF8.GetBytes($calendarPart["Content"])
        $calendarFileName = $calendarPart["FileName"]
        $calendarMethod = $calendarPart["Method"]

        $parts.Add("--$boundary")
        $parts.Add("Content-Type: text/calendar; charset=utf-8; method=$calendarMethod; name=`"$calendarFileName`"")
        $parts.Add("Content-Disposition: attachment; filename=`"$calendarFileName`"")
        $parts.Add("Content-Transfer-Encoding: base64")
        $parts.Add("")
        $parts.Add((ConvertTo-Base64Lines $calendarBytes))
    }

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
        "calendar" { return $script:OutlookNs.GetDefaultFolder(9) }
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
            $emlBytes = New-GeneratedEmlBytes -MailItem $entry.item -ClientId $clientId -Direction $direction -FolderPath $entry.folderPath
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
                tags = @(
                    "outlook-com",
                    "outlook-direction:$direction",
                    "outlook-message-class:$($entry.messageClass)"
                )
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

function Submit-SenderRepairBatch {
    param(
        [Parameter(Mandatory = $true)][object[]]$Pending
    )

    if ($Pending.Count -eq 0) { return @{ repaired = 0; skipped = 0; notFound = 0; failed = 0 } }

    $repairMessages = @()
    foreach ($entry in $Pending) {
        try {
            $fingerprint = $entry.fingerprint
            $direction = "$($entry.direction)"
            $fallbackSenderEmail = ""
            if ($direction -eq "sent" -or $direction -eq "outgoing") {
                $fallbackSenderEmail = Get-MailboxEmailFallback -FolderPath $entry.folderPath
            }

            $senderName = ""
            try { $senderName = "$($entry.item.SenderName)" } catch {}
            $senderEmail = Get-SenderAddress -MailItem $entry.item -FallbackEmail $fallbackSenderEmail

            $repairMessages += [ordered]@{
                clientId = $fingerprint.clientId
                providerMessageId = $fingerprint.providerMessageId
                internetMessageId = $fingerprint.internetMessageId
                outlookEntryId = $fingerprint.outlookEntryId
                storeId = $fingerprint.storeId
                senderName = $senderName
                senderEmail = $senderEmail
                mailboxEmail = $MailboxEmail
                folderPath = $entry.folderPath
                tags = @("outlook-com", "outlook-direction:$direction", "outlook-sender-repair")
            }
        } catch {
            Write-Log "Failed to prepare sender repair message: $($_.Exception.Message)" "ERROR"
        }
    }

    if ($repairMessages.Count -eq 0) { return @{ repaired = 0; skipped = 0; notFound = 0; failed = $Pending.Count } }

    $response = Invoke-OpenArchiverJson -Path "/emails/repair-senders" -Body @{ messages = $repairMessages }
    Write-Log "Sender repair batch: repaired=$($response.repaired) skipped=$($response.skipped) notFound=$($response.notFound) failed=$($response.failed)"

    return @{
        repaired = [int]$response.repaired
        skipped = [int]$response.skipped
        notFound = [int]$response.notFound
        failed = [int]$response.failed
    }
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
                try { $items.Sort("[ReceivedTime]", $true) } catch {
                    try { $items.Sort("[Start]", $true) } catch {}
                }
            } catch {
                Write-Log "Unable to read folder items for ${folderPath}: $($_.Exception.Message)" "WARN"
                continue
            }

            foreach ($item in $items) {
                if ($MaxMessages -gt 0 -and $totalSeen -ge $MaxMessages) { break }

                try {
                    $messageClass = Get-OutlookMessageClass $item
                    if (-not (Test-SupportedOutlookItem $item)) { continue }
                    $direction = Get-MailDirection -FolderPath $folderPath -MailItem $item
                    if (-not (Test-MailItemInWindow -MailItem $item -DaysBack $DaysBack -Direction $direction)) { continue }

                    $fingerprint = Get-MailFingerprint -MailItem $item -Direction $direction
                    $pending += [ordered]@{
                        item = $item
                        fingerprint = $fingerprint
                        folderPath = $folderPath
                        direction = $direction
                        messageClass = $messageClass
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

function Invoke-SenderRepairScan {
    param(
        [Parameter(Mandatory = $true)][int]$DaysBack,
        [Parameter(Mandatory = $true)][string]$ScanName
    )

    if (-not (Ensure-OutlookCom)) { return }

    Write-Log "Starting $ScanName sender repair scan. daysBack=$DaysBack folders=$($Folders -join ', ')"
    $totalSeen = 0
    $totalRepaired = 0
    $totalSkipped = 0
    $totalNotFound = 0
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
            Write-Log "Scanning folder for sender repair: $folderPath"

            $items = $null
            try {
                $items = $scanFolder.Items
                try { $items.Sort("[ReceivedTime]", $true) } catch {
                    try { $items.Sort("[Start]", $true) } catch {}
                }
            } catch {
                Write-Log "Unable to read folder items for ${folderPath}: $($_.Exception.Message)" "WARN"
                continue
            }

            foreach ($item in $items) {
                if ($MaxMessages -gt 0 -and $totalSeen -ge $MaxMessages) { break }

                try {
                    $messageClass = Get-OutlookMessageClass $item
                    if (-not (Test-SupportedOutlookItem $item)) { continue }
                    $direction = Get-MailDirection -FolderPath $folderPath -MailItem $item
                    if (-not (Test-MailItemInWindow -MailItem $item -DaysBack $DaysBack -Direction $direction)) { continue }

                    $fingerprint = Get-MailFingerprint -MailItem $item -Direction $direction
                    $pending += [ordered]@{
                        item = $item
                        fingerprint = $fingerprint
                        folderPath = $folderPath
                        direction = $direction
                        messageClass = $messageClass
                    }
                    $totalSeen += 1

                    if ($pending.Count -ge $CheckBatchSize) {
                        $result = Submit-SenderRepairBatch -Pending $pending
                        $totalRepaired += [int]$result.repaired
                        $totalSkipped += [int]$result.skipped
                        $totalNotFound += [int]$result.notFound
                        $totalFailed += [int]$result.failed
                        $pending = @()
                    }
                } catch {
                    $totalFailed += 1
                    Write-Log "Skipping sender repair message due to error: $($_.Exception.Message)" "WARN"
                }
            }
        }
    }

    if ($pending.Count -gt 0) {
        $result = Submit-SenderRepairBatch -Pending $pending
        $totalRepaired += [int]$result.repaired
        $totalSkipped += [int]$result.skipped
        $totalNotFound += [int]$result.notFound
        $totalFailed += [int]$result.failed
    }

    Write-Log "$ScanName sender repair scan complete. seen=$totalSeen repaired=$totalRepaired skipped=$totalSkipped notFound=$totalNotFound failed=$totalFailed"
}

Write-Log "OpenArchiver Outlook COM importer starting. mode=$Mode url=$script:BaseUrl source=$SourceId"

try {
    switch ($Mode) {
        "RepairSenders" {
            Invoke-SenderRepairScan -DaysBack $BackfillDaysBack -ScanName "sender-repair"
        }
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
