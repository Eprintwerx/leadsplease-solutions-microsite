# One-shot wiring of /solutions-hub on CloudFront distribution E39WJRUVOH25A4.
# Prereqs already done by the deploy step:
#   - bucket leadsplease-test-solutions-microsite has the site under solutions-hub/
#   - OAC E2TI3SMUN31SYB exists
#   - CloudFront Function solutions-hub-rewrite exists in DEVELOPMENT
#
# This script does:
#   1. Publish the function to LIVE
#   2. Fetch the current distribution config + ETag
#   3. Add the S3 origin + the /solutions-hub* behavior with function association
#   4. update-distribution with --if-match
#   5. put-bucket-policy granting CloudFront read via the OAC
#   6. create-invalidation for /solutions-hub*
#
# Run from the project root:
#   powershell -ExecutionPolicy Bypass -File scripts\wire-solutions-hub-to-cloudfront.ps1

$ErrorActionPreference = 'Stop'

$BUCKET   = "leadsplease-test-solutions-microsite"
$DIST     = "E39WJRUVOH25A4"
$ACCOUNT  = "256458554827"
$OAC_ID   = "E2TI3SMUN31SYB"
$FN_NAME  = "solutions-hub-rewrite"
$FN_ARN   = "arn:aws:cloudfront::${ACCOUNT}:function/${FN_NAME}"
$ORIGIN_ID = "s3-solutions-hub-test"

# ------------------------------------------------------------------
# 1. Publish CloudFront function (DEVELOPMENT -> LIVE)
# ------------------------------------------------------------------
Write-Host "==> Step 1 skipped (function was published in prior run)" -ForegroundColor Yellow

# ------------------------------------------------------------------
# 2. Fetch current distribution config + ETag
# ------------------------------------------------------------------
Write-Host "==> Fetching distribution config..." -ForegroundColor Cyan
$raw = aws cloudfront get-distribution-config --id $DIST | Out-String
$wrapper = $raw | ConvertFrom-Json
$distConfig = $wrapper.DistributionConfig
$distConfigEtag = $wrapper.ETag
Write-Host "    Current ETag: $distConfigEtag"

# Sanity check: bail if our origin or behavior is already there
$existingOrigin = $distConfig.Origins.Items | Where-Object { $_.Id -eq $ORIGIN_ID }
$existingBehavior = $distConfig.CacheBehaviors.Items | Where-Object { $_.PathPattern -eq "/solutions*" }
if ($existingOrigin) { Write-Host "    Origin '$ORIGIN_ID' already present - skipping origin add" -ForegroundColor Yellow }
if ($existingBehavior) { Write-Host "    Behavior '/solutions*' already present - skipping behavior add" -ForegroundColor Yellow }

# ------------------------------------------------------------------
# 3. Build new origin and new cache behavior
# ------------------------------------------------------------------
$newOrigin = [pscustomobject]@{
    Id                  = $ORIGIN_ID
    DomainName          = "$BUCKET.s3.us-east-1.amazonaws.com"
    OriginPath          = ""
    CustomHeaders       = @{ Quantity = 0 }
    S3OriginConfig      = @{ OriginAccessIdentity = "" }
    OriginAccessControlId = $OAC_ID
    ConnectionAttempts  = 3
    ConnectionTimeout   = 10
    OriginShield        = @{ Enabled = $false }
}

# Managed cache policy IDs (AWS-managed):
#   CachingOptimized = 658327ea-f89d-4fab-a63d-7e88639e58f6
#   CachingDisabled  = 4135ea2d-6df8-44a3-9df3-4b5a84be39ad
$cachingOptimizedId = "658327ea-f89d-4fab-a63d-7e88639e58f6"

$newBehavior = [pscustomobject]@{
    PathPattern              = "/solutions*"
    TargetOriginId           = $ORIGIN_ID
    TrustedSigners           = @{ Enabled = $false; Quantity = 0 }
    TrustedKeyGroups         = @{ Enabled = $false; Quantity = 0 }
    ViewerProtocolPolicy     = "redirect-to-https"
    AllowedMethods           = @{
        Quantity = 2
        Items = @("GET","HEAD")
        CachedMethods = @{ Quantity = 2; Items = @("GET","HEAD") }
    }
    SmoothStreaming          = $false
    Compress                 = $true
    LambdaFunctionAssociations = @{ Quantity = 0 }
    FunctionAssociations     = @{
        Quantity = 1
        Items = @(@{
            FunctionARN = $FN_ARN
            EventType   = "viewer-request"
        })
    }
    FieldLevelEncryptionId   = ""
    CachePolicyId            = $cachingOptimizedId
}

if (-not $existingOrigin) {
    $distConfig.Origins.Items = @($distConfig.Origins.Items) + $newOrigin
    $distConfig.Origins.Quantity = $distConfig.Origins.Items.Count
}
if (-not $existingBehavior) {
    if ($null -eq $distConfig.CacheBehaviors.Items) {
        $distConfig.CacheBehaviors = @{ Quantity = 1; Items = @($newBehavior) }
    } else {
        # New behaviors should come before more-generic ones; PathPattern is
        # specific enough that order rarely matters, but put it first to be safe.
        $distConfig.CacheBehaviors.Items = @($newBehavior) + @($distConfig.CacheBehaviors.Items)
        $distConfig.CacheBehaviors.Quantity = $distConfig.CacheBehaviors.Items.Count
    }
}

# ------------------------------------------------------------------
# 4. update-distribution
# ------------------------------------------------------------------
$updatePath = Join-Path $env:TEMP "dist-update.json"
$distConfig | ConvertTo-Json -Depth 100 | Out-File -Encoding ascii -FilePath $updatePath

Write-Host "==> Updating distribution $DIST (if-match $distConfigEtag)..." -ForegroundColor Cyan
aws cloudfront update-distribution `
    --id $DIST `
    --if-match $distConfigEtag `
    --distribution-config "file://$updatePath" | Out-Null
Write-Host "    Distribution update submitted. CloudFront will deploy (5-10 min)." -ForegroundColor Green

# ------------------------------------------------------------------
# 5. Bucket policy
# ------------------------------------------------------------------
$policyPath = Join-Path $env:TEMP "bucket-policy.json"
@"
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowCloudFrontServicePrincipalReadOnly",
    "Effect": "Allow",
    "Principal": { "Service": "cloudfront.amazonaws.com" },
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::$BUCKET/solutions/*",
    "Condition": { "StringEquals": { "AWS:SourceArn": "arn:aws:cloudfront::${ACCOUNT}:distribution/$DIST" } }
  }]
}
"@ | Out-File -Encoding ascii -FilePath $policyPath

Write-Host "==> Applying bucket policy..." -ForegroundColor Cyan
aws s3api put-bucket-policy --bucket $BUCKET --policy "file://$policyPath" | Out-Null
Write-Host "    Bucket policy applied." -ForegroundColor Green

# ------------------------------------------------------------------
# 6. Invalidate
# ------------------------------------------------------------------
Write-Host "==> Creating invalidation..." -ForegroundColor Cyan
aws cloudfront create-invalidation --distribution-id $DIST --paths "/solutions" "/solutions/*" | Out-Null
Write-Host "    Invalidation queued." -ForegroundColor Green

Write-Host ""
Write-Host "All wiring submitted. Wait 5-10 min for distribution to redeploy, then:" -ForegroundColor Green
Write-Host "  curl -I https://test.leadsplease.com/solutions/"
Write-Host "  curl -I https://test.leadsplease.com/solutions/industries/real-estate.html"

