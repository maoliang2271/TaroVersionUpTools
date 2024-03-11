const fs = require('fs');
const utils = require('./util');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse');
const generator = require('@babel/generator');
const { pathToFileURL } = require('url');
const t = require('@babel/types');
const sass = require('sass');
const postcss = require('postcss');
const postcssJs = require('postcss-js');
const path = require('path');
const { unionBy, cloneDeep, difference } = require('lodash');
const prettier = require('prettier');
const scssParser = require('postcss-scss');

// 需要替换的api
const api = [
  'useEffect',
  'useState',
  'useMemo',
  'memo',
  'useCallback',
  'useRef',
  'Component',
  'FunctionComponent',
  'FC',
  'PropsWithChildren',
  'SFC',
  'PureComponent',
  'ComponentClass',
];

const ShadowContainer = 'CustomWrapper';
const needShadowContainer = ['AtIcon', 'AtButton'];

const GLOBAL_CSS_FILES = [
  utils.resolveSrc('app.scss'),
  utils.resolveSrc('styles/common.scss'),
  utils.resolveSrc('styles/font.scss'),
  utils.resolveSrc('styles/var.scss'),
];

const createClassMethodListener = (eventName, pageEventName, bindFn = 'on') =>
  utils.createTemplate(`
    const ${pageEventName}EventId = getCurrentInstance().router.${pageEventName};
    eventCenter.${bindFn}(${pageEventName}EventId, this.${eventName}.bind(this));
  `);

// 编组
const group = (...handlerMaps) => {
  const result = {};
  handlerMaps.map((handlerMap) => {
    Object.keys(handlerMap).map((key) => {
      if (result[key]) {
        let prev = result[key];
        result[key] = [...result[key], handlerMap[key]];
      } else {
        result[key] = [handlerMap[key]];
      }
    });
  });
  Object.keys(result).forEach((key) => {
    const handlers = result[key];
    result[key] = function (...params) {
      handlers.forEach((handler) => handler(...params));
    };
  });
  return result;
};

class UpdaterQueue {
  constructor() {
    this.microTasks = []; // 任务
    this.macroTasks = []; // 宏任务
    this.microTaskIndex = 0;
    this.macroTasksIndex = 0;
    this.endTasks = [];
    this.running = null;
    this.isAllEnd = false;
  }

  addMicroTask(task) {
    if (this.microTasks.find((item) => item.file === task.file)) {
      return;
    }
    this.microTasks.push(task);
    this.run();
  }

  addMacroTask(task) {
    if (this.macroTasks.find((item) => item.file === task.file)) {
      return;
    }
    this.macroTasks.push(task);
    this.run();
  }

  addEndTask(task) {
    this.endTasks.unshift(task);
  }

  async run() {
    if (this.running) {
      return;
    }

    if (
      this.microTasks.length &&
      this.microTaskIndex < this.microTasks.length
    ) {
      this.running = this.microTasks[this.microTaskIndex];
      this.running.onFinish(() => {
        this.running = null;
        this.run();
      });
      this.microTaskIndex++;
      this.running.transform();
      return;
    }

    await Promise.resolve();

    if (
      this.macroTasks.length &&
      this.macroTasksIndex < this.macroTasks.length
    ) {
      this.running = this.macroTasks[this.macroTasksIndex];
      this.running.onFinish(() => {
        this.running = null;
        this.run();
      });
      this.macroTasksIndex++;
      this.running.transform();
      return;
    }

    await Promise.resolve();

    if (this.isAllEnd) {
      return;
    }

    console.log(`[开始执行结束任务]， 任务长度: ${this.endTasks.length}`);
    // 结束任务执行
    if (this.endTasks.length) {
      this.endTasks.forEach((task, index) => {
        console.log(
          `[开始执行结束任务]， 当前任务索引：${index}, 任务长度: ${this.endTasks.length}`,
        );
        task();
      });
    }
    console.log(`[结束执行结束任务]， 任务长度: ${this.endTasks.length}`);
    this.isAllEnd = true;
  }
}

const updaterQueue = new UpdaterQueue();

// 统计数量
updaterQueue.addEndTask(() => {
  const totalFiles = [];
  utils.Logger.updateTSFileNum =
    utils.Logger.totalTSFileNum +
    updaterQueue.macroTasks.length +
    updaterQueue.microTasks.length;

  utils.Logger.updatePages = [
    ...updaterQueue.macroTasks.map((i) => i.file),
  ];

  utils.Logger.updateFiles = [
    ...updaterQueue.microTasks.map((i) => i.file),
  ];

  utils.traverseDir(utils.resolveSrc(), (fileName) => {
    if (fileName.endsWith('.scss')) {
      if (GLOBAL_CSS_FILES.includes(fileName)) {
        utils.Logger.totalSCSSFileNum++;
      } else if (fileName.endsWith('.module.scss')) {
        utils.Logger.updateSCSSFileNum++;
        utils.Logger.totalSCSSFileNum++;
      }
    }

    if (fileName.endsWith('.ts') || fileName.endsWith('.tsx')) {
      totalFiles.push(fileName);
    }
  });
  utils.Logger.totalTSFileNum = totalFiles.length;
  utils.Logger.unChangedFile = difference(totalFiles, [...utils.Logger.updateFiles, ...utils.Logger.updatePages]);
  utils.Logger.unChangedFile = utils.Logger.unChangedFile.filter((i) => {
    return (
      !i.endsWith('.config.ts') &&
      !i.endsWith('app.tsx') &&
      !i.endsWith('.d.ts')
    );
  });

  // 写入日志
  utils.Logger.writeLogger();
});

class TaroUpdater {
  constructor(file, parentTaroUpdater) {
    this.logger = new utils.Logger(file); // 日志
    this.file = file; // 文件绝对路径
    this.parentTaroUpdater = parentTaroUpdater; // parent节点
    this.rootPath = null; // ast根节点Path
    this.ast = null; // ast
    this.isDone = false; // 是否处理完成
    this.traverseTask = {}; // ast traverse 任务
    this.children = []; // 子节点 任务
    this.analyser = new TaroStyleAnalyser(this); // CSS 分析器
    this.onFinishCallbacks = []; // 结束回调任务
  }

  // 添加 ast traverse 任务
  addTraverseTask(task = {}) {
    this.traverseTask = { ...task };
  }

  /**
   * 获取taro import
   * @returns
   */
  getTaroImport() {
    const { body } = this.rootPath.node;
    return body.find((item) => {
      if (item.type !== 'ImportDeclaration') {
        return;
      }
      if (item.source.value !== '@tarojs/taro') {
        return;
      }
      return item;
    });
  }

