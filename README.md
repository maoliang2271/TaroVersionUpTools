### 工具介绍
由于Taro1.x官方已不再进行维护，在开发体验上跟3.x版本存在较大的不足，主要体现在以下几点，本工具可以帮忙开发者对已有Taro1.x项目一键升级到Taro3.x版本。
- Taro 1.x版本遵循 React 语法规范实现的 Nerv 框架跟 React 在jsx语法差异，新特性不支持
- 部分小程序官方提供的API不支持
- Taro 全家桶，依赖升级困难
- Taro 自研构建工具，编译慢，黑盒

### 快速开始
```bash
# 按照依赖
npm i
# 修改项目package.json升级到taro相关类库版本
node package.js
# 升级项目中taro相关类库、模块代码中引入、项目文件结构、样式引用、相关内置api
node main.js
```

### Taro1.3.4 vs Taro3.5.12版本具体差异

#### 相关类库、模块
- 相关模块从 Taro 切换到 React，含 ts 类型（useEffect、useState、useMemo、useCallback、useRef、Component、FunctionComponent、FC、PropsWithChildren、SFC、PureComponent、ComponentClass）
- @tarojs/redux 转成 react-redux，dispatch的写法也有所差异，需要同时处理

#### 项目文件结构
- Taro3 （除小程序自定义组件外）不再支持Component config的写法，需要单独作为配置文件存在
- Taro3 （除小程序自定义组件外）不再支持Component options的写法，需要删除

#### 样式
- Taro3 不再支持小程序的原生样式隔离方式，所有样式文件统一被抽离到 app.wxss 中，原来的样式隔离会失效

#### 相关内置api
- Taro3 不再支持 this.$router、this.$scope、useScope 等写法去获取路由、小程序实例等信息
- Taro3 不再支持 组件级别的componentDidShow、componentDidHide事件，需要手动进行处理

#### 构建配置及其他（由于配置的修改相对于是一次性的行为，人工直接进行修改即可）
- Taro3整体的配置文件的字段也有所调整。主要范围在webpack、babel、scss、react等相关
- Taro3 会模拟 全局window 对象，因此原来依靠 typeof window === 'undefined' 来判断是否是web环境会失效
