"""
大模型微调训练参数默认值配置。
update_finetune_config.py 引用此模块构建请求体。

类型规则（与 API 后端 Go struct 一致）：
  int:    maxSamples, cutOffLen, perDeviceTrainBatchSize, gradientAccumulationSteps,
          loggingSteps, saveSteps, freezeTrainableLayers, loraRank, loraAlpha,
          galoreRank, galoreUpdateInterval, badamSwitchInterval
  string: 其余所有字段
"""

# ---------------------------------------------------------------------------
# parameterConfiguration 顶层默认值
# ---------------------------------------------------------------------------

STANDARD_PARAMS = {
    # string 字段
    "learningRate": "5e-05",
    "numTrainEpochs": "3.0",
    "maxGradNorm": "1.0",
    "calculationType": "fp16",
    "valSize": "0",
    "lrSchedulerType": "cosine",
    # int 字段
    "maxSamples": 100000,
    "cutOffLen": 1024,
    "perDeviceTrainBatchSize": 2,
    "gradientAccumulationSteps": 8,
}

ADVANCED_PARAMS = {
    "template": "default",
    "quantizationBit": "none",
    "ropeScaling": "none",
    "flashAttn": "none",
    "visualInputs": "False",
}

OTHER_PARAMS = {
    # int 字段
    "loggingSteps": 5,
    "saveSteps": 100,
    # string 字段
    "warmupSteps": "0",
    "neftuneNoiseAlpha": "0",
    "optim": "adamw_torch",
}

FREEZE_PARAMS = {
    # int 字段
    "freezeTrainableLayers": 2,
    # string 字段
    "freezeTrainableModules": "all",
}

# ---------------------------------------------------------------------------
# parameterConfiguration 子对象默认值
# ---------------------------------------------------------------------------

LORA_PARAMS = {
    # int 字段
    "loraRank": 8,
    "loraAlpha": 16,
    # string 字段
    "loraDropout": "0",
    "loraTarget": "all",
    "loraPlusLrRatio": "0",
    "useRslora": "False",
    "useDora": "False",
    "pissaInit": "False",
    "pissaConvert": "False",
}

RLHF_PARAMS = {
    "prefBeta": "0.1",
    "prebfFtx": "0",
    "prebfLoss": "sigmoid",
    "ppoScoreNorm": "False",
    "ppoWhitenRewards": "False",
}

GALORE_PARAMS = {
    "isNotUseGalore": False,
    # int 字段
    "galoreRank": 16,
    "galoreUpdateInterval": 200,
    # string 字段
    "galoreScale": "0.25",
    "galoreTarget": "all",
}

BADAM_PARAMS = {
    "isNotUseBadam": False,
    "badamModel": "layer",
    "badamSwitchMode": "ascending",
    # int 字段
    "badamSwitchInterval": 50,
    # string 字段
    "badamUpdateRatio": "0.05",
}

# ---------------------------------------------------------------------------
# parameterInfo 分组（UI 展示用，value 始终为 string）
# ---------------------------------------------------------------------------