  /**
   * 获取react import
   * @returns
   */
  getReactImport() {
    const { body } = this.rootPath.node;
    return body.find((item) => {
      if (item.type !== 'ImportDeclaration') {
        return;
      }
      if (item.source?.value !== 'react') {
        return;
      }

      return item;
    });
  }

  /**
   * 注入 react
   */
  injectReact() {
    // 若未导入过 react，则 导入 react
    if (!this.getReactImport()) {
      this.logger.action(`[添加React 默认导入]`);
      this.rootPath.node.body.unshift(
        t.importDeclaration(
          [t.importDefaultSpecifier(t.identifier('React'))],
          t.stringLiteral('react'),
        ),
      );
    } else {
      const match = this.getReactImport();
      if (!match.specifiers.find((t) => t.type === 'ImportDefaultSpecifier')) {
        this.logger.action(`[添加React 默认导入]`);
        match.specifiers.unshift(
          t.importDefaultSpecifier(t.identifier('React')),
        );
      }
    }
  }

  /**
   * 注入Taro
   */
  injectTaroComponents(propertyName) {
    let node = this.rootPath.node.body.find((item) => {
      if (item.type !== 'ImportDeclaration') {
        return;
      }
      if (item.source.value !== '@tarojs/components') {
        return;
      }
      return item;
    });
    const specifier = t.importSpecifier(
      t.identifier(propertyName),
      t.identifier(propertyName),
    );
    if (!node) {
      this.logger.action(`[添加Taro Components 导入]`, propertyName);
      this.rootPath.node.body.unshift(
        t.importDeclaration([specifier], t.stringLiteral('@tarojs/components')),
      );
    } else {
      // 已导入
      if (
        propertyName &&
        node.specifiers.find((item) => item.local.name === propertyName)
      ) {
        return;
      }
      this.logger.action(`[添加Taro Components 导入]`, propertyName);
      node.specifiers.push(specifier);
    }
  }

  /**
   * 注入Taro
   */
  injectTaro(propertyName) {
    let node = this.getTaroImport();
    const specifier = propertyName
      ? t.importSpecifier(
          t.identifier(propertyName),
          t.identifier(propertyName),
        )
      : t.importDefaultSpecifier('Taro');
    if (!node) {
      this.logger.action(`[添加Taro 导入]`, propertyName);
      this.rootPath.node.body.unshift(
        t.importDeclaration([specifier], t.stringLiteral('@tarojs/taro')),
      );
    } else {
      // 已导入
      if (
        propertyName &&
        node.specifiers.find((item) => item.local.name === propertyName)
      ) {
        return;
      }
      // 已导入
      if (
        !propertyName &&
        node.specifiers.find((item) => item.local.name === 'Taro')
      ) {
        return;
      }
      this.logger.action(`[添加Taro 导入]`, propertyName);
      propertyName
        ? node.specifiers.push(specifier)
        : node.specifiers.unshift(specifier);
    }
  }

  transform() {
    if (this.file.endsWith('.tsx') || this.file.endsWith('.ts')) {
      console.log('[开始处理文件]：', this.file);
      this.logger.log('[开始处理文件] ', this.file);
      const content = fs.readFileSync(this.file, { encoding: 'utf-8' });
      this.ast = require('@babel/parser').parse(content, {
        sourceType: 'module',
        plugins: [
          'typescript',
          'jsx',
          [('decorators', { decoratorsBeforeExport: true })],
          'decorators-legacy',
          'classProperties',
          'classPrivateProperties',
        ],
      });
      const routerHandler = utils.createRouterHandler(this);
      const traverseTask = group(
        this.traverseTask,
        this.handlerImport(),
        this.handleStyle(),
        this.handleShadowContainer(),
        this.languageTask(),
        routerHandler,
      );
      traverse.default(this.ast, {
        enter: (path) => {
          // root 节点
          if (path.isProgram()) {
            this.rootPath = path;
          }
        },
        ...traverseTask,
      });
      traverse.default(this.ast, {
        ImportDeclaration: (ImportDeclarationPath) => {
          if (
            ImportDeclarationPath.node?.source?.value.endsWith('.scss') &&
            !ImportDeclarationPath.node.specifiers.length
          ) {
            if (ImportDeclarationPath.node?.source?.value === './app.scss') {
              return;
            }
            ImportDeclarationPath.remove();
          }
        },
        exit: (path) => {
          if (path.isProgram()) {
            this.isDone = true;
            this.finish();
          }
        },
      });
    }
  }

  finish() {
    const output = generator.default(this.ast, {
      retainLines: true,
      sourceMaps: false,
      decoratorsBeforeExport: true,
    });

    // 添加 prettier 格式化
    const code = prettier.format(output.code, {
      singleQuote: true,
      tabWidth: 2,
      trailingComma: 'all',
      parser: 'typescript',
    });
    fs.writeFileSync(this.file, code);

    console.log('[结束处理文件]：', this.file);
    this.logger.log('[结束处理文件] ', this.file);
    if (this.onFinishCallbacks.length) {
      this.onFinishCallbacks.forEach((callback) => callback());
    }

    if (this.children.length) {
      this.children.forEach((file) => {
        updaterQueue.addMicroTask(file);
      });
    }
  }

