#!/usr/bin/env bash
# 交互式确认环境变量。逐个询问，用户输入 "y"/"yes"/空 使用默认值，
# 输入其他值则使用用户输入。
# 非交互终端（如 CI/后台执行）时：已预设环境变量直接使用，否则使用默认值。

confirm_env() {
  local var_name="$1"
  local default_value="$2"
  local prompt="$3"

  local current_value
  current_value="${!var_name:-}"

  # 非交互终端：已预设则直接用，否则用默认值
  if [ ! -t 0 ]; then
    if [ -n "$current_value" ]; then
      echo "  [${var_name}] 非交互终端，使用当前环境变量: ${current_value:0:20}..."
    else
      export "${var_name}=${default_value}"
      echo "  [${var_name}] 非交互终端，使用默认值: ${default_value:0:20}..."
    fi
    echo ""
    return 0
  fi

  if [ -n "$current_value" ]; then
    echo "  [${var_name}] 当前环境变量已设置: ${current_value}"
    read -r -p "  使用此值? (y/yes/回车=使用, n=输入新值): " use_current
    case "$use_current" in
      n|no|N|NO)
        read -r -p "  请输入新值: " new_val
        echo ""
        return 0
        ;;
      *)
        export "${var_name}=${current_value}"
        echo "  -> 使用当前值: ${current_value:0:20}..."
        echo ""
        return 0
        ;;
    esac
  fi

  read -r -p "${prompt} [${default_value}]: " user_input
  if [ -z "$user_input" ] || [ "$user_input" = "y" ] || [ "$user_input" = "yes" ]; then
    export "${var_name}=${default_value}"
    echo "  -> 使用默认值: ${default_value:0:20}..."
  else
    export "${var_name}=${user_input}"
    echo "  -> 使用输入值: ${user_input:0:20}..."
  fi
  echo ""
}

check_api_key_valid() {
  local key="$1"

  if [ -z "$key" ]; then
    echo "错误: E2B_API_KEY 未设置，请设置有效的 API Key。"
    exit 1
  fi

  if [ "${#key}" -lt 20 ]; then
    echo "错误: E2B_API_KEY 太短（${#key} 字符），请检查是否有效。"
    exit 1
  fi

  # 检测 placeholder 模式: 包含中文或等于占位字符串
  if echo "$key" | grep -qP '[\x{4e00}-\x{9fff}]'; then
    echo "错误: E2B_API_KEY 包含中文字符，请提供有效的 API Key。"
    exit 1
  fi

  if [ "$key" = "sk_live_替换为你的41环境凭证" ]; then
    echo "错误: E2B_API_KEY 是占位值，请提供有效的 API Key（通过环境变量 E2B_API_KEY 设置）。"
    exit 1
  fi
}

echo "=============================================="
echo "  E2B MVP 回归 - 环境参数确认"
echo "=============================================="
echo ""
echo "每个参数都可以直接回车使用默认值，或输入自定义值。"
echo ""