PARAMETER_INFO_GROUPS = [
    [
        {"name": "学习率", "key": "learningRate", "value": "5e-05", "describe": "AdamW 优化器的初始学习率。"},
        {"name": "训练轮数", "key": "numTrainEpochs", "value": "3.0", "describe": "需要执行的训练总轮数。"},
        {"name": "最大梯度范数", "key": "maxGradNorm", "value": "1.0", "describe": "用于梯度裁剪的范数。"},
        {"name": "最大样本数", "key": "maxSamples", "value": "100000", "describe": "每个数据集的最大样本数。"},
        {"name": "计算类型", "key": "calculationType", "value": "fp16", "describe": "是否使用混合精度训练。"},
        {"name": "截断长度", "key": "cutOffLen", "value": "1024", "describe": "输入序列分词后的最大长度。"},
        {"name": "批处理大小", "key": "perDeviceTrainBatchSize", "value": "2", "describe": "每个 GPU 处理的样本数量。"},
        {"name": "梯度累积", "key": "gradientAccumulationSteps", "value": "8", "describe": "梯度累积的步数。"},
        {"name": "验证集比例", "key": "valSize", "value": "0", "describe": "验证集占全部样本的百分比。"},
        {"name": "学习率调节器", "key": "lrSchedulerType", "value": "cosine", "describe": "学习率调度器的名称。"},
    ],
    [
        {"name": "提示词模板", "key": "template", "value": "default", "describe": "构建提示词时使用的模板,如qwen,chatglm等。"},
        {"name": "量化等级", "key": "quantizationBit", "value": "none", "describe": "启用 4/8 比特模型量化(QLoRA),lora方式支持4/8比特量化。"},
        {"name": "RoPE 插值方法", "key": "ropeScaling", "value": "none", "describe": "RoPE 插值方法, 可选值: linear, dynamic, none"},
        {"name": "加速方式", "key": "flashAttn", "value": "none", "describe": "加速方式, 可选值: flashattn2, none,unsloth"},
        {"name": "图像输入", "key": "visualInputs", "value": "False", "describe": "是否启用图像输入,True表示启用。"},
    ],
    [
        {"name": "日志间隔", "key": "loggingSteps", "value": "5", "describe": "每两次日志输出间的更新步数。"},
        {"name": "保存间隔", "key": "saveSteps", "value": "100", "describe": "每两次断点保存间的更新步数。"},
        {"name": "预热步数", "key": "warmupSteps", "value": "0", "describe": "学习率预热采用的步数。"},
        {"name": "NEFTune 噪声参数", "key": "neftuneNoiseAlpha", "value": "0", "describe": "嵌入向量所添加的噪声大小。"},
        {"name": "优化器", "key": "optim", "value": "adamw_torch", "describe": "使用的优化器：adamw_torch、adamw_8bit 或 adafactor。"},
    ],
    [
        {"name": "可训练层数", "key": "freezeTrainableLayers", "value": "2", "describe": "最末尾（+）/最前端（-）可训练隐藏层的数量。"},
        {"name": "可训练模块", "key": "freezeTrainableModules", "value": "all", "describe": "可训练模块的名称。使用英文逗号分隔多个名称。"},
    ],
    [
        {"name": "LoRA 秩", "key": "loraRank", "value": "8", "describe": "LoRA 矩阵的秩大小。"},
        {"name": "LoRA 缩放系数", "key": "loraAlpha", "value": "16", "describe": "LoRA 缩放系数大小。"},
        {"name": "LoRA 随机丢弃", "key": "loraDropout", "value": "0", "describe": "LoRA 权重随机丢弃的概率。"},
        {"name": "LoRA+ 学习率比例", "key": "loraPlusLrRatio", "value": "0", "describe": "LoRA+ 中 B 矩阵的学习率倍数。"},
        {"name": "使用 rslora", "key": "useRslora", "value": "False", "describe": "对 LoRA 层使用秩稳定缩放方法。"},
        {"name": "使用 DoRA", "key": "useDora", "value": "False", "describe": "使用权重分解的 LoRA。"},
        {"name": "使用 PiSSA", "key": "pissaInit", "value": "False", "describe": "使用 PiSSA 方法。"},
    ],
    [
        {"name": "Beta 参数", "key": "prefBeta", "value": "0.1", "describe": "损失函数中 beta 超参数大小。"},
        {"name": "Ftx gamma", "key": "prebfFtx", "value": "0", "describe": "损失函数中 SFT 损失的权重大小。"},
        {"name": "损失类型", "key": "prebfLoss", "value": "sigmoid", "describe": "损失函数的类型。"},
        {"name": "奖励模型路径", "key": "rewardModel", "value": "", "describe": "PPO 训练中奖励模型的适配器路径。"},
        {"name": "奖励模型", "key": "ppoScoreNorm", "value": "False", "describe": "PPO 训练中归一化奖励分数。"},
        {"name": "白化奖励", "key": "ppoWhitenRewards", "value": "False", "describe": "PPO 训练中是否对奖励分数进行白化处理。"},
    ],
    [
        {"name": "使用 GaLore", "key": "isNotUseGalore", "value": "false", "describe": "使用梯度低秩投影。"},
        {"name": "GaLore 秩", "key": "galoreRank", "value": "16", "describe": "GaLore 梯度的秩大小。"},
        {"name": "更新间隔", "key": "galoreUpdateInterval", "value": "200", "describe": "相邻两次投影更新的步数。"},
        {"name": "GaLore 缩放系数", "key": "galoreScale", "value": "0.25", "describe": "GaLore 缩放系数大小。"},
        {"name": "GaLore 作用模块", "key": "galoreTarget", "value": "all", "describe": "应用 GaLore 的模块名称。使用英文逗号分隔多个名称。"},
    ],
    [
        {"name": "使用 BAdam", "key": "isNotUseBadam", "value": "false", "describe": "使用 BAdam 优化器。"},
        {"name": "BAdam 模式", "key": "badamModel", "value": "layer", "describe": "使用 layer-wise 或 ratio-wise BAdam 优化器。"},
        {"name": "切换策略", "key": "badamSwitchMode", "value": "ascending", "describe": "Layer-wise BAdam 优化器的块切换策略。"},
        {"name": "切换频率", "key": "badamSwitchInterval", "value": "50", "describe": "Layer-wise BAdam 优化器的块切换频率。"},
        {"name": "Block 更新比例", "key": "badamUpdateRatio", "value": "0.05", "describe": "Ratio-wise BAdam 优化器的更新比例。"},
    ],
]