  languageTask() {
    return {
      LogicalExpression: (LogicalExpressionPath) => {
        if (
          LogicalExpressionPath.node.right.type === 'JSXElement' &&
          LogicalExpressionPath.node.operator === '&&'
        ) {
          // xxxx.length && <View><View> => !!xxxx.length && <View><View>
          this.logger.action(
            '[双反取正]',
            generator.default(LogicalExpressionPath.node).code,
          );
          LogicalExpressionPath.node.left = t.unaryExpression(
            '!',
            t.unaryExpression('!', LogicalExpressionPath.node.left, true),
            true,
          );
        }
      },
      ClassMethod: (ClassMethodPath) => {
        // 页面级别，直接返回
        if (!this.parentTaroUpdater) {
          return;
        }
        // 命中 componentDidShow
        const componentDidShow = {
          name: 'componentDidShow',
          pageEventName: 'onShow',
        };
        const componentDidHide = {
          name: 'componentDidHide',
          pageEventName: 'onHide',
        };
        [componentDidShow, componentDidHide].forEach((event) => {
          const eventName = event.name;
          const pageEventName = event.pageEventName;

          if (ClassMethodPath.node.key.name === eventName) {
            const { parentPath } = ClassMethodPath;
            const willMount = {
              name: 'componentWillMount',
              bindFn: 'on',
            };
            const willUnmount = {
              name: 'componentWillUnmount',
              bindFn: 'off',
            };
            [willMount, willUnmount].forEach((options) => {
              const wNode = parentPath.node.body.find(
                (item) =>
                  item.type === 'ClassMethod' && item.key.name === options.name,
              );
              const injectNode = createClassMethodListener(
                eventName,
                pageEventName,
                options.bindFn,
              );
              this.injectTaro('getCurrentInstance');
              this.injectTaro('eventCenter');
              this.logger.action('[子组件 onShow/onHide 代码注入] ');
              if (wNode) {
                wNode.body.body.push(...injectNode);
              } else {
                ClassMethodPath.insertBefore(
                  t.classMethod(
                    'method',
                    t.identifier(options.name),
                    [],
                    t.blockStatement(injectNode),
                  ),
                );
              }
            });
          }
        });
      },
      ExpressionStatement: (ExpressionStatementPath) => {
        if (!this.file.endsWith('.tsx')) {
          return;
        }
        const MemberExpressionPathNode =
          ExpressionStatementPath.node.expression.left;
        const valueNode = ExpressionStatementPath.node.expression.right;
        if (
          MemberExpressionPathNode?.property?.name === 'config' &&
          ExpressionStatementPath.parent.type === 'Program'
        ) {
          const config = t.exportDefaultDeclaration(valueNode);
          const result = generator.default(config, {
            retainLines: false,
            sourceMaps: false,
            decoratorsBeforeExport: true,
          });
          this.logger.action('[将 config 迁移至 *.config.ts]');
          const configFileName = this.file.replace('.tsx', '.config.ts');
          fs.writeFileSync(configFileName, result.code);
          ExpressionStatementPath.remove();
          return;
        }

        // 移除options
        if (
          MemberExpressionPathNode?.property?.name === 'options' &&
          ExpressionStatementPath.parent.type === 'Program'
        ) {
          this.logger.action('[删除 options]');
          ExpressionStatementPath.remove();
          return;
        }
      },
    };
  }

  handlerImport() {
    return {
      ImportDeclaration: (ImportDeclarationPath) => {
        // 子节点
        if (ImportDeclarationPath.node.source.value.startsWith('@/')) {
          const sourceFileName =
            ImportDeclarationPath.node.source.value.replace(
              '@',
              utils.resolveSrc(),
            );
          let realSourceFileName = '';
          if (sourceFileName.match(/\.(tsx|ts)$/g)) {
            realSourceFileName = sourceFileName;
          } else if (!sourceFileName.match(/\.[a-z]+$/gi)) {
            if (fs.existsSync(sourceFileName + '.tsx')) {
              realSourceFileName = sourceFileName + '.tsx';
            } else if (fs.existsSync(sourceFileName + '/index.tsx')) {
              realSourceFileName = sourceFileName.endsWith('/')
                ? sourceFileName + 'index.tsx'
                : sourceFileName + '/index.tsx';
            } else if (fs.existsSync(sourceFileName + '.ts')) {
              realSourceFileName = sourceFileName + '.ts';
            } else if (fs.existsSync(sourceFileName + '/index.ts')) {
              realSourceFileName = sourceFileName.endsWith('/')
                ? sourceFileName + 'index.ts'
                : sourceFileName + '/index.ts';
            }
            if (realSourceFileName) {
              this.logger.log('[关联依赖] ', realSourceFileName);
              const child = new TaroUpdater(realSourceFileName, this);
              this.children.push(child);
            }
          }
        }

        if (ImportDeclarationPath.node.source.value.startsWith('.')) {
          const parentPath = this.file.replace(/[a-zA-Z0-9]*\.(tsx|ts)$/gi, '');
          const sourceFileName = path.resolve(
            parentPath,
            ImportDeclarationPath.node.source.value,
          );
          let realSourceFileName = '';
          if (sourceFileName.match(/\.(tsx|ts)$/g)) {
            realSourceFileName = sourceFileName;
          } else if (!sourceFileName.match(/\.[a-z]+$/gi)) {
            if (fs.existsSync(sourceFileName + '.tsx')) {
              realSourceFileName = sourceFileName + '.tsx';
            } else if (fs.existsSync(sourceFileName + '/index.tsx')) {
              realSourceFileName = sourceFileName + '/index.tsx';
              realSourceFileName = sourceFileName.endsWith('/')
                ? sourceFileName + 'index.tsx'
                : sourceFileName + '/index.tsx';
            } else if (fs.existsSync(sourceFileName + '.ts')) {
              realSourceFileName = sourceFileName + '.ts';
            } else if (fs.existsSync(sourceFileName + '/index.ts')) {
              realSourceFileName = sourceFileName.endsWith('/')
                ? sourceFileName + 'index.ts'
                : sourceFileName + '/index.ts';
            }

            if (realSourceFileName) {
              this.logger.log('[关联依赖] ', realSourceFileName);
              const child = new TaroUpdater(realSourceFileName, this);
              this.children.push(child);
            }
          }
        }

        if (ImportDeclarationPath.node.source.value === '@tarojs/async-await') {
          this.logger.action('[删除依赖] ', '@tarojs/async-await');
          ImportDeclarationPath.remove();
          return;
        }

        if (ImportDeclarationPath.node.source.value === '@tarojs/taro') {
          ImportDeclarationPath.traverse({
            // 将 导入 从 taro 转移到 react
            ImportSpecifier: (ImportSpecifierPath) => {
              if (api.includes(ImportSpecifierPath.node.imported.name)) {
                this.logger.action(
                  '[转移依赖 taro >>> react] ',
                  ImportSpecifierPath.node.imported.name,
                );

                const reactImport = this.getReactImport();
                if (reactImport) {
                  reactImport.specifiers.push(
                    t.importSpecifier(
                      t.identifier(ImportSpecifierPath.node.imported.name),
                      t.identifier(ImportSpecifierPath.node.imported.name),
                    ),
                  );
                } else {
                  this.rootPath.node.body.unshift(
                    t.importDeclaration(
                      [ImportSpecifierPath.node],
                      t.stringLiteral('react'),
                    ),
                  );
                }
                ImportSpecifierPath.remove();
                return;
              }

              if (
                ['useScope', 'Config'].includes(
                  ImportSpecifierPath.node.imported.name,
                )
              ) {
                ImportSpecifierPath.remove();
              }
            },
          });

          // 若已无导出，则删除整条
          if (!ImportDeclarationPath.node.specifiers.length) {
            ImportDeclarationPath.remove();
          }
          return;
        }

        // 将 @tarojs/redux 转成 react-redux
        if (ImportDeclarationPath.node.source.value === '@tarojs/redux') {
          this.logger.action(
            '[转移依赖 taro >>> react] ',
            '将 @tarojs/redux 转成 react-redux',
          );
          ImportDeclarationPath.node.source = t.stringLiteral('react-redux');
        }

        // 如果该文件存在scss导入 添加分析器
        if (
          ImportDeclarationPath.node.source.value.endsWith('.scss') &&
          !ImportDeclarationPath.node.source.value.includes('.module.')
        ) {
          this.logger.log(
            '[添加样式分析器] ',
            ImportDeclarationPath.node.source.value,
          );
          this.analyser.addStyleImport(ImportDeclarationPath);
        }
      },

      // 将 Taro.useState 转成 React.useState
      MemberExpression: (MemberExpressionPath) => {
        if (
          api.includes(MemberExpressionPath.node.property?.name) &&
          MemberExpressionPath.node.object.name === 'Taro'
        )  {
          this.logger.action(
            '[转移属性] ',
            `Taro.${MemberExpressionPath.node.property.name} >>> React.${MemberExpressionPath.node.property.name}`,
          );
          MemberExpressionPath.node.object.name = 'React';

          // 若未导入过 react，则 导入 react
          this.injectReact();
          return;
        }
      },

      TSQualifiedName: (TSQualifiedNamePath) => {
        if (
          TSQualifiedNamePath.node.left.name === 'Taro' &&
          api.includes(TSQualifiedNamePath.node.right.name)
        ) {
          this.logger.action(
            '[转移类型] ',
            `Taro.${TSQualifiedNamePath.node.right.name} >>> React.${TSQualifiedNamePath.node.right.name}`,
          );
          this.injectReact();
          TSQualifiedNamePath.node.left.name = 'React';
          TSQualifiedNamePath.node.left.loc.identifierName = 'React';
        }
      },

      ClassDeclaration: (ClassDeclarationPath) => {
        const methods = [];
        ClassDeclarationPath.traverse({
          ClassMethod(ClassMethodPath) {
            // 缓存组件函数， 排除get / set
            if (ClassMethodPath.node.kind === 'method') {
              methods.push(ClassMethodPath.node.key.name);
            }

          },
          ClassProperty: (ClassPropertyPath) => {
            // 删除 options
            if (
              ClassPropertyPath.node.static &&
              ClassPropertyPath.node.key.name === 'options'
            ) {
              this.logger.action('删除 options');
              ClassPropertyPath.remove();
              return;
            }
            if (ClassPropertyPath.node.key.name === 'config') {
              const config = t.exportDefaultDeclaration(
                ClassPropertyPath.node.value,
              );
              const result = generator.default(config, {
                retainLines: false,
                sourceMaps: false,
                decoratorsBeforeExport: true,
              });
              this.logger.action('将 config 迁移至 *.config.ts');
              const configFileName = this.file.replace('.tsx', '.config.ts');
              fs.writeFileSync(configFileName, result.code);
              ClassPropertyPath.remove();
            }
          },
          JSXAttribute: (JSXAttributePath) => {
            if (
              JSXAttributePath.node.value?.type === 'JSXExpressionContainer'
            ) {
              if (
                JSXAttributePath.node.value.expression.type ===
                'MemberExpression'
              ) {
                if (
                  JSXAttributePath.node.value.expression.object.type ===
                  'ThisExpression'
                ) {
                  if (
                    methods.includes(
                      JSXAttributePath.node.value.expression.property.name,
                    )
                  ) {
                    this.logger.action(
                      '[类函数绑定this]',
                      generator.default(JSXAttributePath.node).code,
                    );
                    JSXAttributePath.node.value.expression = t.callExpression(
                      t.memberExpression(
                        JSXAttributePath.node.value.expression,
                        t.identifier('bind'),
                      ),
                      [t.thisExpression()],
                    );
                  }
                }
              }
            }
          },
        });
      },
    };
  }

