#!/usr/bin/env bash
# One-time AWS provisioning for CENTRIX: the screenshot bucket and the EC2 instance role that
# lets the API reach it without access keys.
#
# Run from an admin workstation (or AWS CloudShell) with the AWS CLI v2 and credentials allowed
# to manage S3, IAM and EC2. Safe to re-run: every step checks for or overwrites existing state.
#
#   AWS_REGION=ap-south-1 BUCKET=centrix-screenshots-acme ./setup-s3-and-iam.sh
#   AWS_REGION=ap-south-1 BUCKET=centrix-screenshots-acme INSTANCE_ID=i-0abc... ./setup-s3-and-iam.sh
#
# Required:  AWS_REGION, BUCKET
# Optional:  INSTANCE_ID              attach the role and fix instance metadata settings
#            ROLE_NAME                default centrix-ec2-role
#            IA_TRANSITION_DAYS       move screenshots to Standard-IA after N days (0 = never)
#            BACKUP_PREFIX            default backups/
#            BACKUP_RETENTION_DAYS    default 14

set -euo pipefail

readonly DEFAULT_ROLE_NAME="centrix-ec2-role"
readonly DEFAULT_IA_TRANSITION_DAYS=30
readonly DEFAULT_BACKUP_PREFIX="backups/"
readonly DEFAULT_BACKUP_RETENTION_DAYS=14
# Standard-IA bills every object as at least 128 KiB, so smaller objects cost more there.
readonly IA_MIN_BILLABLE_BYTES=131072
readonly ABORT_MULTIPART_AFTER_DAYS=1
# Containers sit one network hop behind the host. With the IMDSv2 default hop limit of 1 the
# metadata response never reaches them and the AWS SDK finds no credentials.
readonly IMDS_HOP_LIMIT=2

log() { printf '[setup] %s\n' "$*"; }
die() { printf '[setup] ERROR: %s\n' "$*" >&2; exit 1; }

: "${AWS_REGION:?AWS_REGION is required}"
: "${BUCKET:?BUCKET is required}"
ROLE_NAME="${ROLE_NAME:-$DEFAULT_ROLE_NAME}"
IA_TRANSITION_DAYS="${IA_TRANSITION_DAYS:-$DEFAULT_IA_TRANSITION_DAYS}"
BACKUP_PREFIX="${BACKUP_PREFIX:-$DEFAULT_BACKUP_PREFIX}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-$DEFAULT_BACKUP_RETENTION_DAYS}"
INSTANCE_ID="${INSTANCE_ID:-}"

