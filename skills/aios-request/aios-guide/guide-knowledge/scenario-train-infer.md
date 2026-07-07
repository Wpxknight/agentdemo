---
title: "模型训推完整流程"
keywords: 训推流程, 训练流程, 推理流程, 模型训推, 完整流程, 端到端
---

## 平台用户

### 模型训推业务完整示例说明

### 登录

输入用户账号密码，登录系统
![截图](images/img_0011.png)
### 数据准备

#### 2.1数据准备

点击左侧菜单【BMP】，点击【数据管理】，点击【文件管理】，创建文件夹
点击【用户目录】，点击【新建文件夹】按钮创建文件夹
![截图](images/img_0360.png)
![截图](images/img_0349.png)
示例：
数据文件参考路径：文件管理→ 用户目录→ aios-example-source→ examples → data → image → classification
代码文件参考路径：文件管理→ 用户目录→ aios-example-source→ examples → image → classification
#### 2.2数据集准备

点击左侧菜单【BMP】，点击【数据管理】，点击数据集-用户数据集，在左上角选择项目空间，创建数据集
![截图](images/img_0338.png)
点击【创建】按钮，跳转到创建数据集页面
![截图](images/img_0327.png)
上传数据集以后，点击【保存】按钮，数据集保存
![截图](images/img_0316.png)
数据集创建完成后，数据行末点击【标注】，直接创建标注任务
![截图](images/img_0305.png)
![截图](images/img_0294.png)
#### 2.3数据标注

点击左侧菜单【BMP】，点击【数据管理】，进入数据标注页面
![截图](images/img_0283.png)
点击【创建】按钮，创建标注任务，比如创建一个图片分类的标注
![截图](images/img_0272.png)
![截图](images/img_0261.png)
点击【添加标签】按钮，添加数据标注的标签
![截图](images/img_0250.png)
点击保存，标注任务创建完成，
在创建完成的标注任务里面，点击数据行末的【启动】按钮，启动标注任务
![截图](images/img_0239.png)
标注任务启动完成后，点击【数据标注】进入标注面板，进行标注
![截图](images/img_0228.png)
点击需要标注的图片，进行标注
![截图](images/img_0217.png)
任务标注完成后，在标注面板里面点击【导出】按钮，可以将标注好的数据集导出为JSON格式
![截图](images/img_0206.png)
### 算法开发

#### 3.1创建开发任务

点击左侧菜单【BMP】，点击【算法开发】，点击【模板管理】，在左上角选择项目空空间，开始创建算法开发任务
![截图](images/img_0195.png)
选择Jupyter模板，点击【创建】按钮，创建一个Jupyter任务
![截图](images/img_0184.png)
数据的的挂载路径：选择刚刚的aios-example-source/examples目录，挂载路径填写：/home/jovyan/work/，
点击【确定】运行
点击”打开Jupyter”,进入Jupyter后进入终端，在这里用户可以修改代码，或训练模型。
![截图](images/img_0173.png)
进入工作目录：cd ~/work/source/image/classification/pytorch
输入代码：
 bash run_script.sh --source-dataset-dir ~/work/data/image/classification/images --annotated-dataset-dir ~/work/data/image/classification/annotated开始运行
运行结束后，会在pytorch文件夹内生成一个models文件夹，models文件夹包含config/config.properties和model-store/resnet18.mar。
### 模型训练

#### 4.1创建训练任务

点击左侧菜单【BMP】，点击【模型训练】，点击【训练任务】，在左上角选择项目空空间，开始创建训练任务
![截图](images/img_0162.png)
点击【创建】按钮，创建训练任务，我们就以之前的图片分类训练一个图片分类的小模型
![截图](images/img_0151.png)
基本信息配置：
AI训练框架：Pytorch
部署类型：单机
Worker个数：1
Worker镜像类型：自定义镜像
Worker镜像选择：abcsys.cn:40443/public/pytorch/image-classification/resnet18:labelstudio
资源配置：
1C<CPU<12C;
1G<内存<12G
显存>4G
点击【下一步】按钮，进入高级配置
![截图](images/img_0140.png)
高级配置：
数据配置：数据集选择已经创建好的图片分类数据集，挂载路径：l/workspace/images/
启动命令：
bash
/workspace/run_script.sh
--source-dataset-dir
/workspace/images/
--annotated-dataset-dir
/workspace/annotated/
数据目录：aios-example-source/examples/source/image/classification/pytorch
挂载路径：/workspace
Tensorborad输出挂载路径：/workspace/logs/tensorboard/
### 模型导入

点击左侧菜单【BMP】，点击【模型管理】，点击【模型仓库】，在左上角选择项目空空间，导入已经训练好的模型
![截图](images/img_0129.png)
点击【导入】按钮，导入已经训练好的模型
![截图](images/img_0118.png)
参数配置：（示例）
模型名称：图片分类
模型类型：计算机分类-图像分类
保存路径：用户自定义
模型来源：训练任务
选择任务：
模型指标：用户自定义
模型格式：.pt
AI框架：Pytorch
加速卡平台：Nvidia
模型导入完成后，在模型列表界面，点击【在线推理】按钮，创建推理任务
![截图](images/img_0107.png)
### 模型推理

#### 6.1创建推理任务

点击左侧菜单【BMP】，点击【推理中心】，点击【在线推理】，在左上角选择项目空空间，开始创建推理任务
![截图](images/img_0096.png)
点击【创建】按钮，创建在线服务
![截图](images/img_0085.png)
![截图](images/img_0074.png)
基本信息配置：
模型来源：训练任务
选择任务：选择已经训练好的任务
推理框架：Pytorch
模型名称：resnet18
资源配置：
1C<CPU<12C;
1G<内存<12G
显存>4G
推理服务创建完成后，确认推理服务已经在运行中，点击服务名称，点击【预测】按钮，查看预测