  /**
   * 将字符串模版分词，保证每段为完整名称
   * @param {*} templateLiteralNode
   * @returns
   */
  templateLiteral2Array(templateLiteralNode) {
    const { code } = generator.default(templateLiteralNode.expression);

    if (code.includes('Style')) {
      return [];
    }
    const str = code.slice(1, -1);
    const result = [];

    let temp = {
      value: '',
      weight: null,
    };

    for (let i = 0; i < str.length; i++) {
      const current = str[i];
      if (temp.weight === 0 && current === ' ') {
        result.push(temp.value);
        temp.value = '';
        temp.weight = null;
      } else if (temp.weight === null) {
        if (current !== ' ') {
          temp.value += current;

          if (current === '$') {
            temp.weight = 0;
          }
        } else {
          result.push(temp.value);
          temp.value = '';
        }

        if (i === str.length - 1) {
          result.push(temp.value);
          temp.value = '';
          temp.weight = null;
        }
      } else {
        if (current === '{') {
          temp.value += current;
          temp.weight += 1;
        } else if (current === '}') {
          temp.value += current;
          temp.weight -= 1;
        } else {
          temp.value += current;
        }

        if (i === str.length - 1) {
          result.push(temp.value);
          temp.value = '';
          temp.weight = null;
        }
      }
    }
    const record = result.map((i) => {
      if (i.includes('$')) {
        return utils.createTemplate('`' + i + '`').expression;
      }
      return t.stringLiteral(i);
    });

    return record;
  }

