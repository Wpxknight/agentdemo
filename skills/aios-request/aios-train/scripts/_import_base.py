"""
统一引用入口。
各业务 skill 的脚本通过 from _import_base import * 来引用 aios-base 中的所有公共模块。
"""

import os
import sys

_base_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "aios-base", "scripts")
if os.path.isdir(_base_dir):
    sys.path.insert(0, os.path.abspath(_base_dir))
