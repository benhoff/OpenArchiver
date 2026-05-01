<#
.SYNOPSIS
    Exports Outlook calendar items to JSONL for OpenArchiver feasibility testing.

.DESCRIPTION
    This is a standalone probe. It does not call OpenArchiver and does not write to
    the product database. It reads classic Outlook's default Calendar folder through
    COM, expands recurring items in a scan window, and writes one normalized JSON
    object per event occurrence.

    Requires classic Outlook for Windows. New Outlook does not expose the COM object model.
#>

[CmdletBinding()]
param(
    [int]$PastDays = 30,
    [int]$FutureDays = 180,
    [int]$MaxItems = 0,
    [string]$MailboxEmail = "",
    [string]$OutputPath = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $outputDir = Join-Path $env:LOCALAPPDATA "OpenArchiver"
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
    $OutputPath = Join-Path $outputDir "calendar-probe.jsonl"
}

$script:OutlookApp = $null
$script:OutlookNs = $null

function Write-Log {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR")][string]$Level = "INFO"
    )

    Write-Host ("{0} [{1}] {2}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff"), $Level, $Message)
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
        return $true
    } catch {
        Write-Log "Failed to initialize Outlook COM: $($_.Exception.Message)" "ERROR"
        Reset-OutlookCom
        return $false
    }
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
        "http://schemas.microsoft.com/mapi/proptag/0x39FE001F",
        "http://schemas.microsoft.com/mapi/proptag/0x39FE001E",
        "http://schemas.microsoft.com/mapi/proptag/0x3003001F",
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

function ConvertTo-IsoUtc {
    param($Value)

    try {
        $date = [DateTime]$Value
        if ($date.Year -le 1900 -or $date.Year -ge 3000) { return $null }
        return $date.ToUniversalTime().ToString("o")
    } catch {
        return $null
    }
}

function Get-Sha256HexFromString {
    param([AllowEmptyString()][string]$Value)

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($bytes)
        return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
    } finally {
        $sha.Dispose()
    }
}

function Convert-BusyStatus {
    param($Value)

    try {
        switch ([int]$Value) {
            0 { return "free" }
            1 { return "tentative" }
            2 { return "busy" }
            3 { return "out_of_office" }
            4 { return "working_elsewhere" }
            default { return "unknown:$Value" }
        }
    } catch {
        return ""
    }
}

function Convert-ResponseStatus {
    param($Value)

    try {
        switch ([int]$Value) {
            0 { return "none" }
            1 { return "organizer" }
            2 { return "tentative" }
            3 { return "accepted" }
            4 { return "declined" }
            5 { return "not_responded" }
            default { return "unknown:$Value" }
        }
    } catch {
        return ""
    }
}

function Find-OnlineMeetingUrl {
    param([string[]]$Values)

    $text = ($Values | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "`n"
    $patterns = @(
        "https://teams\.microsoft\.com/l/meetup-join/[^\s<>`"')]+",
        "https://[^\s<>`"')]*zoom\.us/j/[^\s<>`"')]+",
        "https://meet\.google\.com/[a-zA-Z0-9-]+",
        "https://[^\s<>`"')]*webex\.com/[^\s<>`"')]+"
    )

    foreach ($pattern in $patterns) {
        $match = [regex]::Match($text, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($match.Success) {
            return $match.Value.TrimEnd(".", ",", ";")
        }
    }

    return ""
}

function Get-CalendarRecipients {
    param($Appointment)

    $required = @()
    $optional = @()

    try {
        foreach ($recipient in $Appointment.Recipients) {
            $email = Get-RecipientAddress $recipient
            if ([string]::IsNullOrWhiteSpace($email)) { continue }

            $name = ""
            try { $name = "$($recipient.Name)" } catch {}
            $entry = [ordered]@{
                name = $name
                email = $email
            }

            try {
                if ([int]$recipient.Type -eq 2) {
                    $optional += $entry
                } else {
                    $required += $entry
                }
            } catch {
                $required += $entry
            }
        }
    } catch {}

    return @{
        required = $required
        optional = $optional
    }
}

function Get-ProviderEventId {
    param(
        [string]$StoreId,
        [string]$EntryId,
        [string]$GlobalAppointmentId,
        [string]$StartAt,
        [string]$EndAt
    )

    $seed = "$StoreId|$EntryId|$GlobalAppointmentId|$StartAt|$EndAt"
    return "outlook-calendar-" + (Get-Sha256HexFromString $seed)
}