  handleStyle() {
    return {
      JSXAttribute: (JSXAttributePath) => {
        const node = JSXAttributePath.node;
        if (node.name.name === 'className' && node.value) {
          if (node.value.type === 'JSXExpressionContainer') {
            if (node.value.expression.type === 'TemplateLiteral') {
              this.logger.log(
                '[className分析模板字符串] ',
                generator.default(node.value).code,
              );
              this.analyser.transformWithTemplateLiteral(
                this.templateLiteral2Array(node.value),
                JSXAttributePath,
                node,
              );
            } else if (node.value.expression.type === 'MemberExpression') {
              if (node.value.expression.object?.name.endsWith('Style')) {
                return;
              }
              this.logger.log(
                '[className分析变量类型] ',
                generator.default(node.value).code,
              );
            } else if (node.value.expression.type === 'BinaryExpression') {
              if (node.value.expression.operator === '+') {
                this.logger.log(
                  '[className分析计算类型] ',
                  generator.default(node.value).code,
                );
                // className = {'a ' + x ? m : n} 转 className = {`a ${x ? m : n}`}
                let record = [node.value.expression.right];
                let left = node.value.expression.left;
                while (left) {
                  if (left.right) {
                    record.unshift(left.right);
                  }
                  if (!left.left) {
                    record.unshift(left);
                  }
                  left = left.left;
                }
                const str = record.reduce((prev, current, index) => {
                  if (current.type === 'StringLiteral') {
                    return prev + current.value;
                  } else {
                    return prev + '${' + generator.default(current).code + '}';
                  }
                }, ``);
                this.logger.log('[className计算类型转模板字符串] ', str);
                this.analyser.transformWithTemplateLiteral(
                  this.templateLiteral2Array(
                    utils.createTemplate('`' + str + '`'),
                  ),
                  JSXAttributePath,
                  node,
                );
              } else if (node.value.expression.operator === '&&') {
                // a === 1 && "b" => a === 1 ? "b" : ""
                this.analyser.transformWithTemplateLiteral(
                  [
                    t.conditionalExpression(
                      node.value.expression.left,
                      node.value.expression.right,
                      t.stringLiteral(''),
                    ),
                  ],
                  JSXAttributePath,
                  node,
                );
              } else {
                this.logger.warn(
                  '[className 未知计算表达式，需要手动处理]',
                  generator.default(node).code,
                );
              }
            } else if (node.value.expression.type === 'ConditionalExpression') {
              this.analyser.transformWithTemplateLiteral(
                [node.value.expression],
                JSXAttributePath,
                node,
              );
            } else {
              this.logger.warn(
                '[className 未知类型表达式，需要手动处理]',
                generator.default(node.value.expression).code,
                `来源：${generator.default(node).code}`
              );
            }
          }
          if (node.value.type === 'StringLiteral') {
            this.logger.log('[className分析纯字符串类型] ', node.value.value);
            this.analyser.transformWithJSXContainer(
              node.value.value,
              JSXAttributePath,
              node,
            );
          }
        }
      },
    };
  }

  handleShadowContainer() {
    return {
      JSXElement: (JSXElementPath) => {
        const { node } = JSXElementPath;
        const cloneNode = cloneDeep(node);
        if (needShadowContainer.includes(node.openingElement.name.name)) {
          if (
            JSXElementPath.parentPath.node.openingElement?.name.name ===
            ShadowContainer
          ) {
            return;
          }

          JSXElementPath.replaceWith(
            t.jsxElement(
              t.jsxOpeningElement(t.jsxIdentifier(ShadowContainer), []),
              t.jsxClosingElement(t.jsxIdentifier(ShadowContainer)),
              [node],
            ),
          );
          this.injectTaroComponents(ShadowContainer);
        }
      },
    };
  }

  onFinish(callback) {
    this.onFinishCallbacks.push(callback);
  }
}

class TaroStyleAnalyser {
  constructor(updater) {
    this.updater = updater;
    this.parentPath = this.updater.file.replace(/[a-zA-Z0-9]*\.tsx$/gi, '');
    this.importDeclarationPaths = [];
    this.data = {};
    this.styleNames = [];
    this.styleNamesRepeatFlag = 1;

    if (!TaroStyleAnalyser.globalCSS) {
      TaroStyleAnalyser.addGlobalCSS();
    }
  }

  /**
   * 添加style 路径 导入
   * @param {*} importDeclarationPath
   */
  addStyleImport(importDeclarationPath) {
    this.importDeclarationPaths.push(importDeclarationPath);
  }

  /**
   * 生成styleName名称，避免同一份文件styleName重复
   * @param {*} cssRelativeFile
   * @returns
   */
  generateStyleName(cssRelativeFile, logger) {
    let styleName = cssRelativeFile
      .replace(/[\/\.].*?(\w).*?/g, (all, match, index) =>
        index === 0 ? match : match.toUpperCase(),
      )
      .replace('@', '')
      .replace('Scss', 'Style');

    // 检查是否命中名称重复缓存
    if (this.styleNames.includes(styleName)) {
      styleName = styleName + this.styleNamesRepeatFlag;
      this.styleNamesRepeatFlag++;
    }
    logger.log('[styleName生成] ', styleName);
    // 缓存当前文件的styleName
    this.styleNames.push(styleName);
    return styleName;
  }

  /**
   * 根据css import 生成供透传的上下文
   * @param {*} importDeclarationPath
   * @returns
   */
  generateContext(importDeclarationPath) {
    const cssRelativeFile = importDeclarationPath.node.source.value;
    // 名称转换
    let scssFile = path.resolve(this.parentPath, cssRelativeFile);

    // 已生成context，直接返回
    if (scssFile.includes('.module.scss')) {
      return this.data[scssFile.replace('.module.scss', '.scss')];
    }

    // webpack alias 检测
    if (cssRelativeFile.startsWith('@')) {
      scssFile = cssRelativeFile.replace('@', process.cwd() + '/src');
    }

    // 已生成context，直接返回
    if (this.data[scssFile]) {
      return this.data[scssFile];
    }

    // 来自node_modules 的文件，直接返回
    if (cssRelativeFile.startsWith('~')) {
      return;
    }

    const logger = new utils.Logger(scssFile);
    // 生成styleName
    const styleName = this.generateStyleName(cssRelativeFile, logger);
    // 生成context 对象
    const context = {
      isImported: false, // 是否被导入过
      scssFile: scssFile, // 样式文件绝对路径
      scssModuleFileName: scssFile.replace('.scss', '.module.scss'), // 样式文件 css module 绝对路径
      styleName: styleName,
      importDeclarationPath, // 该样式文件的 babel path
      logger,
      css: {}, // 该样式文件的css文件
      matched: [],
    };

    // 缓存起来
    this.data[context.scssFile] = context;
    return context;
  }

