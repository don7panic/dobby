#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SOURCE_SKILLS_DIR="$REPO_ROOT/skills"

expand_home() {
  case "$1" in
    "~")
      printf "%s\n" "$HOME"
      ;;
    "~/"*)
      printf "%s/%s\n" "$HOME" "${1#~/}"
      ;;
    *)
      printf "%s\n" "$1"
      ;;
  esac
}

resolve_dobby_root() {
  if [ "${1:-}" != "" ]; then
    expand_home "$1"
    return
  fi

  if [ "${DOBBY_ROOT_DIR:-}" != "" ]; then
    expand_home "$DOBBY_ROOT_DIR"
    return
  fi

  if [ "${DOBBY_CONFIG_PATH:-}" != "" ]; then
    config_path=$(expand_home "$DOBBY_CONFIG_PATH")
    dirname "$config_path"
    return
  fi

  printf "%s/.dobby\n" "$HOME"
}

TARGET_ROOT=$(resolve_dobby_root "${1:-}")
TARGET_SKILLS_DIR="$TARGET_ROOT/skills"

mkdir -p "$TARGET_SKILLS_DIR"

if [ ! -d "$SOURCE_SKILLS_DIR" ]; then
  echo "No repo-managed skills directory found: $SOURCE_SKILLS_DIR"
  exit 0
fi

installed_count=0

for skill_dir in "$SOURCE_SKILLS_DIR"/*; do
  if [ ! -d "$skill_dir" ] || [ ! -f "$skill_dir/SKILL.md" ]; then
    continue
  fi

  skill_name=$(basename "$skill_dir")
  target_skill_dir="$TARGET_SKILLS_DIR/$skill_name"

  rm -rf "$target_skill_dir"
  cp -R "$skill_dir" "$target_skill_dir"

  installed_count=$((installed_count + 1))
  echo "Installed skill: $skill_name -> $target_skill_dir"
done

if [ "$installed_count" -eq 0 ]; then
  echo "No repo-managed skills found in $SOURCE_SKILLS_DIR"
  exit 0
fi

echo ""
echo "Installed $installed_count skill(s) into $TARGET_SKILLS_DIR"
echo "Recommended provider.pi.agentDir: $TARGET_ROOT"