# ---------------------------------------------------------------------------
# 构建函数
# ---------------------------------------------------------------------------

# 所有已知参数的正确类型映射（key → int|str）
_INT_KEYS = {
    # 顶层
    "maxSamples", "cutOffLen", "perDeviceTrainBatchSize", "gradientAccumulationSteps",
    "loggingSteps", "saveSteps", "freezeTrainableLayers",
    # lora 子对象
    "loraRank", "loraAlpha",
    # galore 子对象
    "galoreRank", "galoreUpdateInterval",
    # badam 子对象
    "badamSwitchInterval",
}

# string 字段：已知的 int 字段之外的所有字段保持 string


def _apply_override(target: dict, key: str, value):
    """将用户覆盖值写入 target，自动保持正确类型。

    - 如果 key 在 _INT_KEYS 中且 value 可转 int → 转 int
    - 否则保持 string
    """
    if key in _INT_KEYS:
        try:
            target[key] = int(value)
            return
        except (ValueError, TypeError):
            pass
    target[key] = str(value)


def build_parameter_configuration(
    finetuning_type="lora",
    learning_rate=None,
    epochs=None,
    batch_size=None,
    gradient_accumulation=None,
    cutoff_len=None,
    calculation_type=None,
    max_samples=None,
    val_size=None,
    lr_scheduler_type=None,
    template=None,
    quantization_bit=None,
    max_grad_norm=None,
    lora_rank=None,
    lora_alpha=None,
    lora_dropout=None,
    freeze_layers=None,
    freeze_modules=None,
    dataset_name=None,
    **overrides,
):
    """构建 parameterConfiguration 对象。用户自定义的参数覆盖默认值。"""

    # 标准参数
    params = dict(STANDARD_PARAMS)
    if learning_rate is not None:
        params["learningRate"] = str(learning_rate)
    if epochs is not None:
        params["numTrainEpochs"] = str(epochs)
    if batch_size is not None:
        params["perDeviceTrainBatchSize"] = int(batch_size)
    if gradient_accumulation is not None:
        params["gradientAccumulationSteps"] = int(gradient_accumulation)
    if cutoff_len is not None:
        params["cutOffLen"] = int(cutoff_len)
    if calculation_type is not None:
        params["calculationType"] = calculation_type
    if max_samples is not None:
        params["maxSamples"] = int(max_samples)
    if val_size is not None:
        params["valSize"] = str(val_size)
    if lr_scheduler_type is not None:
        params["lrSchedulerType"] = lr_scheduler_type
    if max_grad_norm is not None:
        params["maxGradNorm"] = str(max_grad_norm)

    advanced = dict(ADVANCED_PARAMS)
    if template is not None:
        advanced["template"] = template
    if quantization_bit is not None:
        advanced["quantizationBit"] = quantization_bit

    other = dict(OTHER_PARAMS)

    config = {
        "adapterNameOrPath": "",
        "stage": "sft",
        "modelNameOrPath": "/app/model",
        "finetuningType": finetuning_type,
        "datasetName": dataset_name or "",
        "datasetDir": "/app/data/data",
        "dataset": "identity",
        **params,
        "outputDir": "/app/output/checkpoint",
        **advanced,
        **other,
    }

    # 部分参数（freeze 模式也包含在顶层）
    freeze = dict(FREEZE_PARAMS)
    if freeze_layers is not None:
        freeze["freezeTrainableLayers"] = int(freeze_layers)
    if freeze_modules is not None:
        freeze["freezeTrainableModules"] = freeze_modules
    config.update(freeze)

    # LoRA 参数
    lora = dict(LORA_PARAMS)
    if lora_rank is not None:
        lora["loraRank"] = int(lora_rank)
    if lora_alpha is not None:
        lora["loraAlpha"] = int(lora_alpha)
    if lora_dropout is not None:
        lora["loraDropout"] = str(lora_dropout)
    config["lora"] = lora

    # RLHF / GaLore / BAdam
    config["rlhf"] = dict(RLHF_PARAMS)
    config["galore"] = dict(GALORE_PARAMS)
    config["badam"] = dict(BADAM_PARAMS)

    # 额外覆盖（通过 _apply_override 保持类型安全）
    for key, value in overrides.items():
        if value is not None:
            _apply_override(config, key, value)

    return config


def build_parameter_info(finetuning_type="lora", **overrides):
    """构建 parameterInfo 数组（UI 展示用）。value 始终为 string。"""
    import copy
    groups = copy.deepcopy(PARAMETER_INFO_GROUPS)

    for key, value in overrides.items():
        if value is not None:
            for group in groups:
                for item in group:
                    if item["key"] == key:
                        item["value"] = str(value)

    return groups