  /**
   * 根据context，重命名样式文件
   * @param {*} context
   * @returns
   */
  renameFileName(context) {
    if (context.scssFile.includes('.module.scss')) {
      return;
    }
    let content = '';
    if (fs.existsSync(context.scssFile)) {
      content = fs.readFileSync(context.scssFile, { encoding: 'utf-8' });
    } else if (fs.existsSync(context.scssModuleFileName)) {
      content = fs.readFileSync(context.scssModuleFileName, {
        encoding: 'utf-8',
      });
    }

    // node_modules 中的style，需要转下名称，不然会报错
    if (content.includes(`@import "~`)) {
      content = content.replace(`@import "~`, `@import "`);
    }
    context.logger.action(
      `[修改scss文件名称]`,
      '来源文件：' + this.updater.file,
    );
    fs.writeFileSync(
      context.scssFile.replace('.scss', '.module.scss'),
      content,
    );

    if (fs.existsSync(context.scssFile)) {
      fs.unlinkSync(context.scssFile);
    }
  }

  /**
   * 根据context，重写 scss file
   * @param {*} context
   * @returns
   */
  async rewriteSCSSFile(context) {
    if (this.rewriteTimer) {
      clearTimeout(this.rewriteTimer);
    }
    this.rewriteTimer = setTimeout(() => {
      const content = fs.readFileSync(context.scssModuleFileName, {
        encoding: 'utf-8',
      });
      const ast = scssParser.parse(content);

      const isParentNotGlobal = (node) => {
        if (node.parent) {
          return (
            node.parent.selector !== ':global' && isParentNotGlobal(node.parent)
          );
        }
        return node.selector !== ':global';
      };

      ast.walk((node) => {
        if (node.type === 'rule') {
          if (!node.selector.startsWith('.at-')) {
            return;
          }
          if (!context.matched.includes(node.selector)) {
            if (node.prev()?.selector === ':global') {
              const cloned = node.clone();
              context.logger.action('添加 样式global', node.selector);
              node.prev().append(cloned);
              node.remove();
              return;
            }

            if (node.next()?.selector === ':global') {
              context.logger.action('添加 样式global', node.selector);
              const cloned = node.clone();
              node.next().prepend(cloned);
              node.remove();
              return;
            }

            if (isParentNotGlobal(node)) {
              const rule = postcss.rule({ selector: ':global' });
              context.logger.action('添加 样式global', node.selector);
              const cloned = node.clone();
              rule.nodes = [cloned];
              node.replaceWith(rule);
            }
          }
        }
      });
      let code = '';
      scssParser.stringify(ast, (str) => {
        code += str;
      });
      const result = prettier.format(code, {
        singleQuote: true,
        tabWidth: 2,
        trailingComma: 'all',
        parser: 'scss',
      });
      utils.Logger.updateFileNum++;
      fs.writeFileSync(context.scssModuleFileName, result, {
        encoding: 'utf-8',
      });
    }, 200);
  }

  /**
   * 同步遍历所有css导入
   * @param {*} callback
   */
  traverseCSS(callback) {
    this.importDeclarationPaths.forEach((path) => {
      const context = this.generateContext(path);
      if (context) {
        callback(context);
      }
    });
  }

  /**
   * 通过context获取该css树
   * @param {*} context
   * @returns
   */
  getCSSWithContext(context) {
    if (context.css && Object.keys(context.css).length) {
      return context.css;
    }
    let result = '';
    if (fs.existsSync(context.scssFile)) {
      result = sass.compile(context.scssFile, {
        includePaths: ['node_modules'],
      });
    } else if (fs.existsSync(context.scssModuleFileName)) {
      result = sass.compile(context.scssModuleFileName, {
        includePaths: ['node_modules'],
      });
    }

    context.logger.log(`[编译SCSS 为 CSS树]`);
    context.css = postcssJs.objectify(postcss.parse(result.css.toString()));
    return context.css;
  }

  /**
   * 判断className是否在context中命中
   * @param {*} context
   * @param {*} className
   * @returns
   */
  getCSSMatched(context, className) {
    const css = this.getCSSWithContext(context);
    const isMatched = Object.keys(css).find((key) => {
      const match1 = key.match(new RegExp(`\.${className}[\:\.\s\,]+`, 'g'));
      const match2 = key.match(new RegExp(`\.${className}`, 'g'));
      return !!(match1 || match2);
    });

    if (isMatched) {
      context.matched.push(className);
    }
    return isMatched;
  }

  /**
   * 遍历className名
   * @param {*} name
   * @returns
   */
  check(name) {
    const names = name.split(' ').filter((i) => !!i.trim());
    const templates = [];
    const scssModuleFileNames = [];

    names.forEach((itemName, index) => {
      if (itemName) {
        // 当前文件遍历
        Object.values(this.data).forEach((context) => {
          if (this.getCSSMatched(context, itemName)) {
            templates.push(`${context.styleName}['${itemName}']`);
            scssModuleFileNames.push(context.scssModuleFileName);
          }
        });
      }
    });

    return {
      // 去重
      templates: [...new Set([...templates])],
      scssModuleFileNames: [...new Set([...scssModuleFileNames])],
    };
  }

  /**
   * 遍历className名
   * @param {*} name
   * @returns
   */
  traverse(name, node) {
    const names = name.split(' ').filter((i) => !!i.trim());
    const templates = [];

    // 是否需要表达式，若不需要，则为纯字符串
    let isNeedExpression = false;
    names.forEach((itemName, index) => {
      let isMatched = false;
      let parent = this.updater.parentTaroUpdater;

      // 当前文件遍历
      this.traverseCSS((context) => {
        if (this.getCSSMatched(context, itemName)) {
          this.injectCSSImportWithContext(context);
          this.rewriteSCSSFile(context);
          templates.push(`${context.styleName}['${itemName}']`);
          context.logger.log(
            '[当前文件遍历命中]: ',
            `${context.styleName}['${itemName}']`,
          );
          isMatched = true;
          isNeedExpression = true;
        }
      });

      // 上级节点遍历，层层向上查找
      while (parent) {
        Object.values(parent.analyser.data).forEach((parentContext) => {
          if (this.getCSSMatched(parentContext, itemName)) {
            const localContext = this.injectCSSImportFromParent(parentContext);
            this.rewriteSCSSFile(localContext);
            isNeedExpression = true;
            isMatched = true;
            templates.push(`${localContext.styleName}['${itemName}']`);
            parentContext.logger.log(
              '[上级节点遍历命中] ',
              `${localContext.styleName}['${itemName}']`,
            );
          }
        });
        parent = parent.parentTaroUpdater;
      }

      // 命中全局样式，添加静态
      if (TaroStyleAnalyser.globalCSS) {
        Object.keys(TaroStyleAnalyser.globalCSS).find((key) => {
          if (key.includes(itemName) && !templates.includes(itemName)) {
            templates.push(itemName);
            this.updater.logger.log('[全局样式命中] ', itemName);
            isMatched = true;
          }
        });
      }

      if (!isMatched) {
        // 检测可能出现的文件
        templates.push(`${itemName}`);

        // at-开头，为组件库
        if (!itemName.startsWith('at-')) {
          updaterQueue.addEndTask(() => {
            const match = {};
            [...updaterQueue.macroTasks, ...updaterQueue.microTasks].forEach(
              (updater) => {
                const data = updater.analyser.check(itemName);
                if (data.templates.length) {
                  data.scssModuleFileNames.forEach((scssModuleFileName) => {
                    match[scssModuleFileName] = match[scssModuleFileName] || [];
                    match[scssModuleFileName].push(
                      updater.file.replace(utils.resolveSrc(), ''),
                    );
                  });
                }
              },
            );
            if (Object.keys(match).length) {
              this.updater.logger.group(
                'CURRENT_NOT_MATCH_BUT_GLOBAL_MATCH',
                itemName,
                `来源：${generator.default(node).code}`,
                `css: ` + Object.keys(match).map(i => i.replace(utils.resolveSrc(), '')).join('\n'),
              );
            } else {
              this.updater.logger.group(
                'CURRENT_AND_GLOBAL_NOT_MATCH',
                itemName,
                `来源：${generator.default(node).code}`,
              );
            }
          });
        }
      }
    });

    if (!templates.length) {
      if (name) {
        this.updater.logger.warn(
          '[未命中className，需手动确认] ',
          name,
          `来源：${generator.default(node).code}`,
        );
      }
      templates.push(name);
    }

    return {
      // 去重
      templates: [...new Set([...templates])],
      isNeedExpression,
    };
  }

