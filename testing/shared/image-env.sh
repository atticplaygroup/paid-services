# Source from fixture scripts; local runs and CI share the same image names.
: "${IMAGE_PREFIX:=local}"
: "${IMAGE_TAG:=${OCI_IMAGE_TAG:-dev}}"
[[ $IMAGE_PREFIX =~ ^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]] || { echo 'Invalid IMAGE_PREFIX' >&2; exit 1; }
[[ $IMAGE_TAG =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || { echo 'Invalid IMAGE_TAG' >&2; exit 1; }
export IMAGE_PREFIX IMAGE_TAG
# Existing OCI fixture callers can still select a tag with OCI_IMAGE_TAG.
export OCI_IMAGE_TAG="$IMAGE_TAG"