function Get-CalendarEventObject {
    param(
        [Parameter(Mandatory = $true)]$Appointment,
        [Parameter(Mandatory = $true)][string]$Mailbox
    )

    $entryId = ""
    $storeId = ""
    $globalAppointmentId = ""
    $subject = ""
    $organizerName = ""
    $organizerEmail = ""
    $location = ""
    $body = ""
    $messageClass = ""
    $seriesMasterId = ""

    try { $entryId = "$($Appointment.EntryID)" } catch {}
    try { $storeId = "$($Appointment.Parent.StoreID)" } catch {}
    try { $globalAppointmentId = "$($Appointment.GlobalAppointmentID)" } catch {}
    try { $subject = "$($Appointment.Subject)" } catch {}
    try { $organizerName = "$($Appointment.Organizer)" } catch {}
    try { $location = "$($Appointment.Location)" } catch {}
    try { $body = "$($Appointment.Body)" } catch {}
    try { $messageClass = "$($Appointment.MessageClass)" } catch {}

    $organizerProperties = @(
        "http://schemas.microsoft.com/mapi/proptag/0x5D02001F",
        "http://schemas.microsoft.com/mapi/proptag/0x5D02001E",
        "http://schemas.microsoft.com/mapi/proptag/0x0C1F001F",
        "http://schemas.microsoft.com/mapi/proptag/0x0C1F001E"
    )
    foreach ($propertyName in $organizerProperties) {
        $email = Normalize-EmailAddress (Get-PropSafe -Item $Appointment -DaslName $propertyName)
        if ($email) {
            $organizerEmail = $email
            break
        }
    }

    $startAt = ConvertTo-IsoUtc $Appointment.Start
    $endAt = ConvertTo-IsoUtc $Appointment.End
    $createdAt = ConvertTo-IsoUtc $Appointment.CreationTime
    $lastModifiedAt = ConvertTo-IsoUtc $Appointment.LastModificationTime
    $recipients = Get-CalendarRecipients $Appointment

    $isRecurring = $false
    try { $isRecurring = [bool]$Appointment.IsRecurring } catch {}
    if ($isRecurring -and -not [string]::IsNullOrWhiteSpace($globalAppointmentId)) {
        $seriesMasterId = $globalAppointmentId
    }

    $providerEventId = Get-ProviderEventId `
        -StoreId $storeId `
        -EntryId $entryId `
        -GlobalAppointmentId $globalAppointmentId `
        -StartAt $startAt `
        -EndAt $endAt

    return [ordered]@{
        id = $providerEventId
        providerEventId = $providerEventId
        globalAppointmentId = $globalAppointmentId
        outlookEntryId = $entryId
        storeId = $storeId
        userEmail = $Mailbox
        subject = $subject
        organizerName = $organizerName
        organizerEmail = $organizerEmail
        requiredAttendees = $recipients.required
        optionalAttendees = $recipients.optional
        startAt = $startAt
        endAt = $endAt
        isAllDay = [bool]$Appointment.AllDayEvent
        busyStatus = Convert-BusyStatus $Appointment.BusyStatus
        responseStatus = Convert-ResponseStatus $Appointment.ResponseStatus
        location = $location
        onlineMeetingUrl = Find-OnlineMeetingUrl -Values @($location, $body)
        isRecurring = $isRecurring
        seriesMasterId = $seriesMasterId
        occurrenceStartAt = $startAt
        lastModifiedAt = $lastModifiedAt
        deletedAt = $null
        createdAt = $createdAt
        updatedAt = $lastModifiedAt
        messageClass = $messageClass
    }
}

try {
    if (-not (Ensure-OutlookCom)) {
        exit 1
    }

    $mailbox = Normalize-EmailAddress $MailboxEmail
    if (-not $mailbox) {
        try {
            $mailbox = Normalize-EmailAddress "$($script:OutlookNs.CurrentUser.Address)"
        } catch {}
    }
    if (-not $mailbox) { $mailbox = "unknown@outlook.local" }

    $calendar = $script:OutlookNs.GetDefaultFolder(9)
    $items = $calendar.Items
    $items.IncludeRecurrences = $true
    $items.Sort("[Start]")

    $windowStart = (Get-Date).Date.AddDays(-1 * $PastDays)
    $windowEnd = (Get-Date).Date.AddDays($FutureDays + 1)
    $restriction = "[Start] < '{0}' AND [End] > '{1}'" -f $windowEnd.ToString("g"), $windowStart.ToString("g")

    try {
        $items = $items.Restrict($restriction)
    } catch {
        Write-Log "Outlook Restrict failed, falling back to client-side filtering: $($_.Exception.Message)" "WARN"
    }

    New-Item -ItemType File -Force -Path $OutputPath | Out-Null
    Clear-Content -Path $OutputPath
    $seen = 0
    $written = 0
    $failed = 0

    foreach ($item in $items) {
        if ($MaxItems -gt 0 -and $seen -ge $MaxItems) { break }
        $seen += 1

        try {
            $start = [DateTime]$item.Start
            $end = [DateTime]$item.End
            if ($start -ge $windowEnd -or $end -le $windowStart) { continue }

            $event = Get-CalendarEventObject -Appointment $item -Mailbox $mailbox
            Add-Content -Path $OutputPath -Value ($event | ConvertTo-Json -Depth 20 -Compress) -Encoding UTF8
            $written += 1
        } catch {
            $failed += 1
            Write-Log "Failed to export calendar item: $($_.Exception.Message)" "WARN"
        }
    }

    Write-Log "Calendar probe complete. seen=$seen written=$written failed=$failed output=$OutputPath"
} finally {
    Reset-OutlookCom
}