  /**
   * 组合templates字符串数组为模版字符串ast
   * @param {*} params
   * @returns
   */
  combinationTemplates(params) {
    if (params.isNeedExpression) {
      const newTemplates = params.templates.map((i) =>
        i.includes('[') ? '${' + i + '}' : i,
      );
      return utils.createTemplate(`\`${newTemplates.join(' ')}\``).expression;
    }
    if (params.templates.length > 1) {
      return utils.createTemplate(`\`${params.templates.join(' ')}\``)
        .expression;
    } else {
      return t.stringLiteral(params.templates[0]);
    }
  }

  /**
   * className分析纯字符串类型
   * @param {*} name
   * @param {*} parentPath
   * @returns
   */
  transformWithJSXContainer(name, parentPath, node) {
    if (!name) {
      return;
    }
    const container = (node) => t.jsxExpressionContainer(node);
    const params = this.traverse(name, node);

    // 如果不需要转化成表达式，则直接返回
    if (!params.isNeedExpression) {
      return;
    }

    const expression = this.combinationTemplates(params);

    if (expression) {
      this.updater.logger.action('[修改样式名] ', name);
      parentPath.node.value = container(expression);
    }
  }

  /**
   * 编译模版字符串
   * @param {*} matchList
   * @param {*} parentPath
   * @returns
   */
  transformWithTemplateLiteral(matchList, parentPath, node) {
    if (!matchList.length) {
      return;
    }

    // 存放每一项的模板
    const templates = [];

    matchList.forEach((matchAST) => {
      switch (matchAST.type) {
        /**
         * 子项为纯字符串类型时命中
         */
        case 'StringLiteral':
          if (matchAST.value) {
            const params = this.traverse(matchAST.value, node);
            const value = this.combinationTemplates(params);
            templates.push(generator.default(value).code);
          }
          break;

        /**
         * 模板字符串中的固定字符串 如`${aaa} bb` 中的bb
         */
        case 'TemplateElement':
          // 必须非空字符串
          if (matchAST.value.raw?.trim().length) {
            const params = this.traverse(matchAST.value.raw, node);
            const value = this.combinationTemplates(params);
            templates.push(generator.default(value).code);
          }
          break;
        case 'Identifier':
          this.updater.logger.warn(
            '[className 变量名]未命中',
            generator.default(matchAST).code,
            `来源：${generator.default(node).code}`,
          );
          break;
        case 'MemberExpression':
          // 检测是否style包含，避免重复检测
          if (!/style/gi.test(matchAST.object.name)) {
            this.updater.logger.warn(
              'className为元素属性',
              matchAST.object.name,
              `来源：${generator.default(node).code}`,
            );
          } else {
            templates.push('${' + generator.default(matchAST).code + '}');
          }
          break;
        // 三元表达式，例如：a ? b : c
        case 'ConditionalExpression':
          // 检测 a ? b : c中的b
          if (
            matchAST.consequent.type === 'StringLiteral' &&
            matchAST.consequent.value
          ) {
            const params = this.traverse(matchAST.consequent.value, node);
            matchAST.consequent = this.combinationTemplates(params);
          } else if (matchAST.consequent.value) {
            this.updater.logger.warn(
              '[className条件表达式] consequent未命中',
              generator.default(matchAST).code,
              `来源：${generator.default(node).code}`,
            );
          }
          // 检测 a ? b : c中的c
          if (
            matchAST.alternate.type === 'StringLiteral' &&
            matchAST.alternate.value
          ) {
            const params = this.traverse(matchAST.alternate.value, node);
            matchAST.alternate = this.combinationTemplates(params);
          } else if (matchAST.alternate.value) {
            this.updater.logger.warn(
              '[className条件表达式] alternate未命中',
              generator.default(matchAST).code,
              `来源：${generator.default(node).code}`,
            );
          }
          templates.push('${' + generator.default(matchAST).code + '}');
          break;
        // 检测 a && b
        case 'LogicalExpression':
          // 必须是字符串的场景才检测，其他记录
          if (matchAST.right.type === 'StringLiteral') {
            const params = this.traverse(matchAST.right.value, node);
            matchAST.right = this.combinationTemplates(params);
          } else {
            this.updater.logger.warn(
              '[className逻辑表达式,但未命中]',
              generator.default(matchAST).code,
              `来源：${generator.default(node).code}`,
            );
          }
          templates.push('${' + generator.default(matchAST).code + '}');
          break;
        case 'TemplateLiteral':
          if (
            matchAST.quasis.length === 2 &&
            matchAST.expressions.length === 1
          ) {
            if (
              ['', '\n'].includes(matchAST.quasis[0].value.raw) &&
              ['', '\n'].includes(matchAST.quasis[1].value.raw)
            ) {
              const realAST = matchAST.expressions[0];
              if (realAST.type === 'LogicalExpression') {
                // 必须是字符串的场景才检测，其他记录
                if (realAST.right.type === 'StringLiteral') {
                  const params = this.traverse(realAST.right.value, node);
                  realAST.right = this.combinationTemplates(params);
                } else {
                  this.updater.logger.warn(
                    '[className逻辑表达式,但未命中]',
                    generator.default(realAST).code,
                    `来源：${generator.default(node).code}`,
                  );
                }
                templates.push('${' + generator.default(realAST).code + '}');
                break;
              }

              if (realAST.type === 'ConditionalExpression') {
                // 检测 a ? b : c中的b
                if (
                  realAST.consequent.type === 'StringLiteral' &&
                  realAST.consequent.value
                ) {
                  const params = this.traverse(realAST.consequent.value, node);
                  realAST.consequent = this.combinationTemplates(params);
                } else if (realAST.consequent.value) {
                  this.updater.logger.warn(
                    '[className条件表达式] consequent未命中',
                    generator.default(realAST).code,
                    `来源：${generator.default(node).code}`,
                  );
                }
                // 检测 a ? b : c中的c
                if (
                  realAST.alternate.type === 'StringLiteral' &&
                  realAST.alternate.value
                ) {
                  const params = this.traverse(realAST.alternate.value, node);
                  realAST.alternate = this.combinationTemplates(params);
                } else if (realAST.alternate.value) {
                  this.updater.logger.warn(
                    '[className条件表达式] alternate未命中',
                    generator.default(realAST).code,
                    `来源：${generator.default(node).code}`,
                  );
                }
                templates.push('${' + generator.default(realAST).code + '}');
                break;
              }
            }
          }
        default:
          this.updater.logger.warn(
            '[className未命中]',
            generator.default(matchAST).code,
            `来源：${generator.default(node).code}`,
          );
          templates.push(generator.default(matchAST).code);
      }
    });

    // babel/template 编译会加上; 手动去除
    const prev = (i) => {
      let newStr = i;
      if (i.endsWith(';')) newStr = newStr.slice(0, -1);
      if (i.endsWith(';}')) newStr = newStr.replace(/(\;\})$/gi, '}');
      if (i.startsWith('"') && i.endsWith('"')) newStr = newStr.slice(1, -1);
      return newStr;
    };