command -v aws >/dev/null || die "AWS CLI v2 not found"
[[ "$IA_TRANSITION_DAYS" =~ ^[0-9]+$ ]] || die "IA_TRANSITION_DAYS must be a whole number"
[[ "$BACKUP_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_RETENTION_DAYS must be positive"
[[ "$BACKUP_PREFIX" == */ ]] || die "BACKUP_PREFIX must end with a slash"

export AWS_DEFAULT_REGION="$AWS_REGION"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
log "account ${ACCOUNT_ID}, region ${AWS_REGION}, bucket ${BUCKET}"

# -- Bucket -------------------------------------------------------------------
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  log "bucket exists"
else
  log "creating bucket"
  if [[ "$AWS_REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" \
      --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
  fi
  aws s3api wait bucket-exists --bucket "$BUCKET"
fi

log "blocking all public access"
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

log "disabling ACLs (bucket owner enforced)"
aws s3api put-bucket-ownership-controls --bucket "$BUCKET" \
  --ownership-controls "Rules=[{ObjectOwnership=BucketOwnerEnforced}]"

log "enabling default encryption (SSE-S3 with bucket key)"
cat > "$TMP_DIR/encryption.json" <<JSON
{
  "Rules": [
    {
      "ApplyServerSideEncryptionByDefault": { "SSEAlgorithm": "AES256" },
      "BucketKeyEnabled": true
    }
  ]
}
JSON
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration "file://$TMP_DIR/encryption.json"

log "denying non-TLS access"
cat > "$TMP_DIR/bucket-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::${BUCKET}", "arn:aws:s3:::${BUCKET}/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
JSON
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$TMP_DIR/bucket-policy.json"

log "applying lifecycle rules"
TRANSITION_RULE=""
if (( IA_TRANSITION_DAYS > 0 )); then
  TRANSITION_RULE="{
      \"ID\": \"screenshots-to-standard-ia\",
      \"Status\": \"Enabled\",
      \"Filter\": { \"ObjectSizeGreaterThan\": ${IA_MIN_BILLABLE_BYTES} },
      \"Transitions\": [{ \"Days\": ${IA_TRANSITION_DAYS}, \"StorageClass\": \"STANDARD_IA\" }]
    },"
fi
cat > "$TMP_DIR/lifecycle.json" <<JSON
{
  "Rules": [
    ${TRANSITION_RULE}
    {
      "ID": "expire-database-backups",
      "Status": "Enabled",
      "Filter": { "Prefix": "${BACKUP_PREFIX}" },
      "Expiration": { "Days": ${BACKUP_RETENTION_DAYS} }
    },
    {
      "ID": "abort-incomplete-multipart-uploads",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": ${ABORT_MULTIPART_AFTER_DAYS} }
    }
  ]
}
JSON
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration "file://$TMP_DIR/lifecycle.json"

# -- IAM role -----------------------------------------------------------------
cat > "$TMP_DIR/trust.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  log "role ${ROLE_NAME} exists"
else
  log "creating role ${ROLE_NAME}"
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://$TMP_DIR/trust.json" \
    --description "CENTRIX EC2 host: screenshot bucket access and SSM Session Manager" >/dev/null
fi

# Least privilege: the API only ever puts and gets single objects. The backup script needs the
# same two actions under the backup prefix, which the object wildcard already covers.
log "writing least-privilege S3 policy"
cat > "$TMP_DIR/s3-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ScreenshotAndBackupObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "ListBackupsForRestore",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::${BUCKET}",
      "Condition": { "StringLike": { "s3:prefix": ["${BACKUP_PREFIX}*"] } }
    }
  ]
}
JSON
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name centrix-s3-access \
  --policy-document "file://$TMP_DIR/s3-policy.json"

# Session Manager gives shell access without opening port 22 to the internet.
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"

if aws iam get-instance-profile --instance-profile-name "$ROLE_NAME" >/dev/null 2>&1; then
  log "instance profile exists"
else
  log "creating instance profile"
  aws iam create-instance-profile --instance-profile-name "$ROLE_NAME" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE_NAME" --role-name "$ROLE_NAME"
  # A new instance profile is not usable by EC2 until IAM has propagated it.
  aws iam wait instance-profile-exists --instance-profile-name "$ROLE_NAME"
fi

# -- Instance -----------------------------------------------------------------
if [[ -n "$INSTANCE_ID" ]]; then
  CURRENT_PROFILE="$(aws ec2 describe-iam-instance-profile-associations \
    --filters "Name=instance-id,Values=${INSTANCE_ID}" "Name=state,Values=associated" \
    --query "IamInstanceProfileAssociations[0].IamInstanceProfile.Arn" --output text)"
  if [[ "$CURRENT_PROFILE" == *"/${ROLE_NAME}" ]]; then
    log "instance already uses ${ROLE_NAME}"
  elif [[ "$CURRENT_PROFILE" == "None" ]]; then
    log "attaching instance profile to ${INSTANCE_ID}"
    aws ec2 associate-iam-instance-profile --instance-id "$INSTANCE_ID" \
      --iam-instance-profile "Name=${ROLE_NAME}" >/dev/null
  else
    die "instance has a different profile (${CURRENT_PROFILE}); replace it manually"
  fi

  log "requiring IMDSv2 with hop limit ${IMDS_HOP_LIMIT} so containers receive role credentials"
  aws ec2 modify-instance-metadata-options --instance-id "$INSTANCE_ID" \
    --http-tokens required --http-put-response-hop-limit "$IMDS_HOP_LIMIT" \
    --http-endpoint enabled >/dev/null
fi

log "done"
log "set in deploy/.env:  AWS_REGION=${AWS_REGION}"
log "                     SCREENSHOT_S3_BUCKET=${BUCKET}"
log "                     BACKUP_S3_URI=s3://${BUCKET}/${BACKUP_PREFIX}postgres"
