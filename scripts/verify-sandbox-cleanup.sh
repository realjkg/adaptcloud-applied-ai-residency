#!/usr/bin/env bash
set -euo pipefail

cloud_target=${CLOUD_TARGET:?CLOUD_TARGET is required}
expected_scope=${EXPECTED_CLOUD_SCOPE:?EXPECTED_CLOUD_SCOPE is required}
application_name=${APPLICATION_NAME:-applied-ai-residency}
report_path=${CLEANUP_REPORT_PATH:-cleanup-residuals.json}

if ! [[ "$application_name" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]]; then
  echo "APPLICATION_NAME must be a lowercase cloud-safe name." >&2
  exit 1
fi

case "$cloud_target" in
  aws)
    if ! [[ "$expected_scope" =~ ^[0-9]{12}$ ]]; then
      echo "EXPECTED_CLOUD_SCOPE must be the exact 12-digit AWS account ID." >&2
      exit 1
    fi
    actual_scope=$(aws sts get-caller-identity --query Account --output text)
    if [ "$actual_scope" != "$expected_scope" ]; then
      echo "Authenticated AWS account does not match EXPECTED_CLOUD_SCOPE." >&2
      exit 1
    fi
    aws resourcegroupstaggingapi get-resources \
      --tag-filters \
        "Key=Application,Values=$application_name" \
        "Key=Environment,Values=sandbox" \
        "Key=ManagedBy,Values=terraform" \
      --query 'ResourceTagMappingList[].ResourceARN' \
      --output json > "$report_path"
    ;;
  gcp)
    if ! [[ "$expected_scope" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
      echo "EXPECTED_CLOUD_SCOPE must be the exact GCP project ID." >&2
      exit 1
    fi
    actual_scope=$(gcloud projects describe "$expected_scope" --format='value(projectId)')
    if [ "$actual_scope" != "$expected_scope" ]; then
      echo "Authenticated identity cannot verify EXPECTED_CLOUD_SCOPE." >&2
      exit 1
    fi
    raw_report=$(mktemp)
    trap 'rm -f "$raw_report"' EXIT
    gcloud asset search-all-resources \
      --scope="projects/$expected_scope" \
      --query="labels.application:$application_name AND labels.environment:sandbox" \
      --format=json > "$raw_report"
    node -e '
      const fs = require("node:fs");
      const resources = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const residuals = resources
        .filter((resource) => resource.labels?.["managed-by"] === "terraform")
        .map((resource) => ({ assetType: resource.assetType, name: resource.name }));
      fs.writeFileSync(process.argv[2], JSON.stringify(residuals, null, 2) + "\n");
    ' "$raw_report" "$report_path"
    ;;
  *)
    echo "CLOUD_TARGET must be aws or gcp." >&2
    exit 1
    ;;
esac

residual_count=$(node -e '
  const resources = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(resources.length));
' "$report_path")

if [ "$residual_count" != "0" ]; then
  echo "Cleanup is incomplete: $residual_count tagged sandbox resource(s) remain. Review $report_path." >&2
  exit 1
fi

echo "Cleanup verified: Terraform state and tagged $cloud_target sandbox inventory are empty."