    // 若以模版字符串（${?}）需要判断templates长度是否等于1，等于1需要手动去除
    const removeWrap = (i) => {
      return i.replace(/^(\$\{)/gi, '').replace(/(\})$/gi, '');
    };

    // 以模版字符串包裹，需要判断templates长度是否等于1，大于1需要手动去除
    const removeWrap2 = (i) => {
      if (i.startsWith('`') && i.endsWith('`')) return i.slice(1, -1);
      return i;
    };

    if (templates.length > 1) {
      const input = `\`${templates
        .map((i) => removeWrap2(prev(i)))
        .join(' ')}\``;

      this.updater.logger.action('[修改样式名] ', { templates, input });
      parentPath.node.value = t.jsxExpressionContainer(
        utils.createTemplate(input).expression,
      );
    } else if (templates.length === 1) {
      const input = removeWrap(prev(templates[0]));

      this.updater.logger.action('[修改样式名] ', { templates, input });
      parentPath.node.value = t.jsxExpressionContainer(
        utils.createTemplate(input).expression,
      );
    }
  }

  /**
   * 根据context，添加css import
   * @param {*} context
   * @returns
   */
  injectCSSImportWithContext(context) {
    if (this.data[context.scssFile].isImported) {
      return;
    }
    context.isImported = true;
    this.renameFileName(context);
    context.importDeclarationPath.node.specifiers = [
      t.importDefaultSpecifier(t.identifier(context.styleName)),
    ];
    // 修改名称
    context.logger.action(
      `[修改css module]引入]`,
      `目标：${this.updater.file}`,
    );
    context.importDeclarationPath.node.source.value =
      context.importDeclarationPath.node.source.value.replace(
        '.scss',
        '.module.scss',
      );
  }

  /**
   * 根据context，添加parent css import
   * @param {*} context
   * @returns
   */
  injectCSSImportFromParent(context) {
    if (this.data[context.scssFile]) {
      return this.data[context.scssFile];
    }
    this.data[context.scssFile] = { ...context };
    let relative = path.relative(
      path.parse(this.updater.file).dir,
      context.scssFile,
    );

    if (!relative.startsWith('.')) {
      relative = './' + relative;
    }

    if (!context.isImported) {
      this.renameFileName(context);
      context.isImported = true;
    }

    const styleName = this.generateStyleName(relative, context.logger);
    this.data[context.scssFile].styleName = styleName;
    const relativeModuleName = relative.includes('module.scss')
      ? t.stringLiteral(relative)
      : t.stringLiteral(relative.replace('.scss', '.module.scss'));

    let isInjected = false;
    this.updater.rootPath.node.body.forEach((item, index) => {
      const nextItem = this.updater.rootPath.node.body[index + 1];
      if (
        !isInjected &&
        item.type === 'ImportDeclaration' &&
        nextItem?.type !== 'ImportDeclaration'
      ) {
        this.updater.rootPath.node.body.splice(
          index + 1,
          0,
          t.importDeclaration(
            [t.importDefaultSpecifier(t.identifier(styleName))],
            relativeModuleName,
          ),
        );
        isInjected = true;
      }
    });

    context.logger.action(
      `[注入上级[css module]引入] `,
      `目标：${this.updater.file}`,
    );
    return this.data[context.scssFile];
  }
}

TaroStyleAnalyser.addGlobalCSS = () => {
  TaroStyleAnalyser.globalCSS = {};
  GLOBAL_CSS_FILES.forEach((file) => {
    const result = sass.compile(file, {
      importers: [
        {
          findFileUrl(url) {
            if (!url.startsWith('~')) {
              // 没用到此逻辑，可能有错误
              return new URL(url, pathToFileURL('src/style'));
            }
            return new URL(
              './node_modules/' + url.substring(1),
              pathToFileURL(utils.resolve('node_modules')),
            );
          },
        },
      ],
    });
    TaroStyleAnalyser.globalCSS = {
      ...TaroStyleAnalyser.globalCSS,
      ...postcssJs.objectify(postcss.parse(result.css.toString())),
    };
  });
};

module.exports.TaroUpdater = TaroUpdater;
module.exports.updaterQueue = updaterQueue;
module.exports.ShadowContainer = ShadowContainer;
