#!/bin/bash
# Shell script to update all git projects in '2-参考项目'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECTS_DIR="$SCRIPT_DIR/2/参考项目"

# Handle potential path issue if it's literally "2-参考项目"
PROJECTS_DIR="$SCRIPT_DIR/2-参考项目"

if [ ! -d "$PROJECTS_DIR" ]; then
    echo -e "\033[0;31mDirectory '$PROJECTS_DIR' not found.\033[0m"
    exit 1
fi

for dir in "$PROJECTS_DIR"/*/; do
    if [ -d "$dir/.git" ]; then
        dir_name=$(basename "$dir")
        echo -e "\033[0;36mUpdating $dir_name...\033[0m"
        cd "$dir" || continue
        git pull
        cd "$SCRIPT_DIR" || continue
    else
        dir_name=$(basename "$dir")
        echo -e "\033[0;33mSkipping $dir_name (not a git repository).\033[0m"
    fi
done

echo -e "\n\033[0;32mAll projects updated!\033[0m"
